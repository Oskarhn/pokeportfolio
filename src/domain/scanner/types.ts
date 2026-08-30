/**
 * Scanner matching types (M15, P67).
 *
 * The matcher sits between an OCR/visual observation layer (not built here) and the EXISTING
 * canonical catalog identity (`cards.id` / `card_variants.id` — DATA_MODEL.md §3.1). It never
 * creates a second card identity system: every candidate it returns IS a `cards` row already in
 * the shared catalog.
 *
 * Layer boundary: this directory is pure domain. It knows nothing about OCR engines, cameras,
 * Supabase or React — see docs/ARCHITECTURE.md §2. Raw observation strings are untrusted text
 * and are treated as such: parsed conservatively, never executed, never rendered as HTML by
 * anyone downstream (SECURITY rule; P67 §25).
 */

/** Catalog language, mirroring `card_sets.language` ('en' | 'ja'). Japanese sets are separate
 *  rows with separate numbering (DATA_MODEL.md §3.2) — language is evidence, not identity. */
export type ScannerLanguage = 'en' | 'ja'

/**
 * Structured noisy observation of one physical card. Every field is optional and untrusted:
 * OCR text can be empty, misread or absent entirely. No image blobs cross this boundary —
 * text signals only.
 */
export interface ScannerObservation {
  /** Name as read off the card, e.g. "Pikachu", "Flabéb é", "P1kachu". May contain junk. */
  readonly rawNameText?: string | null
  /** Collector/local number region text, e.g. "123/198", "TG01", "SV0 01", "4/102". */
  readonly rawCollectorNumberText?: string | null
  /** Set name fragment if the capture produced one, e.g. "Surging Sparks". Weak evidence. */
  readonly rawSetText?: string | null
  /** Language hint: 'en' | 'ja' or a free-text form like "English"/"Japanese". */
  readonly languageHint?: string | null
  /**
   * RESERVED extension seam for a future visual-evidence channel (P67 §23). V1 scoring ignores
   * it entirely; its presence must never change a result. P65 decides whether M15 needs real
   * perceptual evidence — this field exists so adding that channel later is not a rewrite.
   */
  readonly visualSimilarity?: number | null
}

/** One parsed collector/local number: prefix + digit run + suffix, plus the "/total" when one
 *  was present and purely numeric. Mirrors how `cards.local_id` is actually stored
 *  (DATA_MODEL.md §3.1: "SV049", "TG12", "H31", "001/165"). */
export interface ParsedCollectorNumber {
  /** Uppercase letters before the digit run, '' when none ("TG" for TG01). */
  readonly prefix: string
  /** Digit run's numeric value — leading zeros folded ("001" → 1). */
  readonly numeric: number
  /** Digit run exactly as observed ("001"), so zero-padding stays inspectable. */
  readonly numericText: string
  /** Letters after the digit run, '' when none. */
  readonly suffix: string
  /** Total from a trailing "/198" when present AND purely numeric; null otherwise
   *  (e.g. "TG01/TG30" carries no parseable total — the right side is another local id). */
  readonly total: number | null
  /** Cleaned original text, kept for debuggability of rankings; never compared. */
  readonly raw: string
}

export interface ParsedScannerSignals {
  /** Normalized name used for comparison; null when too short/junk to be usable. */
  readonly normalizedName: string | null
  readonly collectorNumber: ParsedCollectorNumber | null
  /** Normalized set-name hint for comparison; null when absent/too short. */
  readonly setHint: string | null
  readonly languageHint: ScannerLanguage | null
}

/**
 * One candidate row from the shared catalog — the printing identity a scan must resolve to.
 * Shape mirrors what the existing `search_cards` RPC already returns via src/data/catalog.ts;
 * the scanner data adapter owns that mapping, the domain never queries anything.
 */
export interface ScannerCandidateRecord {
  readonly cardId: string
  readonly name: string
  /** Collector number as printed/stored, e.g. "4", "TG01", "001/165". */
  readonly localId: string
  readonly rarity: string | null
  readonly category: string | null
  readonly illustrator: string | null
  readonly imageBaseUrl: string | null
  readonly language: ScannerLanguage
  readonly setId: string
  readonly setName: string
  /** Active variant rows on this card (informational only — see variantBoundary below). */
  readonly variantCount: number
}

/** Stable machine-readable reason codes. UI may map them to copy; they exist primarily so a
 *  wrong ranking can be debugged after the fact (P67 §15). */
export type ScannerReasonCode =
  | 'collector-number-exact'
  | 'collector-number-ocr-folded'
  | 'collector-number-numeric-only'
  | 'name-exact'
  | 'name-close'
  | 'name-partial'
  | 'set-exact'
  | 'set-close'
  | 'language-match'
  | 'language-mismatch'
  | 'no-number-signal'
  | 'no-name-signal'
  | 'insufficient-signal'
  /** On-device visual embedding evidence (P76, D-097) — a separate channel from OCR text. */
  | 'visual-strong'
  | 'visual-moderate'
  | 'visual-weak'

/** A ranked candidate: the canonical printing identity plus explainable evidence. */
export interface RankedScannerCandidate {
  readonly card: ScannerCandidateRecord
  /** Deterministic 0–100 explainable score. Not a probability; see engine.ts weight table. */
  readonly score: number
  readonly reasons: readonly ScannerReasonCode[]
  /** Raw cosine-similarity evidence for this candidate, when the visual channel ran (P76).
   *  Informational/diagnostic only — never re-derived into a fake percentage in the UI. */
  readonly visualSimilarity?: number | null
}

/** Per-candidate visual-embedding evidence keyed by `cards.id` (P76, D-097). Produced by the
 *  on-device retrieval worker; consumed only by the domain ranker, which decides how much it is
 *  worth — the worker itself makes no identity decision. */
export type VisualEvidenceByCard = ReadonlyMap<string, number>

/** Confidence tier. HIGH means "safe to preselect" — NEVER "already added": nothing in this
 *  module mutates the Portfolio (P67 §16). Even at HIGH the user confirms in the review step
 *  (UX_FLOWS F12). */
export type ScannerConfidenceTier = 'high' | 'medium' | 'low' | 'none'

export interface ScannerMatch {
  readonly tier: ScannerConfidenceTier
  /** Sorted by score desc then cardId asc — stable for equal input, deduplicated. Bounded. */
  readonly candidates: readonly RankedScannerCandidate[]
  readonly signals: ParsedScannerSignals
  /** Match-level explanation codes (ambiguity demotions, insufficient signal). */
  readonly notes: readonly ScannerNoteCode[]
}

export type ScannerNoteCode =
  | 'runner-up-margin-small'
  | 'single-candidate'
  | 'insufficient-signal'
  /** The text-only top candidate and the visual-only top candidate disagreed (P76 §33/§35):
   *  same/similar artwork across printings, or a genuine misread. Surfaced for diagnostics; the
   *  score/margin logic is what actually demotes confidence, not this flag by itself. */
  | 'visual-text-disagreement'
