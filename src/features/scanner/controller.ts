import { searchCards, getCardVariants, type CatalogVariant } from '../../data/catalog'
import { addCardAcquisition } from '../../data/collection'
import {
  matchScannerObservation,
  type ScannerObservation,
  type ScannerCandidateRecord,
  type ScannerConfidenceTier,
} from '../../domain/scanner'
import {
  retrieveScannerCandidates,
  ScannerCatalogUnavailableError,
} from '../../data/scanner/scanner-catalog'
import { runOcrAnalysis, releaseOcrCanvases } from './analyze'
import { ScannerOcrEngine } from './ocr-engine'
import { scannerCostBasisState, scannerSessionStore, type ScannerOrigin } from './session-store'
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCommitItem,
  ScannerCommitOutcome,
  ScannerCommitResult,
  ScannerConfidence,
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

export function createRealScannerController(
  options: RealScannerControllerOptions,
): ScannerUiController {
  const engine = new ScannerOcrEngine()

  async function analyzeCapture(capture: Parameters<ScannerUiController['analyzeCapture']>[0]) {
    // On-device OCR first: bytes in, text out. Nothing here touches the network.
    const ocrResult = await runOcrAnalysis(capture, engine)
    // V1 recognises ENGLISH cards only (prompt §24): the language hint comes from the session
    // defaults (always 'en' today), so English candidates gain their +5 evidence and Japanese
    // catalog rows are honestly penalised instead of pretending Japanese OCR exists.
    const defaults = scannerSessionStore.load(options.userId)
    const observation: ScannerObservation = {
      rawNameText: ocrResult.rawNameText,
      rawCollectorNumberText: ocrResult.rawCollectorNumberText,
      rawSetText: null,
      languageHint: defaults?.language ?? 'en',
    }
    // Textual signals meet the catalog through P67's adapter (existing search_cards surface).
    const candidates = await retrieveScannerCandidates(observation)
    const match = matchScannerObservation(observation, candidates)
    return {
      confidence: tierToConfidence(match.tier),
      candidates: match.candidates
        .slice(0, SCANNER_UI_CANDIDATE_LIMIT)
        .map((ranked) => toUiCandidate(ranked.card)),
    } satisfies ScannerAnalysis
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
  }

  return { analyzeCapture, searchFallback, listVariantChoices, commitBatch, dispose }
}

/**
 * The one factory the scanner page consumes (P66's seam). One controller instance per mounted
 * scanner session; the page MUST call dispose() when it unmounts so the OCR worker terminates.
 */
export function getScannerUiController(userId: string | null): ScannerUiController {
  return createRealScannerController({ userId })
}
