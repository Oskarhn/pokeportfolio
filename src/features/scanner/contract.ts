import type { CardCondition } from '../../data/collection'
import type { PixelRect } from './guide-geometry'
import type { VisualPhaseTimings, AssetCacheStatusEstimate } from './visual/phase-timing'

/**
 * The boundary between M15's scanner UI (P66) and everything that makes scanning actually work —
 * the capture-analysis engine, the candidate search and the canonical acquisition path (P65/P67/
 * P68). The same one-place-replacement shape M13's export feature and M16's opening wizard used:
 *
 *   - The UI knows nothing about Supabase, RPC names, OCR or inference runtimes. It calls an
 *     {@link ScannerUiController} and renders whatever typed answer comes back.
 *   - `controller.ts` next door is the only file an integrator replaces; nothing in src/data or
 *     src/domain imports this module.
 *   - The integrated adapter wires the on-device Tesseract OCR engine (P68) to P67's deterministic
 *     matcher and the existing acquisition path.
 *
 * Honesty rules baked into these types:
 *   - Confidence is a coarse band supplied by the domain, never a percentage fabricated in the UI.
 *   - An absent match is NO_MATCH, never an empty-string name or a zeroed placeholder card.
 *   - A batch item stores card IDENTITY plus variant/quantity/condition — never the captured photo.
 *   - Commit results report what ACTUALLY happened per item; an interrupted request is reported
 *     as needing verification, never assumed added or assumed failed.
 */

/** Coarse match quality bands (prompt §14). The UI renders badges per band; it never derives or
 *  displays numeric confidence — no calibrated meaning exists for one yet. */
export type ScannerConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_MATCH'

/** One proposed card identity. Opaque to the UI: `candidateId` is whatever key P68's engine and
 *  its catalog resolution agree on, handed back verbatim by commitBatch. */
export interface ScannerCandidate {
  candidateId: string
  name: string
  setName?: string | null
  collectorNumber?: string | null
  /** Catalog-style image base URL so the existing CardImage component can render it. Null means
   *  "no image available" and renders as the neutral placeholder — never a fabricated thumbnail. */
  imageBaseUrl?: string | null
  /** Identity-level display facts come from the candidate; they are confirmed, not edited. */
  finishLabel?: string | null
  languageLabel?: string | null
}

export interface ScannerAnalysis {
  confidence: ScannerConfidence
  /** Ordered best-first. Empty exactly when confidence is NO_MATCH. Bounded to a short useful
   *  shortlist (the integrated controller caps at 5 — prompt §20). */
  candidates: ScannerCandidate[]
}

/**
 * Diagnostics for the MOST RECENT scan only (P77 prompt §13/§40) — a debug-only surface
 * (`/scan?scannerDebug=1`) for making a real-device recognition failure observable instead of
 * opaque. Every field here is informational: nothing on this type feeds back into matching, and
 * nothing on it is persisted — it lives in memory for exactly one scan and is overwritten (or
 * cleared) by the next. No raw image bytes, no auth identifiers, no secrets.
 */
export interface ScannerDiagnostics {
  visualModelState: 'not-loaded' | 'loading' | 'ready' | 'failed'
  visualBackend: 'wasm' | 'webgpu' | 'unknown'
  modelLoadMs: number | null
  captureCropWidth: number | null
  captureCropHeight: number | null
  /** The FULL captured frame's own pixel dimensions (P79 §6), before any card-rect crop — lets a
   *  real-device retest distinguish "the camera stream itself is low-resolution" from "the crop
   *  math shrank a perfectly good frame." Null for a picked file (no live camera stream). */
  captureFrameWidth: number | null
  captureFrameHeight: number | null
  /** Whether the P79 rectification step found a real card boundary (true) or fell back to the
   *  plain guide rectangle unchanged (false) — never a crash either way. */
  rectificationUsed: boolean
  visualEmbeddingCreated: boolean
  embeddingNorm: number | null
  indexVersion: string | null
  indexCardCount: number | null
  indexSourceProjectRef: string | null
  /** P87 §15: the loaded generation's own declared identity fields — makes a stale index
   *  impossible to hide from a screenshot/diagnostics paste, alongside indexContentId below. */
  indexModelRevision: string | null
  indexGeneratedAt: string | null
  indexEmbeddingsSha256: string | null
  /** P87 F-01: the content-addressed id of the generation actually loaded this session — the
   *  field that makes a stale index impossible to hide (see current.json/generations/<id>). Null
   *  before the index has loaded (or if it never becomes available). */
  indexContentId: string | null
  /** P97 (D-106): the loaded index's resolved prototype count (1 on a v1/pre-P97 index), the
   *  auxiliary-prototype strategy name (null on v1), and the total row count actually decoded
   *  (`cardCount * prototypeCount`). Diagnostics-only — the matcher always sees one score per
   *  canonical card regardless of prototype count. Null before the index has loaded. */
  indexPrototypeCount: number | null
  indexPrototypeStrategy: string | null
  indexRowCount: number | null
  /** P87 F-22: which source project THIS deployment expects the index to resolve against
   *  (derived from `VITE_SUPABASE_URL`), or null when this deployment itself has no real hosted
   *  project configured (the local/CI-placeholder case, where nothing is gated). */
  indexSourceProjectExpected: string | null
  /** P87 F-22: whether `indexSourceProjectRef` matched `indexSourceProjectExpected`. Null when
   *  there was nothing to compare (no expectation configured, or no index loaded at all) — never
   *  fabricated as true/false in that case. */
  indexSourceProjectMatch: boolean | null
  /** P87 §6: whether the loaded generation's embeddings were independently re-hashed at load time
   *  and found to match `manifest.embeddingsSha256` (WebCrypto SHA-256 over the fetched bytes,
   *  not merely trusting the byte-for-byte identical manifest field). Null before the index has
   *  loaded. */
  indexRuntimeChecksumVerified: boolean | null
  /** Milliseconds the runtime SHA-256 re-hash actually took (P87 §6) — measured once per newly
   *  loaded generation, never repeated per scan. Null before the index has loaded. */
  indexRuntimeChecksumMs: number | null
  indexLoadMs: number | null
  indexSearchMs: number | null
  topVisualCandidates: { cardId: string; similarity: number; name: string | null }[]
  /** Up to 20 raw visual neighbours (P79 §10 shortlist inspection) — populated only in debug
   *  sessions (the search itself only widens past the production top-30 shortlist when
   *  `?scannerDebug=1` is set); empty outside debug mode, never used for matching either way.
   *  Carries `imageBaseUrl` (ordinary catalog thumbnail data, never a captured photo) so the
   *  debug panel can render real thumbnails instead of a name-only list. */
  topVisualCandidatesExtended: {
    cardId: string
    similarity: number
    name: string | null
    imageBaseUrl: string | null
  }[]
  ocrNameSignal: string | null
  ocrCollectorSignal: string | null
  /** Which adaptive-ROI layout candidate (roi.ts's `id`, e.g. "modern-full-width") won the name
   *  field this scan (P80 §7) — null when no candidate produced anything usable. */
  ocrNameRoiId: string | null
  /** Same as `ocrNameRoiId` for the collector-number field. */
  ocrNumberRoiId: string | null
  /** P85 §11 OCR debugger: every ROI/preprocess/segmentation attempt considered this scan — empty
   *  outside a debug session (the search itself never records trials unless debug is set, so
   *  there is nothing extra to show even if this were populated unconditionally). Diagnostics
   *  only: the winner here is always identical to `ocrNameRoiId`/`ocrNumberRoiId` above; nothing
   *  on this list feeds back into matching. */
  ocrTrials: {
    field: 'name' | 'number'
    roiId: string
    preprocess: 'contrast' | 'binarize'
    segmentation: 'single-line' | 'multi-line'
    text: string
    confidence: number
    plausibilityScore: number
    isWinner: boolean
  }[]
  /** True when the visible candidate shortlist widened past the normal 5 because the ranking near
   *  the cutoff was flat/ambiguous (P80 §6 — the Shieldon rank-6 real-device case). */
  candidateExpansionTriggered: boolean
  finalRerankedCandidates: {
    cardId: string
    name: string
    confidenceTier: ScannerConfidence
    reasons: readonly string[]
  }[]
  visualError: string | null
  /** P88 §21 — the calibrated tier (visual-evidence.ts's `visualEvidenceTier`) of the STRONGEST
   *  visual similarity found this scan, independent of which candidate it belongs to. Lets a real-
   *  device report say "this scan's visual channel was in the 0.10-0.19 catastrophic-defect band"
   *  instead of a bare cosine number nobody can calibrate by eye. Null when no visual hit exists. */
  visualCalibrationBand: 'strong' | 'moderate' | 'weak' | 'none' | null
  /** P88 §8/§21/F-12: the winning OCR read's own Tesseract confidence for each field — the exact
   *  number `engine.ts`'s `ocrTextReliability` weighted this scan's evidence by. Null when nothing
   *  usable was read for that field. */
  ocrNameConfidence: number | null
  ocrCollectorConfidence: number | null
  /** P88 §21: the collector-number field's structural parse confidence (collector-parse.ts) —
   *  distinguishes "read something, and it looks like a real printed id" from "read something
   *  that merely parses." Null when nothing was read for the field. */
  ocrCollectorParseConfidence: 'high' | 'medium' | 'low' | 'none' | null
  /** P88 §21/§11-§12: the local name-lexicon's fuzzy-match resolution for this scan's OCR name
   *  reading, when a lexicon is wired in. Both null this release — the fuzzy lexicon resolver
   *  (name-lexicon.ts) ships tested but unwired into production retrieval/scoring (no real
   *  production-scale lexicon exists without hosted Supabase credentials; see
   *  scripts/scanner-name-lexicon/build-lexicon.ts). Present now so a FUTURE session that wires it
   *  in needs no new diagnostics field. */
  ocrNameLexiconMatch: string | null
  ocrNameLexiconMargin: number | null
  /** P88 §4/§21/F-26: true when the text-only best candidate and the visual-only best candidate
   *  disagreed meaningfully this scan (engine.ts's 'visual-text-disagreement' note). */
  visualTextDisagreement: boolean
  /** P88 §21: WHY the tier was capped below what the raw top score alone would have implied, when
   *  it was — 'runner-up-margin-small' (ambiguous ranking), 'visual-text-disagreement' (F-26), or
   *  'visual-dominance-guarded' (F-02's guard discounted the coincidental-text top candidate).
   *  Null when nothing capped the tier this scan. */
  tierCapReason:
    'runner-up-margin-small' | 'visual-text-disagreement' | 'visual-dominance-guarded' | null
  /** Backend-attempt diagnostics (P78 prompt §4/§11/§12) — what was actually tried, present
   *  whether the visual channel ended up ready or unavailable. */
  visualBackendRequested: 'auto' | 'wasm' | 'webgpu'
  visualBackendAttempts: {
    webgpu: 'success' | 'failed' | 'not-available' | 'not-attempted'
    wasm: 'success' | 'failed' | 'not-available' | 'not-attempted'
  }
  webgpuError: string | null
  wasmError: string | null
  processorLoad: 'success' | 'failed' | null
  modelLoad: 'success' | 'failed' | null
  indexLoadStatus: 'success' | 'failed' | 'not-reached' | null
  /** P81 §3/§17: per-phase cold-start attribution from the worker's most recent init (ready OR
   *  unavailable) — null before the worker has ever reported either. Persists across scans within
   *  one session (init runs once per worker lifetime, not per scan), unlike the rest of this
   *  per-scan diagnostics object. */
  visualPhaseTimings: VisualPhaseTimings | null
  /** Wall-clock duration of the FIRST successful visual embed+search round trip this session (P81
   *  §3/§17 FIRST_EMBED_MS) — the warm per-scan cost, distinct from cold model/index load. Null
   *  until one has completed. */
  firstEmbedMs: number | null
  /** Best-effort heuristic (P81 §17 ASSET_CACHE_STATUS) — see phase-timing.ts's
   *  `estimateAssetCacheStatus` for exactly what this can and cannot prove. */
  assetCacheStatus: AssetCacheStatusEstimate
  /** Whether {@link ScannerUiController.prewarm} was ever called this session (P81 §6/§17). */
  visualPrewarmStarted: boolean
  /** Whether the visual model/index were ALREADY ready (prewarm had already completed) by the
   *  time THIS scan's analyzeCapture call began (P81 §6/§17) — the field that proves whether
   *  route-entry prewarming actually beat the user to the shutter on a given scan. */
  visualPrewarmReadyBeforeCapture: boolean
  /** Wall-clock duration of the session's own OCR engine warm-up (Tesseract worker creation),
   *  timed from the controller's prewarm path (P81 §17 OCR_PREPARE_MS) — null before prewarm has
   *  run, e.g. if the user captured before the OCR stagger fired (analyze.ts's own
   *  `engine.prepare()` call inside `runOcrAnalysis` still warms it correctly either way; this
   *  field just may not have observed that first-hand in that specific race). */
  ocrPrepareMs: number | null
  /** P82 §2-§6/§20: whether the worker's OWN module evaluation ever reported in at all — a worker
   *  constructed but never even posting `worker-module-evaluated` (P82 §5) points at script
   *  fetch/parse/module-graph-evaluation cost, not model/index loading. */
  workerBooted: boolean
  /** Milliseconds from Worker construction to its `worker-module-evaluated` progress message; null
   *  until that message has arrived. */
  workerBootMs: number | null
  /** Most recent live progress phase the worker has reported (P82 §2-§6), or null if none has
   *  arrived yet at all — the exact gap P81's terminal-only phase timings left unfilled. */
  visualCurrentPhase: string | null
  /** Milliseconds since {@link visualCurrentPhase} was entered, computed live at read time. */
  visualCurrentPhaseElapsedMs: number | null
  /** Milliseconds since the most recent progress message of any kind arrived — identical to
   *  `visualCurrentPhaseElapsedMs` today; a distinct field because the debug contract names both. */
  visualLastProgressMsAgo: number | null
  /** P82 §17-§19: readiness of the FAST baseline (OCR text recognition) — this is what an honest
   *  "Preparing card recognition…" message should gate on, not the heavyweight DINO visual
   *  channel, so a first scan is never blocked on a still-cold ~45MB model/index download. */
  fastScannerState: 'not-loaded' | 'loading' | 'ready' | 'failed'
  /** Same value as `fastScannerState` today (the fast baseline IS the OCR runtime — see
   *  docs/SCANNER_RESEARCH.md §7e for why a perceptual-hash retrieval channel was evaluated and
   *  NOT added as a second fast signal), kept as its own named field for the debug contract's
   *  OCR_RUNTIME_STATE label. */
  ocrRuntimeState: 'not-loaded' | 'loading' | 'ready' | 'failed'
  /** P82 §17-§19: the (renamed, same-value) enhanced/heavyweight visual channel's own state —
   *  identical to `visualModelState`, kept as a second named field so the debug contract's
   *  ENHANCED_VISUAL_STATE label reads as its own concept rather than reusing the older name. */
  enhancedVisualState: 'not-loaded' | 'loading' | 'ready' | 'failed'
  /** N-08 (P94): how many ids the visual shortlist found that the text search DIDN'T already have
   *  (before enrichment/filtering) — null when no visual hits existed this scan, 0 when every
   *  visual hit was already among the text candidates (nothing needed enriching). Computed for
   *  free from data the pipeline already produces; no extra query. */
  visualUnknownIdCount: number | null
  /** N-08: of `visualUnknownIdCount`, how many actually resolved through `getCardsByIds` (active,
   *  correct language) and joined the candidate set. Null under the same condition as above. */
  visualEnrichedIdCount: number | null
  /** N-08: `visualUnknownIdCount - visualEnrichedIdCount` — ids the visual index found that never
   *  became a candidate at all, whatever the reason (inactive, wrong language, or a stale/missing
   *  catalog row). This is the aggregate count this codebase's own N-07 finding warned against
   *  hiding behind a single "found" boolean; a specific card's own reason is available on demand
   *  via the debug tool's `enrichmentStatus` ({@link ExpectedCardRank}), not computed per-scan for
   *  every candidate (that would cost an extra unfiltered query every scan for information ordinary
   *  matching never needs). Null under the same condition as `visualUnknownIdCount`. */
  visualMissingIdCount: number | null
}

/**
 * Debug-only, memory-only image previews of the MOST RECENT scan (P79 §4): object URLs, never
 * uploaded, never persisted beyond this component's render lifetime, revoked the moment the next
 * scan replaces them or the controller disposes. A null field means that stage never ran (e.g.
 * the full-frame OCR fallback path never produced ROI crops) — never a fabricated placeholder.
 */
/**
 * Debug-only diagnostic (P84, ported P87): re-ranks the MOST RECENT scan's query embedding
 * against the FULL decoded visual index for one candidate card, without re-embedding or making a
 * second scan. Never persists the expected card's identity, never auto-adds anything, never
 * uploads anything — a pure read over an already-in-memory query vector. See
 * {@link ScannerUiController.getExpectedCardRank}'s own doc for the debug-mode gating contract.
 */
export interface ExpectedCardRank {
  readonly found: boolean
  readonly rank: number | null
  readonly similarity: number | null
  readonly totalCards: number
  readonly inTop20: boolean
  readonly inTop100: boolean
  /** The content-addressed generation this rank was computed against (P87 F-01) — lets the owner
   *  confirm which index generation a diagnostic reading actually came from. */
  readonly indexContentId: string | null
  /** P90 §21: where this card would rank against the FULL hybrid (text + visual) scoring for the
   *  most recent scan's actual OCR/visual evidence — null when no scan has produced usable
   *  evidence yet this session, distinguishing "not computed" from "ranked last." Reuses the exact
   *  scoring/visual-dominance-guard logic `matchScannerObservation` runs in production
   *  (`rankScannerCandidatesFull`), never a separate/approximated calculation. */
  readonly hybridRank: number | null
  readonly hybridScore: number | null
  /** The REAL production tier this exact scenario would produce ('high'/'medium'/'low'/'none'),
   *  ONLY when the card ranks inside the visible top N (`SCORING_TIERS.maxReturnedCandidates`) —
   *  null otherwise rather than fabricating a tier for a candidate production would never surface.
   *  Deliberately a plain string, not the domain's `ScannerConfidenceTier` — this module stays
   *  independent of domain types, same principle as {@link ScannerConfidence} above. */
  readonly hybridTier: 'high' | 'medium' | 'low' | 'none' | null
  /** Which scoring signals matched for this card this scan (e.g. 'name-exact',
   *  'collector-number-exact', 'visual-strong') — the same reason codes engine.ts's own scoring
   *  attaches, not a re-derived summary. Empty when the card scored zero evidence. */
  readonly scoreComponents: readonly string[]
  /** N-08 (P94): WHY this card does or doesn't have real evidence to score, distinguishing "the
   *  visual index never found this card at all" (`not-in-index`) from "the visual index found it,
   *  but ordinary catalog enrichment filtered it out" (`inactive-filtered`/`language-filtered`/
   *  `missing-catalog-row`) — previously indistinguishable everywhere in the scanner's
   *  diagnostics. `resolved` means it's a real, scoreable candidate (whether or not it also came
   *  from the text search). Never `null`: always computed once `found`/`rank`/`similarity` are. */
  readonly enrichmentStatus:
    'not-in-index' | 'resolved' | 'inactive-filtered' | 'language-filtered' | 'missing-catalog-row'
}

export interface ScannerDebugImages {
  /** The plain crop-to-guide-rect image, BEFORE rectification — the "what the guide alone saw"
   *  comparison baseline. */
  rawCropUrl: string | null
  /** The canonical image actually handed to OCR and the visual channel. */
  rectifiedUrl: string | null
  nameRoiUrl: string | null
  numberRoiUrl: string | null
}

/** The bounded still frame handed to the engine — an in-memory JPEG blob plus pixel dimensions
 *  and the pixel rectangle of the physical card inside the frame (prompt §10). Nothing here is
 *  persisted anywhere; ownership passes to the callee for the duration of the call only, and the
 *  UI disposes it as soon as analysis answers. */
export interface ScannerCapture {
  blob: Blob
  width: number
  height: number
  /** Physical-card rectangle in THIS frame's pixel space. Always present — recognition must
   *  never guess geometry. */
  cardRect: PixelRect
}

export interface ScannerSearchQuery {
  name: string
  collectorNumber?: string
}

/** One selectable printing of an identified card (prompt §22): recognition resolves cards.id;
 *  the financial identity is a card_variants.id chosen from the card's ACTIVE variants using
 *  their actual attributes — never inferred from the photo. */
export interface ScannerVariantChoice {
  id: string
  label: string
}

/** One confirmed line waiting in the in-memory scan batch. Deliberately photo-free: once a card
 *  is confirmed, its captured image is disposed (prompt §21) — the batch carries identity. */
export interface ScannedBatchCard {
  candidate: ScannerCandidate
  /** The canonical card_variants.id selected at confirmation — REQUIRED before any save. */
  variantId: string
  variantLabel: string
  quantity: number
  condition: CardCondition
  /** Stable per-item idempotency key (D-096). Generated ONCE when the logical card enters the
   *  batch; survives editing condition/quantity, partial save retry, transport retry. Changes
   *  only if the user removes the item and scans/adds a new one. */
  requestKey: string
  /** Set when a previous commit attempt left this item's server outcome UNKNOWN (interrupted
   *  transport): shown prominently; never auto-retried (prompt §30). */
  needsVerification?: boolean
}

/** What the real acquisition call receives for each batch entry (mapped onto the existing
 *  add-card acquisition path — no new financial semantics are invented on this seam). */
export interface ScannerCommitItem {
  candidateId: string
  variantId: string
  quantity: number
  condition: CardCondition
  /** Client-generated idempotency key for server-side retry deduplication (D-096). */
  requestKey: string
}

/** Outcome of ONE item's commit attempt (prompt §29/§30/§31). */
export type ScannerCommitOutcomeStatus =
  /** The RPC answered successfully — the holding exists. Never resubmitted on retry. */
  | 'added'
  /** The server definitively rejected it (validation/constraint). Retryable after editing. */
  | 'failed'
  /** The connection broke before an answer: the card MAY already be saved. Marked for manual
   *  verification against the Portfolio; deliberately NOT auto-retried. */
  | 'needs_verification'

export interface ScannerCommitOutcome {
  index: number
  status: ScannerCommitOutcomeStatus
  message: string | null
}

export interface ScannerCommitResult {
  addedCount: number
  /** Per-input-item outcomes, aligned by index with the commitBatch call's items array. */
  outcomes: ScannerCommitOutcome[]
}

/**
 * The narrow seam every scanner screen talks through. The integrated adapter implements all of
 * it against the real engine/catalog/acquisition paths; tests inject mocks of this interface.
 */
export interface ScannerUiController {
  /** F-05 (P89): `signal` is best-effort cooperative cancellation — checked between pipeline
   *  stages (after rectification, after the OCR/visual race, after candidate retrieval) so a
   *  cancelled analysis skips remaining work instead of running matching/scoring to completion
   *  for a result nobody will see. It cannot interrupt an already-in-flight OCR/visual call; the
   *  caller's own generation-ref discipline is what guarantees a stale result never reaches the
   *  UI regardless of whether this signal actually shortened the work. */
  analyzeCapture(frame: ScannerCapture, signal?: AbortSignal): Promise<ScannerAnalysis>
  searchFallback(query: ScannerSearchQuery): Promise<ScannerCandidate[]>
  /** Active printing choices for an identified card (fetched ONLY after the user picks the
   *  candidate — prompt §22/I6). Empty means the card has no active variant to add. */
  listVariantChoices(cardId: string): Promise<ScannerVariantChoice[]>
  /** Commits the whole reviewed batch through the real acquisition path. Nothing is written by
   *  anything else in the scanner. Per-item isolation: one failure never aborts the rest. */
  commitBatch(items: ScannerCommitItem[]): Promise<ScannerCommitResult>
  /** Releases the session's OCR worker and any retained engine resources. Called reliably on
   *  route exit/unmount (prompt §8/I16). Idempotent. */
  dispose(): void
  /** Diagnostics for the most recent {@link analyzeCapture} call, or null before any scan has
   *  run (P77 prompt §13/§40). Optional so existing/mock controllers stay valid without it. */
  getLastDiagnostics?(): ScannerDiagnostics | null
  /** Debug-only image previews for the most recent {@link analyzeCapture} call (P79 §4), or null
   *  before any scan has run / outside debug mode. Optional for the same reason as above. */
  getLastDebugImages?(): ScannerDebugImages | null
  /** P81 §6: begins warming the visual (and, staggered, OCR) recognition runtime in the
   *  background — call on scanner route entry, BEFORE any capture exists. Idempotent, never
   *  throws, never blocks the caller (fire-and-forget). Optional for mock-controller
   *  compatibility, same discipline as the other optional members above. */
  prewarm?(): void
  /** Current visual-channel readiness (P81 §7) for driving an honest loading indicator before the
   *  model/index have finished loading. Optional for the same reason as above. Naming note (P82):
   *  this reports the HEAVYWEIGHT/enhanced DINO channel specifically — {@link getFastScannerState}
   *  is what the intro screen should gate its own loading copy on instead. */
  getVisualPrewarmState?(): 'not-loaded' | 'loading' | 'ready' | 'failed'
  /** Debug-only (P84, ported P87): re-ranks the most recent scan's cached query vector against
   *  the full visual index for `cardId`, without re-embedding. Resolves `null` immediately,
   *  WITHOUT ever calling the visual client/worker, outside `?scannerDebug=1` — this is a debug
   *  tool, never a production matching path. Also resolves `null` when no scan has produced a
   *  query vector yet this session, or when the visual channel/index is unavailable. Never adds,
   *  saves, or uploads anything. Optional for the same reason as the other optional members above. */
  getExpectedCardRank?(cardId: string): Promise<ExpectedCardRank | null>
  /** P82 §17-§19: readiness of the FAST (OCR) baseline — reaches 'ready' far sooner than
   *  {@link getVisualPrewarmState} on a cold device, since it does not depend on the ~45MB DINO
   *  model/index. Optional for the same reason as the other diagnostic getters above. */
  getFastScannerState?(): 'not-loaded' | 'loading' | 'ready' | 'failed'
}
