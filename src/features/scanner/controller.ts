import {
  searchCards,
  getCardVariants,
  getCardsByIds,
  classifyCardIdsAgainstCatalog,
  type CatalogVariant,
  type CardCatalogPresence,
} from '../../data/catalog'
import { addCardAcquisition } from '../../data/collection'
import {
  matchScannerObservation,
  parseCollectorNumberStructured,
  rankScannerCandidates,
  rankScannerCandidatesFull,
  SCORING_TIERS,
  visualEvidenceTier,
  type RankedScannerCandidate,
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
import { isScannerDebugEnabled } from './debug-flag'
import type { PixelRect } from './guide-geometry'
import { ScannerOcrEngine } from './ocr-engine'
import { rectifyCapture } from './rectify-capture'
import { scannerCostBasisState, scannerSessionStore, type ScannerOrigin } from './session-store'
import {
  VisualRecognitionClient,
  type VisualAnalysisResult,
  type ExpectedCardRank,
} from './visual/visual-client'
import { estimateAssetCacheStatus } from './visual/phase-timing'

/**
 * P81 §5/§15: how long a scan will wait for the visual channel when it was NOT already warm at
 * the moment analysis began, before proceeding OCR-only. The real-device evidence this session
 * repairs (388s and worse cold model loads, one owner wait of 6-7 minutes with no usable result)
 * makes an unbounded wait on the model unacceptable regardless of how good route-entry prewarming
 * becomes — a slow/first-ever network condition can still outlast prewarming's head start. Chosen
 * as a small multiple of the "warm scan" target (P81 §15, a few seconds) rather than tuned against
 * a real device this session (no iPhone available) — the owner's real-device retest is what
 * validates whether 8s is generous or stingy in practice; the debug panel's
 * VISUAL_PREWARM_READY_BEFORE_CAPTURE/CANDIDATE_EXPANSION_TRIGGERED-style honesty extends to this
 * (a timed-out scan says so in VISUAL_ERROR, never silently degrades unlabeled).
 */
export const VISUAL_COLD_ANALYSIS_TIMEOUT_MS = 8000

/** F-05 (P89): thrown by {@link analyzeCapture} when its caller's `AbortSignal` fires between
 *  pipeline stages. Distinguishable from a real analysis failure so a caller can tell "this was
 *  cancelled" apart from "this genuinely failed" — the ScannerPage caller never surfaces either
 *  case to the user once the analysis has gone stale (its own generation-ref check already no-ops
 *  first), but the distinct name keeps that intent legible and testable. */
export class ScannerAnalysisAbortedError extends Error {
  constructor() {
    super('Scan analysis was cancelled.')
    this.name = 'ScannerAnalysisAbortedError'
  }
}

function throwIfAnalysisAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScannerAnalysisAbortedError()
}

/**
 * P82 §16: REVERSES P81's own stagger order, evidence-gated (D-099 addendum). P81 started the
 * heavyweight DINO visual channel FIRST on the reasoning that the bigger, slower download deserved
 * a network/CPU head start. The owner's real-iPhone retest (P82 §0) showed `VISUAL_MODEL_STATE=
 * loading` for over a minute while OCR alone — the smaller, faster-to-warm channel — never even
 * got a chance to identify a clearly-legible card. This session also benchmarked a lightweight
 * perceptual-hash (dHash/pHash) retrieval channel as a possible THIRD, even-faster signal (P82
 * §9-§11) and found it does NOT provide usable discrimination once real capture-like distortion
 * (tilt + off-center placement, the SAME corpus P79's rectification benchmark uses) is present —
 * same-card and different-card similarity distributions overlap almost completely (see
 * docs/SCANNER_RESEARCH.md §7e for the measured numbers) — so it was evidence-gated OUT of
 * production, leaving OCR + text search as the only real, evidence-backed FAST baseline that does
 * not require the ~45MB DINO cold start. OCR's own cold assets (~10MB: one Tesseract WASM+glue
 * pair plus traineddata) are a small fraction of DINO's — starting it FIRST gets the fast baseline
 * ready sooner, at the cost of DINO's own cold start beginning slightly later than it did under
 * P81's ordering. A heuristic chosen for this session's evidence, not re-benchmarked against a real
 * device — same disclosed-not-measured posture P81 itself used for the original ordering. */
export const ENHANCED_VISUAL_PREWARM_STAGGER_MS = 1500

/** Bounded raw visual shortlist handed to the domain matcher (prompt §16/§31): retrieval may
 *  examine this many raw candidates internally, but the UI never sees more than
 *  SCANNER_UI_CANDIDATE_LIMIT of them after reranking. Production's own value is UNCHANGED by
 *  P84/P87 — only the debug-only constants below were raised. */
const VISUAL_SHORTLIST_SIZE = 30
/** Debug-only widened shortlist (P79 §10, raised 50->200 by P84/ported P87): lets a debug session
 *  see whether the correct card exists deeper in the raw visual neighbours than production ever
 *  surfaces — load-bearing for the {@link ExpectedCardRank} debug tool, which needs the FULL index
 *  reachable, not just a shallow shortlist. Never used for actual matching/reranking —
 *  `matchScannerObservation` still only ever sees the SAME merged candidate pool either way; this
 *  only changes how many raw hits the debug panel can show. A full-index brute-force search costs
 *  the same regardless of how much of the sorted result is kept (real-device evidence, P84:
 *  INDEX_SEARCH_MS=16 at 19,501 cards for topK=30), so widening this for debug sessions only is
 *  not expected to be measurably slower. */
const VISUAL_DEBUG_SHORTLIST_SIZE = 200
/** How many raw visual neighbours the debug panel's extended list shows (P79 §10, raised 20->100
 *  by P84/ported P87 — same reasoning as {@link VISUAL_DEBUG_SHORTLIST_SIZE} above). */
const DEBUG_EXTENDED_CANDIDATE_LIMIT = 100
import type {
  ScannerAnalysis,
  ScannerCandidate,
  ScannerCommitItem,
  ScannerCommitOutcome,
  ScannerCommitResult,
  ScannerConfidence,
  ScannerDebugImages,
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
 *  rows internally, but the user sees at most these top-ranked candidates in the NORMAL
 *  (confidently-differentiated) case. */
export const SCANNER_UI_CANDIDATE_LIMIT = 5
/** Widened shortlist shown ONLY when the ranking near the cutoff is flat/ambiguous (P80 §6/§13,
 *  the Shieldon real-device case: the correct card sat at raw rank 6 and was never selectable
 *  because the UI never showed a 6th option). Still short enough to stay a clean list, never the
 *  engine's full 10-candidate retention depth. */
export const SCANNER_UI_EXPANDED_CANDIDATE_LIMIT = 8
/** How much the score at the normal cutoff rank may trail the top score before the ranking still
 *  counts as "clearly settled" (P80). Reuses the domain's OWN ambiguity margin
 *  (`SCORING_TIERS.highMinMargin`) rather than inventing a second threshold — the same gap the
 *  engine already uses to decide whether HIGH confidence should hold. */
const CANDIDATE_EXPANSION_SCORE_GAP = SCORING_TIERS.highMinMargin

/**
 * How many candidates to actually show for one match (P80): the normal 5 whenever the top of the
 * list has clearly separated from the pack by the 5th rank, or when there simply aren't more than
 * 5 candidates to show anyway. HIGH-tier matches never expand — by construction (engine.ts) a HIGH
 * tier already has a ≥15-point margin over its runner-up, so the ranking is never flat at rank 2,
 * let alone rank 5. Widens toward {@link SCANNER_UI_EXPANDED_CANDIDATE_LIMIT} only when the score
 * at the normal cutoff is still close to the top score — a genuinely undifferentiated tail, not
 * merely "confidence is LOW" (a single strong LOW candidate with a clear runner-up gap does not
 * need more options; a flat spread of near-equal candidates does).
 */
export function resolveVisibleCandidateCount(
  tier: ScannerConfidenceTier,
  ranked: readonly RankedScannerCandidate[],
): number {
  if (ranked.length <= SCANNER_UI_CANDIDATE_LIMIT) return ranked.length
  if (tier === 'high') return SCANNER_UI_CANDIDATE_LIMIT
  const top = ranked[0]
  const atCutoff = ranked[SCANNER_UI_CANDIDATE_LIMIT - 1]
  if (top === undefined || atCutoff === undefined) return SCANNER_UI_CANDIDATE_LIMIT
  const gap = top.score - atCutoff.score
  return gap <= CANDIDATE_EXPANSION_SCORE_GAP
    ? SCANNER_UI_EXPANDED_CANDIDATE_LIMIT
    : SCANNER_UI_CANDIDATE_LIMIT
}

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
  const candidate = error as {
    code?: unknown
    details?: unknown
    hint?: unknown
    message?: unknown
  }
  const hasServerAnswer =
    typeof candidate.code === 'string' ||
    typeof candidate.details === 'string' ||
    typeof candidate.hint === 'string'
  if (hasServerAnswer) {
    const rawMessage = typeof candidate.message === 'string' ? candidate.message : ''
    // F-19 (P89): idempotency-key-reuse is a DEFINITE server answer like any other refusal, but
    // it means something categorically different — this exact request key already committed
    // under DIFFERENT material facts, most often because an earlier ambiguous
    // ('needs_verification') attempt actually succeeded server-side before its response reached
    // the client, and the item was then edited before retrying. "Edit it or remove it" is
    // actively dangerous for this specific case: editing-and-resubmitting can never update the
    // existing entry (the RPC has no update semantics), and removing-and-rescanning generates a
    // brand new request key that WILL create a genuine duplicate lot on top of the one that
    // already silently succeeded. Mirrors the sibling Openings feature's own handling of the
    // identical server pattern (src/features/openings/controller.ts's mapOpeningErrorMessage).
    if (/idempotency-key-reuse/.test(rawMessage)) {
      return {
        index,
        status: 'failed',
        message:
          'This card may already be in your collection with different details. Check Portfolio before trying again — editing and resubmitting this item will not update the existing entry.',
      }
    }
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

/**
 * Single owner of the current scan's debug-only image object URLs (P79 §4) — mirrors
 * CaptureStore's own discipline exactly: at most one set of URLs alive at a time, every
 * replacement or clear revokes the previous set, so a debug session cannot leak blob URLs across
 * scans. A null blob (a stage that never ran) simply stays null — never a fabricated placeholder.
 */
class DebugImageUrlStore {
  private current: ScannerDebugImages | null = null

  set(blobs: {
    rawCropBlob: Blob | null
    rectifiedBlob: Blob | null
    nameRoiBlob: Blob | null
    numberRoiBlob: Blob | null
  }): ScannerDebugImages {
    this.clear()
    const toUrl = (blob: Blob | null) => (blob === null ? null : URL.createObjectURL(blob))
    this.current = {
      rawCropUrl: toUrl(blobs.rawCropBlob),
      rectifiedUrl: toUrl(blobs.rectifiedBlob),
      nameRoiUrl: toUrl(blobs.nameRoiBlob),
      numberRoiUrl: toUrl(blobs.numberRoiBlob),
    }
    return this.current
  }

  get(): ScannerDebugImages | null {
    return this.current
  }

  clear(): void {
    if (this.current === null) return
    const urls: (string | null)[] = [
      this.current.rawCropUrl,
      this.current.rectifiedUrl,
      this.current.nameRoiUrl,
      this.current.numberRoiUrl,
    ]
    for (const url of urls) {
      if (url !== null) URL.revokeObjectURL(url)
    }
    this.current = null
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
  const debugImages = new DebugImageUrlStore()
  // N-21 (P94): a controller instance is created per signed-in identity (D-104 F-05: an account
  // switch replaces it, it never survives across users) and this session's whole write-authority
  // ultimately comes from the CURRENT Supabase auth session, not from anything captured here —
  // `commitBatch`'s RPC calls carry no user id, so a `for` loop still mid-flight after THIS
  // controller has been disposed (unmount, or an account switch that constructed a fresh
  // controller for the new identity) would otherwise keep writing rows under whatever session
  // happens to be current when each remaining `await` resolves. Checked before EACH item so a
  // disposal mid-batch stops issuing further writes instead of silently continuing under a
  // possibly-different signed-in identity. This is defense in depth, not the authority boundary —
  // backend RLS (`auth.uid()`-scoped, D-104/D-096) is what actually prevents a cross-user write;
  // this only prevents a stale controller from attempting one in the first place.
  let disposed = false
  /** P90 §21 (debug-only): the exact evidence the most recent scan's real match() call scored
   *  against — kept ONLY so {@link getExpectedCardRank} can compute a real hybrid rank for a card
   *  the owner names after the fact, using the SAME scoring pipeline production used, not a
   *  re-derived approximation. Never read by anything on the production matching path; overwritten
   *  every scan, cleared on dispose. */
  let lastMatchContext: {
    signals: ReturnType<typeof matchScannerObservation>['signals']
    candidates: ScannerCandidateRecord[]
    visualScores: VisualEvidenceByCard | undefined
  } | null = null

  // P81 §6/§17: session-lifetime prewarm bookkeeping — separate from lastDiagnostics because it
  // must survive across scans (prewarm runs once per session), not reset per capture.
  let visualPrewarmStarted = false
  let ocrPrepareMs: number | null = null

  function prewarmOcr(): void {
    const start = performance.now()
    engine
      .prepare()
      .then(() => {
        if (ocrPrepareMs === null) ocrPrepareMs = Math.round(performance.now() - start)
      })
      .catch(() => {
        // A failed prepare still tells the debug panel how long the attempt took; the actual
        // scan-time failure is reported through the existing OCR error path (errors.ts), not here.
        if (ocrPrepareMs === null) ocrPrepareMs = Math.round(performance.now() - start)
      })
  }

  /** Route-entry prewarm (P82 §16, reverses P81's own order — see
   *  ENHANCED_VISUAL_PREWARM_STAGGER_MS's doc for the evidence): begins warming the FAST (OCR)
   *  baseline immediately, then the heavyweight DINO visual channel after a short stagger, so
   *  neither cold start blindly contends with the other for network/CPU on a genuinely cold
   *  device. Idempotent — a second call is a no-op; both underlying `prepare()`/`prewarm()` calls
   *  are already idempotent too, so this stays safe even if called from more than one render path. */
  function prewarm(): void {
    if (visualPrewarmStarted) return
    visualPrewarmStarted = true
    prewarmOcr()
    setTimeout(() => {
      visualClient.prewarm().catch(() => {
        // Unavailability is a normal, already-diagnosed outcome
        // (visualClient.getDiagnosticsSnapshot reports it) — prewarm() itself never needs to react.
      })
    }, ENHANCED_VISUAL_PREWARM_STAGGER_MS)
  }

  function getVisualPrewarmState(): 'not-loaded' | 'loading' | 'ready' | 'failed' {
    return visualClient.getDiagnosticsSnapshot().modelState
  }

  /** P82 §17-§19: the FAST baseline's own readiness — OCR only, no dependency on the heavyweight
   *  DINO channel at all. This is what the intro screen's honest loading copy should gate on. */
  function getFastScannerState(): 'not-loaded' | 'loading' | 'ready' | 'failed' {
    return engine.getState()
  }

  /** Bounds how long one scan waits on the visual channel when it was NOT already warm (P81 §5):
   *  never the multi-minute cold-load itself. A warm channel is awaited normally — no bound is
   *  needed or applied, matching every existing test's fast-resolving mocked behaviour exactly. */
  async function analyzeVisualBounded(
    capture: { blob: Blob; cardRect: PixelRect },
    topK: number,
  ): Promise<{ result: VisualAnalysisResult | null; errorMessage: string | null }> {
    const readyBefore = getVisualPrewarmState() === 'ready'
    const work = analyzeVisualSafely(capture, topK)
    if (readyBefore) return work
    return Promise.race([
      work,
      new Promise<{ result: null; errorMessage: string }>((resolve) => {
        setTimeout(() => {
          resolve({
            result: null,
            errorMessage:
              'Visual recognition is still warming up on this device — used text search only for this scan.',
          })
        }, VISUAL_COLD_ANALYSIS_TIMEOUT_MS)
      }),
    ])
  }

  /** Returns its own error message rather than mutating shared state (P78): a closure-captured
   *  `let` reassigned inside an awaited call is invisible to TypeScript's control-flow narrowing
   *  at the read site (confirmed — `@typescript-eslint/no-unnecessary-condition` flags the read as
   *  provably null even though it demonstrably isn't at runtime), so the safer AND more correct
   *  shape is to hand the error back through the return value instead. */
  async function analyzeVisualSafely(
    capture: { blob: Blob; cardRect: PixelRect },
    topK: number,
  ): Promise<{ result: VisualAnalysisResult | null; errorMessage: string | null }> {
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
      const result = await visualClient.analyze(bitmap, topK)
      return { result, errorMessage: null }
    } catch (error) {
      return { result: null, errorMessage: (error as Error).message }
    }
  }

  async function analyzeCapture(
    capture: Parameters<ScannerUiController['analyzeCapture']>[0],
    signal?: AbortSignal,
  ) {
    const debug = isScannerDebugEnabled()

    // P79: rectify BEFORE either channel sees a frame — detects the card's real boundary within
    // a margin around the guide rect (correcting mild tilt / imperfect alignment / stray
    // background) and hands both OCR and the visual channel the SAME canonical card image through
    // their existing, unchanged code paths. Never throws: a detection failure or any canvas error
    // resolves to the original, unrectified capture (see rectify-capture.ts).
    const rectified = await rectifyCapture(capture, { debug })
    throwIfAnalysisAborted(signal)
    const workingCapture = rectified.frame

    // On-device OCR and on-device visual embedding run in parallel — both stay entirely local
    // (prompt §6/§41): no image bytes cross the network either way, only the RESULTING textual
    // catalog queries (OCR) and card-id lookups (visual shortlist enrichment) do.
    const defaults = scannerSessionStore.load(options.userId)
    const languageHint = defaults?.language ?? 'en'

    // P81 §6/§17: snapshot BEFORE the race below settles anything — the honest answer to "was
    // prewarming already done by the time this capture happened."
    const visualPrewarmReadyBeforeCapture = getVisualPrewarmState() === 'ready'

    const [ocrResult, { result: visualResult, errorMessage: visualErrorMessage }] =
      await Promise.all([
        runOcrAnalysis(workingCapture, engine, undefined, debug),
        analyzeVisualBounded(
          workingCapture,
          debug ? VISUAL_DEBUG_SHORTLIST_SIZE : VISUAL_SHORTLIST_SIZE,
        ),
      ])

    throwIfAnalysisAborted(signal)
    const observation: ScannerObservation = {
      rawNameText: ocrResult.rawNameText,
      rawCollectorNumberText: ocrResult.rawCollectorNumberText,
      rawSetText: null,
      languageHint,
      // P88 §8/F-12: threads the winning OCR read's own confidence into the matcher's evidence
      // reliability weighting (engine.ts's `ocrTextReliability`) — null/absent when the full-frame
      // fallback ran instead of a field-specific ROI read (analyze.ts never fabricates one).
      nameOcrConfidence: ocrResult.nameConfidence ?? null,
      collectorOcrConfidence: ocrResult.collectorNumberConfidence ?? null,
    }

    // Textual signals meet the catalog through P67's adapter (existing search_cards surface).
    const textCandidates = await retrieveScannerCandidates(observation)
    throwIfAnalysisAborted(signal)

    let visualScores: VisualEvidenceByCard | undefined
    let mergedCandidates = textCandidates
    // N-08 (P94): aggregate counts distinguishing "the visual index found this id" from "it also
    // survived catalog enrichment" — computed for free from data this block already produces, so
    // a diagnostics reader never has to infer the enrichment-filtering gap from a bare candidate
    // count alone. Null (not 0) when there was nothing to enrich in the first place.
    let visualUnknownIdCount: number | null = null
    let visualEnrichedIdCount: number | null = null
    let visualMissingIdCount: number | null = null
    if (visualResult && visualResult.hits.length > 0) {
      visualScores = new Map(visualResult.hits.map((hit) => [hit.cardId, hit.similarity]))
      const knownIds = new Set(textCandidates.map((c) => c.cardId))
      const unknownVisualIds = visualResult.hits
        .map((hit) => hit.cardId)
        .filter((id) => !knownIds.has(id))
      visualUnknownIdCount = unknownVisualIds.length
      if (unknownVisualIds.length > 0) {
        // Visual shortlist candidates the text search never found (prompt §16's hybrid
        // retrieval): fetch their identity/metadata in one bounded round trip. A card the
        // catalog no longer has, is now inactive, or is not the expected catalog language
        // (F-28/F-29/P88 §16 — the visual index is English-only today, `session-store.ts`'s
        // `language: 'en'` default) is simply dropped — never fabricated.
        const enriched = await getCardsByIds(unknownVisualIds, 'en').catch(() => [])
        visualEnrichedIdCount = enriched.length
        visualMissingIdCount = unknownVisualIds.length - enriched.length
        mergedCandidates = [
          ...textCandidates,
          ...enriched.map((card) => toCandidateRecordFromCatalog(card)),
        ]
      } else {
        visualEnrichedIdCount = 0
        visualMissingIdCount = 0
      }
    }

    const match = matchScannerObservation(observation, mergedCandidates, visualScores)
    // P90 §21: snapshot for the debug-only expected-card-rank tool — see lastMatchContext's own
    // doc. Always overwritten, never merged with a previous scan's evidence.
    lastMatchContext = { signals: match.signals, candidates: mergedCandidates, visualScores }
    // P80 §6/§13: how many of match.candidates the user actually sees this scan — normally 5,
    // widened toward SCANNER_UI_EXPANDED_CANDIDATE_LIMIT only when the ranking near the cutoff is
    // genuinely flat (the Shieldon rank-6 real-device case).
    const visibleCandidateCount = resolveVisibleCandidateCount(match.tier, match.candidates)

    // Assemble this scan's diagnostics snapshot (P77 prompt §13/§40) — purely observational,
    // computed from data the pipeline above already produced; nothing here influences `match`.
    const visualSnapshot = visualClient.getDiagnosticsSnapshot()
    const nameById = new Map(mergedCandidates.map((c) => [c.cardId, c.name]))
    const imageBaseUrlById = new Map(mergedCandidates.map((c) => [c.cardId, c.imageBaseUrl]))
    // P88 §21: the calibrated band of the strongest visual hit this scan, independent of which
    // candidate wins overall — real-device reports can then say "the visual channel was in the
    // catastrophic band" instead of a bare, uncalibrated cosine number.
    const strongestVisualSimilarity =
      visualScores && visualScores.size > 0 ? Math.max(...visualScores.values()) : null
    // P88 §21: why (if at all) the tier was capped below what the raw top score alone implies —
    // mirrors engine.ts's own precedence (a visual-dominance guard already discounted the score
    // before tiering ran; the margin/disagreement checks run afterward, in that order).
    const tierCapReason = match.notes.includes('visual-text-disagreement')
      ? ('visual-text-disagreement' as const)
      : match.notes.includes('runner-up-margin-small')
        ? ('runner-up-margin-small' as const)
        : match.candidates.some((c) => c.reasons.includes('visual-dominance-guarded'))
          ? ('visual-dominance-guarded' as const)
          : null
    lastDiagnostics = {
      visualModelState: visualSnapshot.modelState,
      visualBackend: visualResult?.backend ?? visualSnapshot.readyInfo?.backend ?? 'unknown',
      modelLoadMs: visualSnapshot.readyInfo?.modelColdLoadMs ?? null,
      // The ORIGINAL, un-rectified capture's own numbers (P79 §6): the frame's full pixel
      // dimensions and the card-rect crop the guide geometry produced from it — proves what
      // image space the pipeline actually started from, independent of the fixed-size canonical
      // output rectification always emits afterward.
      captureFrameWidth: capture.width,
      captureFrameHeight: capture.height,
      captureCropWidth: capture.cardRect.width,
      captureCropHeight: capture.cardRect.height,
      rectificationUsed: !rectified.usedFallback,
      visualEmbeddingCreated: visualResult !== null,
      embeddingNorm: visualResult?.embeddingNorm ?? null,
      indexVersion: visualSnapshot.readyInfo?.indexVersion ?? null,
      indexCardCount: visualSnapshot.readyInfo?.cardCount ?? null,
      indexSourceProjectRef: visualSnapshot.readyInfo?.indexSourceProjectRef ?? null,
      indexModelRevision: visualSnapshot.readyInfo?.indexModelRevision ?? null,
      indexGeneratedAt: visualSnapshot.readyInfo?.indexGeneratedAt ?? null,
      indexEmbeddingsSha256: visualSnapshot.readyInfo?.indexEmbeddingsSha256 ?? null,
      indexContentId: visualSnapshot.readyInfo?.indexContentId ?? null,
      indexSchemaVersion: visualSnapshot.readyInfo?.indexSchemaVersion ?? null,
      indexPayloadFormat: visualSnapshot.readyInfo?.indexPayloadFormat ?? null,
      indexPrototypesPerCard: visualSnapshot.readyInfo?.indexPrototypesPerCard ?? null,
      indexPrototypeStrategy: visualSnapshot.readyInfo?.indexPrototypeStrategy ?? null,
      indexRowCount: visualSnapshot.readyInfo?.indexRowCount ?? null,
      indexSourceProjectExpected: visualSnapshot.readyInfo?.indexSourceProjectExpected ?? null,
      indexSourceProjectMatch: visualSnapshot.readyInfo?.indexSourceProjectMatch ?? null,
      indexRuntimeChecksumVerified: visualSnapshot.readyInfo?.indexRuntimeChecksumVerified ?? null,
      indexRuntimeChecksumMs: visualSnapshot.readyInfo?.indexRuntimeChecksumMs ?? null,
      indexLoadMs: visualSnapshot.readyInfo?.indexLoadMs ?? null,
      indexSearchMs: visualResult?.searchMs ?? null,
      topVisualCandidates: (visualResult?.hits ?? []).slice(0, 5).map((hit) => ({
        cardId: hit.cardId,
        similarity: hit.similarity,
        name: nameById.get(hit.cardId) ?? null,
      })),
      // Debug-only widened shortlist (P79 §10): empty outside a debug session (the search itself
      // never widens past VISUAL_SHORTLIST_SIZE for a real user, so there is nothing extra to
      // show even if this were populated unconditionally).
      topVisualCandidatesExtended: debug
        ? (visualResult?.hits ?? []).slice(0, DEBUG_EXTENDED_CANDIDATE_LIMIT).map((hit) => ({
            cardId: hit.cardId,
            similarity: hit.similarity,
            name: nameById.get(hit.cardId) ?? null,
            imageBaseUrl: imageBaseUrlById.get(hit.cardId) ?? null,
          }))
        : [],
      ocrNameSignal: ocrResult.rawNameText,
      ocrCollectorSignal: ocrResult.rawCollectorNumberText,
      // P80 §7: which adaptive-ROI layout candidate actually won each field this scan (roi.ts's
      // `id`) — null means no candidate produced anything usable for that field.
      ocrNameRoiId: ocrResult.nameRoiId,
      ocrNumberRoiId: ocrResult.numberRoiId,
      // P85 §11: empty outside a debug session (ocrResult.trials is only ever populated when
      // `debug` was true — see analyze.ts's `runOcrAnalysis`).
      ocrTrials: ocrResult.trials ?? [],
      // P80 §6: true exactly when the visible shortlist widened past the normal 5 — lets the
      // debug panel/owner confirm expansion actually fired for a flat ranking like Shieldon's.
      candidateExpansionTriggered: visibleCandidateCount > SCANNER_UI_CANDIDATE_LIMIT,
      finalRerankedCandidates: match.candidates.slice(0, visibleCandidateCount).map((ranked) => ({
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
      visualCalibrationBand:
        strongestVisualSimilarity === null ? null : visualEvidenceTier(strongestVisualSimilarity),
      ocrNameConfidence: ocrResult.nameConfidence ?? null,
      ocrCollectorConfidence: ocrResult.collectorNumberConfidence ?? null,
      ocrCollectorParseConfidence: ocrResult.rawCollectorNumberText
        ? parseCollectorNumberStructured(ocrResult.rawCollectorNumberText).confidence
        : null,
      // P88 §11/§12: not wired into production retrieval this release — see the field's own
      // doc comment on ScannerDiagnostics (contract.ts).
      ocrNameLexiconMatch: null,
      ocrNameLexiconMargin: null,
      visualTextDisagreement: match.notes.includes('visual-text-disagreement'),
      tierCapReason,
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
      // P81 §3/§6/§17: cold-start phase attribution, prewarm bookkeeping and warm-scan timing —
      // see contract.ts's field docs for what each answers.
      visualPhaseTimings: visualSnapshot.backendDiagnostics?.phaseTimings ?? null,
      firstEmbedMs: visualSnapshot.firstEmbedMs,
      assetCacheStatus: estimateAssetCacheStatus(
        visualSnapshot.backendDiagnostics?.phaseTimings ?? null,
      ),
      visualPrewarmStarted,
      visualPrewarmReadyBeforeCapture,
      ocrPrepareMs,
      // P82 §2-§6/§20: live-progress fields, populated even while the worker is STILL loading —
      // the exact gap P81's terminal-only phase timings left (VISUAL_PHASE_TIMINGS all "—" while
      // VISUAL_MODEL_STATE=loading, the owner's real-iPhone report, P82 §0).
      workerBooted: visualSnapshot.liveProgress.workerBooted,
      workerBootMs: visualSnapshot.liveProgress.workerBootMs,
      visualCurrentPhase: visualSnapshot.liveProgress.currentPhase,
      visualCurrentPhaseElapsedMs: visualSnapshot.liveProgress.currentPhaseElapsedMs,
      visualLastProgressMsAgo: visualSnapshot.liveProgress.lastProgressMsAgo,
      // P82 §17-§19: the FAST (OCR) baseline's own readiness, distinct from the heavyweight DINO
      // channel's `visualModelState` — this is what an honest loading indicator should gate on.
      fastScannerState: getFastScannerState(),
      ocrRuntimeState: getFastScannerState(),
      enhancedVisualState: visualSnapshot.modelState,
      visualUnknownIdCount,
      visualEnrichedIdCount,
      visualMissingIdCount,
    }

    // Debug-only image previews (P79 §4) — memory-only object URLs, never persisted, revoked the
    // moment the next scan replaces them or the controller disposes (DebugImageUrlStore mirrors
    // CaptureStore's own single-owner discipline). Outside a debug session this is a plain clear:
    // nothing was collected above, so there is nothing to hold onto between scans either way.
    if (debug) {
      debugImages.set({
        rawCropBlob: rectified.debugRawCropBlob,
        rectifiedBlob: workingCapture.blob,
        nameRoiBlob: ocrResult.debugImages?.nameRoiBlob ?? null,
        numberRoiBlob: ocrResult.debugImages?.numberRoiBlob ?? null,
      })
    } else {
      debugImages.clear()
    }

    return {
      confidence: tierToConfidence(match.tier),
      candidates: match.candidates
        .slice(0, visibleCandidateCount)
        .map((ranked) => toUiCandidate(ranked.card)),
    } satisfies ScannerAnalysis
  }

  function getLastDiagnostics(): ScannerDiagnostics | null {
    return lastDiagnostics
  }

  function getLastDebugImages(): ScannerDebugImages | null {
    return debugImages.get()
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
      // N-21: stop issuing further writes the moment this controller has been disposed —
      // whatever items already committed above stay committed; anything from here on is simply
      // never attempted rather than potentially written under a since-changed signed-in identity.
      if (disposed) break
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
    disposed = true
    engine.dispose()
    releaseOcrCanvases()
    visualClient.dispose()
    debugImages.clear()
    lastMatchContext = null
  }

  /** Debug-only (P84/P87 visual rank, P90 §21 hybrid rank): resolves `null` immediately, WITHOUT
   *  ever calling `visualClient`, outside `?scannerDebug=1` — this is the gate contract.ts's own
   *  doc promises. Once confirmed: the visual-only rank comes from `visualClient.getExpectedCardRank`
   *  unchanged (P87); the hybrid fields are computed HERE, against `lastMatchContext` — the exact
   *  OCR/visual evidence the most recent real scan's `matchScannerObservation` call scored — using
   *  `rankScannerCandidatesFull`, the SAME scoring/visual-dominance-guard pipeline production runs,
   *  never a separate approximation. A card outside `lastMatchContext.candidates` (never retrieved
   *  by this scan's text/visual search at all) is looked up by id and scored as an honest
   *  what-if — this never mutates the batch, never adds anything, never re-runs the scan. */
  async function getExpectedCardRank(cardId: string): Promise<ExpectedCardRank | null> {
    if (!isScannerDebugEnabled()) return null
    const visualRank = await visualClient.getExpectedCardRank(cardId)

    // Unconditional, EXACTLY as before N-08 (independent of whether the visual index found this
    // card at all): a card outside `lastMatchContext.candidates` is looked up by id and scored as
    // an honest what-if. This also doubles as the first half of N-08's enrichment classification
    // below — if it resolves, that's already the answer; only a genuine miss needs the extra
    // classification query.
    const alreadyKnown = lastMatchContext?.candidates.some((c) => c.cardId === cardId) ?? false
    let extraCandidate: ScannerCandidateRecord | null = null
    let fetchedFromCatalog = false
    if (!alreadyKnown) {
      const fetched = await getCardsByIds([cardId], 'en').catch(() => [])
      const [firstFetched] = fetched
      if (firstFetched !== undefined) {
        extraCandidate = toCandidateRecordFromCatalog(firstFetched)
        fetchedFromCatalog = true
      }
    }

    // N-08 (P94): WHY this card does or doesn't have real scoreable evidence. 'not-in-index' is
    // about the VISUAL index specifically — independent of whether it's ALSO reachable via plain
    // catalog/text lookup (the fetch above serves scoring regardless of visualRank.found). Only a
    // card the visual index DID find, but which failed the fetch above, needs the extra
    // classification query to say WHY (inactive, wrong language, or no catalog row at all).
    let enrichmentStatus: ExpectedCardRank['enrichmentStatus']
    if (visualRank === null || !visualRank.found) {
      enrichmentStatus = 'not-in-index'
    } else if (alreadyKnown || fetchedFromCatalog) {
      enrichmentStatus = 'resolved'
    } else {
      const classification = await classifyCardIdsAgainstCatalog([cardId], 'en').catch(
        () => new Map<string, CardCatalogPresence>(),
      )
      enrichmentStatus = classification.get(cardId) ?? 'missing-catalog-row'
    }

    if (lastMatchContext === null) {
      return visualRank === null ? null : { ...visualRank, enrichmentStatus }
    }

    let candidates = lastMatchContext.candidates
    if (extraCandidate !== null && !alreadyKnown) {
      candidates = [...candidates, extraCandidate]
    }
    const fullRanked = rankScannerCandidatesFull(
      lastMatchContext.signals,
      candidates,
      lastMatchContext.visualScores,
    )
    const hybridIndex = fullRanked.findIndex((entry) => entry.card.cardId === cardId)
    const hybridEntry = hybridIndex === -1 ? null : fullRanked[hybridIndex]

    // The REAL production tier for this exact scenario, only when the card would actually appear
    // in the bounded top N — never fabricated for a candidate production would never surface.
    const boundedMatch = rankScannerCandidates(
      lastMatchContext.signals,
      candidates,
      lastMatchContext.visualScores,
    )
    const inBounded = boundedMatch.candidates.some((entry) => entry.card.cardId === cardId)

    const fallback: ExpectedCardRank = {
      found: false,
      rank: null,
      similarity: null,
      totalCards: 0,
      inTop20: false,
      inTop100: false,
      indexContentId: null,
      hybridRank: null,
      hybridScore: null,
      hybridTier: null,
      scoreComponents: [],
      enrichmentStatus,
    }
    return {
      ...(visualRank ?? fallback),
      hybridRank: hybridIndex === -1 ? null : hybridIndex + 1,
      hybridScore: hybridEntry?.score ?? null,
      hybridTier: inBounded ? boundedMatch.tier : null,
      scoreComponents: hybridEntry?.reasons ?? [],
      enrichmentStatus,
    }
  }

  return {
    analyzeCapture,
    searchFallback,
    listVariantChoices,
    commitBatch,
    dispose,
    getLastDiagnostics,
    getLastDebugImages,
    prewarm,
    getVisualPrewarmState,
    getFastScannerState,
    getExpectedCardRank,
  }
}

/**
 * The one factory the scanner page consumes (P66's seam). One controller instance per mounted
 * scanner session; the page MUST call dispose() when it unmounts so the OCR worker terminates.
 */
export function getScannerUiController(userId: string | null): ScannerUiController {
  return createRealScannerController({ userId })
}
