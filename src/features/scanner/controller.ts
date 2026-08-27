import {
  searchCards,
  getCardVariants,
  getCardsByIds,
  type CatalogVariant,
} from '../../data/catalog'
import { addCardAcquisition } from '../../data/collection'
import {
  matchScannerObservation,
  type ScannerObservation,
  type ScannerCandidateRecord,
  type ScannerConfidenceTier,
  type VisualEvidenceByCard,
} from '../../domain/scanner'
import {
  retrieveScannerCandidates,
  ScannerCatalogUnavailableError,
} from '../../data/scanner/scanner-catalog'
import { runOcrAnalysis, releaseOcrCanvases } from './analyze'
import type { PixelRect } from './guide-geometry'
import { ScannerOcrEngine } from './ocr-engine'
import { scannerCostBasisState, scannerSessionStore, type ScannerOrigin } from './session-store'
import { VisualRecognitionClient, type VisualAnalysisResult } from './visual/visual-client'

/** Bounded raw visual shortlist handed to the domain matcher (prompt §16/§31): retrieval may
 *  examine this many raw candidates internally, but the UI never sees more than
 *  SCANNER_UI_CANDIDATE_LIMIT of them after reranking. */
const VISUAL_SHORTLIST_SIZE = 30
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCommitItem,
  ScannerCommitOutcome,
  ScannerCommitResult,
  ScannerConfidence,
  ScannerDiagnostics,
  ScannerSearchQuery,
  ScannerUiController,
  ScannerVariantChoice,
} from './contract'

/**
 * The REAL M15 controller (P68): binds P66's camera UI to P65's on-device Tesseract pipeline,
 * P67's deterministic matcher and the EXISTING canonical acquisition path. This is the one file
 * the integration replaces; nothing else in the feature needed reshaping beyond typed contract
 * extensions.
 *
 * Boundaries held:
 *   - Image bytes NEVER leave this device: OCR runs locally; only textual catalog queries and
 *     ordinary thumbnail GETs cross the network (prompt §33/§34).
 *   - Confidence is P67's deterministic tier mapped onto P66's bands — no re-scoring here.
 *   - Nothing is written until commitBatch; every write is an add_card_acquisition call with
 *     session defaults applied (origin → basis via the SHARED helper); no scanner-only writer
 *     exists anywhere.
 *   - Each batch item carries a stable client-request-key (D-096): an interrupted transport
 *     can be safely retried without duplicating inventory — the server replays the original
 *     result for an already-committed key.
 */

/** The short useful shortlist shown in the UI (prompt §20): retrieval may examine bounded raw
 *  rows internally, but the user sees at most these top-ranked candidates. */
export const SCANNER_UI_CANDIDATE_LIMIT = 5

/** Deterministic tier → coarse UI band. Pure mapping; no second scoring pass exists. */
function tierToConfidence(tier: ScannerConfidenceTier): ScannerConfidence {
  switch (tier) {
    case 'high':
      return 'HIGH'
    case 'medium':
      return 'MEDIUM'
    case 'low':
      return 'LOW'
    case 'none':
      return 'NO_MATCH'
  }
}

function languageLabel(language: ScannerCandidateRecord['language']): string {
  return language === 'ja' ? 'Japanese' : 'English'
}

function toUiCandidate(record: ScannerCandidateRecord): ScannerCandidate {
  return {
    candidateId: record.cardId,
    name: record.name,
    setName: record.setName,
    collectorNumber: record.localId,
    imageBaseUrl: record.imageBaseUrl,
    finishLabel: null,
    languageLabel: languageLabel(record.language),
  }
}

/**
 * Printing-choice label from ACTUAL variant attributes (prompt §22) — finish/stamp/subtype/size
 * as stored, never inferred from pixels. Exported for tests.
 */
export function variantChoiceLabel(variant: CatalogVariant): string {
  const parts: string[] = []
  const FINISH_LABELS = {
    normal: 'Normal',
    holo: 'Holo',
    reverse: 'Reverse holo',
    other: 'Other',
  } as const
  parts.push(FINISH_LABELS[variant.finish])
  if (variant.subtype.trim() !== '') parts.push(variant.subtype.trim())
  if (variant.stamp.trim() !== '') parts.push(`${variant.stamp.trim()} stamp`)
  if (variant.size === 'oversized') parts.push('Oversized')
  return parts.join(' · ')
}

/**
 * Classifies ONE failed acquisition attempt (prompt §30, D-096). A PostgREST answer — however
 * negative — is DEFINITE (the server saw and refused the row; nothing was added). A transport-
 * level break before any answer (fetch TypeError, abort, timeout) is AMBIGUOUS: the RPC may
 * have committed before the connection died. With D-096's per-item idempotency key, a retry of
 * an ambiguous item deterministically replays the original result if it committed — so the
 * message can now safely say the retry is safe. The classifier still keys on evidence of a
 * server response (code/details/hint), never on message text.
 */
export function classifyAcquisitionFailure(index: number, error: unknown): ScannerCommitOutcome {
  const candidate = error as { code?: unknown; details?: unknown; hint?: unknown }
  const hasServerAnswer =
    typeof candidate.code === 'string' ||
    typeof candidate.details === 'string' ||
    typeof candidate.hint === 'string'
  if (hasServerAnswer) {
    return {
      index,
      status: 'failed',
      message: 'The server did not accept this card. You can edit it or remove it.',
    }
  }
  return {
    index,
    status: 'needs_verification',
    message: 'Connection was interrupted. You can retry safely — the card will not be added twice.',
  }
}

export interface RealScannerControllerOptions {
  /** Authenticated owner id for session-default scoping (§27). /scan sits behind RequireSession,
   *  so this is non-null in real use; null simply disables session persistence. */
  userId: string | null
}

function toCandidateRecordFromCatalog(card: {
  id: string
  name: string
  localId: string
  rarity: string | null
  category: string | null
  illustrator: string | null
  imageBaseUrl: string | null
  language: ScannerCandidateRecord['language']
  setId: string
  setName: string
}): ScannerCandidateRecord {
  return {
    cardId: card.id,
    name: card.name,
    localId: card.localId,
    rarity: card.rarity,
    category: card.category,
    illustrator: card.illustrator,
    imageBaseUrl: card.imageBaseUrl,
    language: card.language,
    setId: card.setId,
    setName: card.setName,
    variantCount: 1,
  }
}

export function createRealScannerController(
  options: RealScannerControllerOptions,
): ScannerUiController {
  const engine = new ScannerOcrEngine()
  // Lazy, session-lifetime visual client (prompt §27): created on first use, never per card.
  const visualClient = new VisualRecognitionClient()

  /** Never throws and never rejects: a browser/environment without `createImageBitmap` (or any
   *  other visual-channel failure) degrades to "no visual evidence" exactly like a missing model
   *  or index would (prompt §36) — OCR-only results, not a broken scan.
   *
   *  CROPPED TO THE CARD RECT (P77 prompt §16/§17): a camera capture's `blob` is the WHOLE frame
   *  the shutter grabbed — OCR already crops to `capture.cardRect` before it reads anything
   *  (analyze.ts's `runOcrAnalysis`), but until this fix the visual channel embedded the entire
   *  uncropped photo. The reference index is built from tight, card-only TCGdex images; embedding
   *  an uncropped frame (background, table, hands, whatever surrounds the guide) is a real
   *  preprocessing-parity mismatch from the reference distribution — a plausible independent
   *  contributor to a real-device miss even against a complete, correctly hosted index. Cropping
   *  via `createImageBitmap`'s own (sx, sy, sw, sh) overload needs no extra canvas draw. */
  // Diagnostics for the MOST RECENT scan only (P77 prompt §13/§40) — never fed back into
  // matching, never persisted, overwritten by the next analyzeCapture call.
  let lastDiagnostics: ScannerDiagnostics | null = null

  /** Returns its own error message rather than mutating shared state (P78): a closure-captured
   *  `let` reassigned inside an awaited call is invisible to TypeScript's control-flow narrowing
   *  at the read site (confirmed — `@typescript-eslint/no-unnecessary-condition` flags the read as
   *  provably null even though it demonstrably isn't at runtime), so the safer AND more correct
   *  shape is to hand the error back through the return value instead. */
  async function analyzeVisualSafely(capture: {
    blob: Blob
    cardRect: PixelRect
  }): Promise<{ result: VisualAnalysisResult | null; errorMessage: string | null }> {
    if (typeof createImageBitmap !== 'function') {
      return { result: null, errorMessage: 'createImageBitmap is unavailable in this browser.' }
    }
    try {
      const { blob, cardRect } = capture
      const bitmap = await createImageBitmap(
        blob,
        cardRect.left,
        cardRect.top,
        cardRect.width,
        cardRect.height,
      )
      const result = await visualClient.analyze(bitmap, VISUAL_SHORTLIST_SIZE)
      return { result, errorMessage: null }
    } catch (error) {
      return { result: null, errorMessage: (error as Error).message }
    }
  }

  async function analyzeCapture(capture: Parameters<ScannerUiController['analyzeCapture']>[0]) {
    // On-device OCR and on-device visual embedding run in parallel — both stay entirely local
    // (prompt §6/§41): no image bytes cross the network either way, only the RESULTING textual
    // catalog queries (OCR) and card-id lookups (visual shortlist enrichment) do.
    const defaults = scannerSessionStore.load(options.userId)
    const languageHint = defaults?.language ?? 'en'

    const [ocrResult, { result: visualResult, errorMessage: visualErrorMessage }] =
      await Promise.all([runOcrAnalysis(capture, engine), analyzeVisualSafely(capture)])

    const observation: ScannerObservation = {
      rawNameText: ocrResult.rawNameText,
      rawCollectorNumberText: ocrResult.rawCollectorNumberText,
      rawSetText: null,
      languageHint,
    }

    // Textual signals meet the catalog through P67's adapter (existing search_cards surface).
    const textCandidates = await retrieveScannerCandidates(observation)

    let visualScores: VisualEvidenceByCard | undefined
    let mergedCandidates = textCandidates
    if (visualResult && visualResult.hits.length > 0) {
      visualScores = new Map(visualResult.hits.map((hit) => [hit.cardId, hit.similarity]))
      const knownIds = new Set(textCandidates.map((c) => c.cardId))
      const unknownVisualIds = visualResult.hits
        .map((hit) => hit.cardId)
        .filter((id) => !knownIds.has(id))
      if (unknownVisualIds.length > 0) {
        // Visual shortlist candidates the text search never found (prompt §16's hybrid
        // retrieval): fetch their identity/metadata in one bounded round trip. A card the
        // catalog no longer has (e.g. deactivated since the index was built) is simply dropped —
        // never fabricated.
        const enriched = await getCardsByIds(unknownVisualIds).catch(() => [])
        mergedCandidates = [
          ...textCandidates,
          ...enriched.map((card) => toCandidateRecordFromCatalog(card)),
        ]
      }
    }

    const match = matchScannerObservation(observation, mergedCandidates, visualScores)

    // Assemble this scan's diagnostics snapshot (P77 prompt §13/§40) — purely observational,
    // computed from data the pipeline above already produced; nothing here influences `match`.
    const visualSnapshot = visualClient.getDiagnosticsSnapshot()
    const nameById = new Map(mergedCandidates.map((c) => [c.cardId, c.name]))
    lastDiagnostics = {
      visualModelState: visualSnapshot.modelState,
      visualBackend: visualResult?.backend ?? visualSnapshot.readyInfo?.backend ?? 'unknown',
      modelLoadMs: visualSnapshot.readyInfo?.modelColdLoadMs ?? null,
      captureCropWidth: capture.cardRect.width,
      captureCropHeight: capture.cardRect.height,
      visualEmbeddingCreated: visualResult !== null,
      embeddingNorm: visualResult?.embeddingNorm ?? null,
      indexVersion: visualSnapshot.readyInfo?.indexVersion ?? null,
      indexCardCount: visualSnapshot.readyInfo?.cardCount ?? null,
      indexSourceProjectRef: visualSnapshot.readyInfo?.indexSourceProjectRef ?? null,
      indexLoadMs: visualSnapshot.readyInfo?.indexLoadMs ?? null,
      indexSearchMs: visualResult?.searchMs ?? null,
      topVisualCandidates: (visualResult?.hits ?? []).slice(0, 5).map((hit) => ({
        cardId: hit.cardId,
        similarity: hit.similarity,
        name: nameById.get(hit.cardId) ?? null,
      })),
      ocrNameSignal: ocrResult.rawNameText,
      ocrCollectorSignal: ocrResult.rawCollectorNumberText,
      finalRerankedCandidates: match.candidates
        .slice(0, SCANNER_UI_CANDIDATE_LIMIT)
        .map((ranked) => ({
          cardId: ranked.card.cardId,
          name: ranked.card.name,
          confidenceTier: tierToConfidence(match.tier),
          reasons: ranked.reasons,
        })),
      // P78 fix: `visualErrorMessage` only ever covers exceptions thrown INSIDE
      // analyzeVisualSafely (createImageBitmap/client.analyze throwing) — a model/backend
      // initialization failure never throws there (VisualRecognitionClient.analyze() resolves
      // null gracefully per prompt §36), so it stays null and this line used to unconditionally
      // show VISUAL_ERROR=— even when the worker had recorded a perfectly good reason. Falling
      // back to the snapshot's own unavailableReason surfaces it.
      visualError:
        visualResult === null ? (visualErrorMessage ?? visualSnapshot.unavailableReason) : null,
      visualBackendRequested: visualSnapshot.backendDiagnostics?.backendRequested ?? 'auto',
      visualBackendAttempts: visualSnapshot.backendDiagnostics?.backendAttempts ?? {
        webgpu: 'not-attempted',
        wasm: 'not-attempted',
      },
      webgpuError: visualSnapshot.backendDiagnostics?.webgpuError ?? null,
      wasmError: visualSnapshot.backendDiagnostics?.wasmError ?? null,
      processorLoad: visualSnapshot.backendDiagnostics?.processorLoad ?? null,
      modelLoad: visualSnapshot.backendDiagnostics?.modelLoad ?? null,
      indexLoadStatus: visualSnapshot.backendDiagnostics?.indexLoad ?? null,
    }

    return {
      confidence: tierToConfidence(match.tier),
      candidates: match.candidates
        .slice(0, SCANNER_UI_CANDIDATE_LIMIT)
        .map((ranked) => toUiCandidate(ranked.card)),
    } satisfies ScannerAnalysis
  }

  function getLastDiagnostics(): ScannerDiagnostics | null {
    return lastDiagnostics
  }

  async function searchFallback(query: ScannerSearchQuery) {
    const defaults = scannerSessionStore.load(options.userId)
    const language = defaults?.language ?? null
    const number = query.collectorNumber?.trim()
    const composed =
      number !== undefined && number !== '' ? `${query.name.trim()} ${number}` : query.name.trim()
    try {
      const page = await searchCards({
        query: composed,
        language,
        limit: SCANNER_UI_CANDIDATE_LIMIT,
      })
      return page.results.map((row) =>
        toUiCandidate({
          cardId: row.cardId,
          name: row.name,
          localId: row.localId,
          rarity: row.rarity,
          category: row.category,
          illustrator: row.illustrator,
          imageBaseUrl: row.imageBaseUrl,
          language: row.language,
          setId: row.setId,
          setName: row.setName,
          variantCount: row.variantCount,
        }),
      )
    } catch {
      throw new ScannerCatalogUnavailableError()
    }
  }

  async function listVariantChoices(cardId: string): Promise<ScannerVariantChoice[]> {
    const variants = await getCardVariants(cardId)
    return variants
      .filter((variant) => variant.isActive)
      .map((variant) => ({ id: variant.id, label: variantChoiceLabel(variant) }))
  }

  async function commitBatch(items: ScannerCommitItem[]): Promise<ScannerCommitResult> {
    const defaults = scannerSessionStore.load(options.userId)
    const origin: ScannerOrigin = defaults?.origin ?? 'pre_tracking'
    const acquiredOn = defaults?.acquiredOn ?? new Date().toISOString().slice(0, 10)
    const storageLocationId = defaults?.storageLocationId ?? undefined

    const outcomes: ScannerCommitOutcome[] = []
    let addedCount = 0
    // Sequential by design (prompt §29): partial failures stay explainable, one item's outcome
    // never races another's, and successes are marked before the next attempt begins.
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item === undefined) continue
      try {
        await addCardAcquisition({
          cardVariantId: item.variantId,
          gradingState: 'raw',
          condition: item.condition,
          origin,
          costBasisState: scannerCostBasisState(origin),
          quantity: item.quantity,
          acquiredOn,
          storageLocationId,
          clientRequestKey: item.requestKey,
        })
        addedCount += 1
        outcomes.push({ index, status: 'added', message: null })
      } catch (error: unknown) {
        outcomes.push(classifyAcquisitionFailure(index, error))
      }
    }
    return { addedCount, outcomes }
  }

  function dispose(): void {
    engine.dispose()
    releaseOcrCanvases()
    visualClient.dispose()
  }

  return {
    analyzeCapture,
    searchFallback,
    listVariantChoices,
    commitBatch,
    dispose,
    getLastDiagnostics,
  }
}

/**
 * The one factory the scanner page consumes (P66's seam). One controller instance per mounted
 * scanner session; the page MUST call dispose() when it unmounts so the OCR worker terminates.
 */
export function getScannerUiController(userId: string | null): ScannerUiController {
  return createRealScannerController({ userId })
}
