/**
 * Deterministic scanner matching engine (P67 §14–§15, §17; redesigned P93/D-106).
 *
 * Pure ranking over catalog records the data layer has already retrieved. No network, no React,
 * no randomness, no object-iteration-order dependence — equal input always produces an equal,
 * stably ordered result.
 *
 * ── Scoring model ────────────────────────────────────────────────────────────────────────────
 * Additive explainable points. Weights encode how identifying each piece of printed text
 * actually is on a real Pokémon card:
 *
 * - Collector/local id EXACT (45): within its set a printed number identifies exactly one card,
 *   so this is the single strongest text signal — but NOT globally unique: the same local id
 *   recurs across every set ("4/102" exists in dozens of sets), so alone it can never certify.
 * - Id matched only after OCR folding (30) / numeric-part-only (25): progressively weaker
 *   versions of the same fact.
 * - Name EXACT (30): strong but deliberately weaker than the id — popular Pokémon have many
 *   printings, and Trainer cards reuse names aggressively.
 * - Name CLOSE (22) / PARTIAL (8): OCR-tolerant versions.
 * - Set EXACT (15) / CLOSE (8): supporting weight; sets are unique but hints arrive garbled.
 * - Language mismatch −12: a real disagreement argues AGAINST the candidate (a Japanese card
 *   will not read "Surging Sparks"). Agreement no longer earns points (P93/§20/N-09's audit) —
 *   see `SCORING_WEIGHTS`'s own doc for why.
 *
 * The arithmetic itself enforces the prompt's uniqueness rules (P67 §9): name-exact alone tops
 * out at 30 → LOW; id-exact alone reaches 45 → LOW/MEDIUM at best; HIGH requires the composition
 * of id + name (+set), i.e. genuinely convergent printed evidence.
 *
 * ── P93 redesign: rank score vs. display score (N-05) ───────────────────────────────────────────
 * `rawRankScore` is unclamped and is the ONLY value ordering/margin/tier logic uses. `score` is a
 * clamped-to-[0,100] DISPLAY value derived from it afterward, never the reverse — a well-
 * corroborated visual anchor can legitimately raw-score above 100 (more evidence, not an
 * overflow bug), and a language mismatch with nothing else can legitimately raw-score below 0.
 * Two candidates that both happened to clamp to the SAME display value under the old design could
 * produce a zero margin and fall back to alphabetic-by-cardId ordering — a wrong card could then
 * display as rank #1 purely because its UUID sorted first (P92 finding N-05). Sorting on the full-
 * resolution raw score removes that failure mode structurally: it is astronomically unlikely for
 * two genuinely different pieces of evidence to sum to the exact same raw integer.
 *
 * ── P93 redesign: visual-anchor reliability, not an absolute dominance guard (N-01/N-04) ────────
 * P88's `applyVisualDominanceGuard` discounted every OTHER candidate's text score by a fixed
 * factor whenever some candidate's OWN similarity crossed one absolute threshold (0.82) — a
 * discontinuous, all-or-nothing guard with two structural problems P92's audit found: (1) its
 * only escape hatch required a text signal production can never produce (a set-name OCR channel
 * that does not exist — `rawSetText` is always null, see controller.ts), and (2) the 0.82
 * activation threshold sat ABOVE P84's own measured MEAN genuine-match similarity (0.812), so an
 * entirely ordinary correct scan could land on the wrong side of the cliff by sampling noise
 * alone — and once triggered by a false spike, the guard could make the TRUE card's evidence
 * strictly worse than having no guard at all.
 *
 * `computeVisualAnchorReliability`/`applyVisualAnchorReliability` replace it with additive,
 * reliability-weighted evidence that NEVER discounts any candidate — it only ever ADDS a
 * corroboration boost to the single candidate the visual channel most confidently supports (the
 * "anchor": whichever candidate has the highest finite similarity this scan), scaled by two
 * continuous signals: how far into calibrated same-card territory that similarity itself sits
 * (reusing `visualEvidencePoints`'s own continuous curve — no second calibration to drift out of
 * sync), and how much CLEARER the anchor is than the next-best visual candidate (a lone,
 * unseparated spike earns little boost; a well-separated one earns close to the maximum). Because
 * no candidate's score is ever reduced by this mechanism, it cannot reproduce N-01's failure mode
 * #3 (a guard making a true card's own evidence worse than not having one) by construction — the
 * worst case is simply "no boost applied," identical to not having the mechanism at all.
 */
import { compareCollectorNumber } from './collector-compare'
import { parseCollectorNumber } from './collector-number'
import { parseCollectorNumberStructured, type CollectorParseConfidence } from './collector-parse'
import { compareNames } from './name-similarity'
import { normalizeCardText, parseLanguageHint } from './normalize'
import { compareSetHint } from './set-hint'
import { VISUAL_EVIDENCE_CURVE, visualEvidencePoints, visualEvidenceTier } from './visual-evidence'
import type {
  ParsedScannerSignals,
  RankedScannerCandidate,
  ScannerCandidateRecord,
  ScannerConfidenceTier,
  ScannerMatch,
  ScannerNoteCode,
  ScannerObservation,
  ScannerReasonCode,
  VisualEvidenceByCard,
} from './types'

/**
 * Documented weight table (points). Exported so tests pin the model's intent — these numbers
 * ARE the scoring contract, not opaque magic (P67 §14).
 */
export const SCORING_WEIGHTS = {
  /** Printed local id matches exactly (padding-insensitive) — strongest single signal. */
  collectorNumberExact: 45,
  /** Matches only after the conservative O/I/L/S digit fold — plausible OCR recovery. */
  collectorNumberFolded: 30,
  /** Numeric portion matches, prefix/suffix differ — same number, uncertain sub-form. */
  collectorNumberNumericOnly: 25,
  /** Normalized names identical. Many printings share a name; weaker than an exact id. */
  nameExact: 30,
  /** Within the OCR tolerance for the name's length. */
  nameClose: 22,
  /** One side contains the other — partial reads like "Pika" inside "Pikachu". */
  namePartial: 8,
  /** Set-name hint equals the candidate's set name. */
  setExact: 15,
  /** Set-name hint close to (or contained in) the candidate's set name. */
  setClose: 8,
  /**
   * P93/§20/N-09 — audited via a full call-flow trace, not assumed: `controller.ts` derives
   * `languageHint` from `scannerSessionStore`, whose `language` field's TYPE is the literal `'en'`
   * (session-store.ts — V1 is English-only by design, not merely by convention), and BOTH
   * `retrieveScannerCandidates` (text search) and the visual-shortlist enrichment path
   * (`getCardsByIds`) pass that same `'en'` as an explicit server-side filter. Every candidate
   * that can ever reach this scorer in production therefore already has `card.language === 'en'`
   * — agreement is guaranteed, not evidence, and used to inflate every candidate's score
   * UNIFORMLY (never changing relative ranking, but capable of pushing a scan's absolute score
   * across a tier boundary on a fabricated +5 that discriminated nothing). Agreement earns ZERO
   * points now. A genuine MISMATCH remains real, if currently unreachable, evidence AGAINST a
   * candidate (a future non-English catalog widening, or a data anomaly that let a foreign-
   * language row leak past the filter, would still be worth penalizing) — kept, not removed.
   */
  languageMismatchPenalty: 12,
} as const

/** Score bands and ambiguity margins. Exported and pinned by tests like the weights. Compared
 *  against `rawRankScore` (P93/N-05) — the full-resolution, unclamped total — never the clamped
 *  display score, so a well-corroborated visual anchor's raw score above 100 still reads as
 *  unambiguously HIGH rather than being truncated away before the tier check ever sees it. */
export const SCORING_TIERS = {
  /** Minimum score for HIGH eligibility (before the margin check). */
  highMinScore: 80,
  mediumMinScore: 45,
  lowMinScore: 20,
  /** HIGH requires this much gap above the runner-up — near-equals stay ambiguous. */
  highMinMargin: 15,
  mediumMinMargin: 8,
  /** Upper bound on candidates the engine RETAINS after ranking (P80: raised from 5 so a correct
   *  card sitting a few ranks below the normal UI cutoff — the Shieldon real-device case, rank 6
   *  — survives into the returned array at all). This is retention depth, not display count: the
   *  UI's own visible-candidate limit lives in controller.ts and is normally still 5; it only
   *  widens toward this ceiling when the ranking near the cutoff is genuinely flat/ambiguous. */
  maxReturnedCandidates: 10,
  /** Normalized-name characters required before a name counts as a usable signal (P67 §17). */
  minNameLengthForSignal: 3,
} as const

/**
 * P88 §8/F-12 — OCR text evidence reliability. `collectorNumberExact`/`nameExact` etc. are
 * strong ONLY when the underlying OCR read itself was trustworthy; a low-confidence read that
 * happens to structurally match a candidate must not be scored identically to a clean, confident
 * one — this is exactly the "confidently wrong" gap F-12 found (OCR confidence never reached
 * engine.ts at all). `confidence` is Tesseract's own 0-100 mean-word confidence; `undefined`
 * means the caller did not supply it (every pre-P88 call site, and every existing test) and is
 * treated as full reliability — a strictly additive, backward-compatible change.
 */
const OCR_RELIABILITY_FULL_MIN = 70
const OCR_RELIABILITY_FLOOR_MAX = 15
const OCR_RELIABILITY_FLOOR = 0.4

export function ocrTextReliability(confidence: number | null | undefined): number {
  if (confidence === null || confidence === undefined || !Number.isFinite(confidence)) return 1
  const clamped = Math.max(0, Math.min(100, confidence))
  if (clamped >= OCR_RELIABILITY_FULL_MIN) return 1
  if (clamped <= OCR_RELIABILITY_FLOOR_MAX) return OCR_RELIABILITY_FLOOR
  const span = OCR_RELIABILITY_FULL_MIN - OCR_RELIABILITY_FLOOR_MAX
  const t = (clamped - OCR_RELIABILITY_FLOOR_MAX) / span
  return OCR_RELIABILITY_FLOOR + t * (1 - OCR_RELIABILITY_FLOOR)
}

/** Structural parse confidence (collector-parse.ts) discounts collector-number evidence only for
 *  a LOW-confidence shape — a bare parse success that merely LOOKS like an id ("Z7", a stray
 *  "1995") is worth less than a real printed-id shape, even at identical OCR confidence. 'medium'
 *  is the ORDINARY real-catalog shape (a bare 1-3 digit vintage id like "4", or a known
 *  multi-letter prefix like "TG01") and is NOT discounted — only 'low' (single generic letter +
 *  digit, or a bare 4+-digit run with no total, i.e. exactly the noise shapes P85 found) is.
 *  `undefined`/'none' is treated as full reliability for backward compatibility — callers that
 *  never computed a structural confidence (every pre-P88 test) behave exactly as before. */
export function structuralReliability(confidence: CollectorParseConfidence | undefined): number {
  return confidence === 'low' ? 0.55 : 1
}

/** Parses one observation into comparable signals. Junk/short fields become null — absence of
 *  evidence, never a guess. `visualSimilarity` is intentionally dropped here (reserved seam). */
export function parseScannerSignals(observation: ScannerObservation): ParsedScannerSignals {
  const normalizedNameRaw = observation.rawNameText?.trim() ?? ''
  const normalized = normalizedNameRaw === '' ? '' : normalizeCardText(normalizedNameRaw)
  const setHintRaw = observation.rawSetText?.trim() ?? ''
  const setHintNormalized = setHintRaw === '' ? '' : normalizeCardText(setHintRaw)
  const structuralConfidence = observation.rawCollectorNumberText
    ? parseCollectorNumberStructured(observation.rawCollectorNumberText).confidence
    : undefined
  return {
    normalizedName: normalized.length >= SCORING_TIERS.minNameLengthForSignal ? normalized : null,
    collectorNumber: observation.rawCollectorNumberText
      ? parseCollectorNumber(observation.rawCollectorNumberText)
      : null,
    setHint: setHintNormalized.length >= 4 ? setHintNormalized : null,
    languageHint: parseLanguageHint(observation.languageHint),
    nameReliability: ocrTextReliability(observation.nameOcrConfidence),
    collectorReliability:
      ocrTextReliability(observation.collectorOcrConfidence) *
      structuralReliability(structuralConfidence),
  }
}

/** A signal is usable when it could plausibly identify something (P67 §17 minimum thresholds).
 *  Text OR visual evidence is enough (P76 §33): OCR absence must not force NO_MATCH when the
 *  on-device visual channel found something. */
export function hasUsableSignal(
  signals: ParsedScannerSignals,
  visualScores?: VisualEvidenceByCard,
): boolean {
  if (signals.collectorNumber !== null || signals.normalizedName !== null) return true
  if (!visualScores) return false
  for (const similarity of visualScores.values()) {
    if (visualEvidenceTier(similarity) !== 'none') return true
  }
  return false
}

interface ScoredEntry {
  readonly card: ScannerCandidateRecord
  /** Unclamped sum of every TEXT weight (id/name/set/language) — never includes visual points. */
  readonly textScore: number
  /** This candidate's own visual-curve contribution (P93: `visualEvidencePoints`), before any
   *  anchor-reliability boost. 0 when this candidate has no similarity entry. */
  readonly visualPoints: number
  readonly visualSimilarity: number | null
  readonly reasons: ScannerReasonCode[]
}

function scoreCandidate(
  signals: ParsedScannerSignals,
  card: ScannerCandidateRecord,
  visualScores?: VisualEvidenceByCard,
): ScoredEntry {
  const reasons: ScannerReasonCode[] = []
  let textScore = 0

  // P88 §8/F-12: id/name evidence points are scaled by how trustworthy the underlying OCR read
  // actually was (reliability 1 when the observation supplied no confidence — every pre-P88
  // caller/test) — a low-confidence-but-structurally-plausible read no longer scores identically
  // to a clean, confident one, the "confidently wrong" gap F-12 found.
  const idEvidence = compareCollectorNumber(signals.collectorNumber, card.localId)
  if (idEvidence === 'exact') {
    textScore += Math.round(SCORING_WEIGHTS.collectorNumberExact * signals.collectorReliability)
    reasons.push('collector-number-exact')
  } else if (idEvidence === 'folded') {
    textScore += Math.round(SCORING_WEIGHTS.collectorNumberFolded * signals.collectorReliability)
    reasons.push('collector-number-ocr-folded')
  } else if (idEvidence === 'numeric') {
    textScore += Math.round(
      SCORING_WEIGHTS.collectorNumberNumericOnly * signals.collectorReliability,
    )
    reasons.push('collector-number-numeric-only')
  }

  const nameEvidence = compareNames(signals.normalizedName, card.name)
  if (nameEvidence === 'exact') {
    textScore += Math.round(SCORING_WEIGHTS.nameExact * signals.nameReliability)
    reasons.push('name-exact')
  } else if (nameEvidence === 'close') {
    textScore += Math.round(SCORING_WEIGHTS.nameClose * signals.nameReliability)
    reasons.push('name-close')
  } else if (nameEvidence === 'partial') {
    textScore += Math.round(SCORING_WEIGHTS.namePartial * signals.nameReliability)
    reasons.push('name-partial')
  }

  const setEvidence = compareSetHint(signals.setHint, card.setName)
  if (setEvidence === 'exact') {
    textScore += SCORING_WEIGHTS.setExact
    reasons.push('set-exact')
  } else if (setEvidence === 'close') {
    textScore += SCORING_WEIGHTS.setClose
    reasons.push('set-close')
  }

  if (signals.languageHint !== null) {
    if (signals.languageHint === card.language) {
      // P93/N-09: no longer scored — see SCORING_WEIGHTS's own doc. Reason code retained for
      // diagnostic legibility (a reader can still see language agreed) even though it moves zero
      // points.
      reasons.push('language-match')
    } else {
      textScore -= SCORING_WEIGHTS.languageMismatchPenalty
      reasons.push('language-mismatch')
    }
  }

  const visualSimilarity = visualScores?.get(card.cardId) ?? null
  const visualPoints = visualEvidencePoints(visualSimilarity)
  if (visualPoints > 0) {
    const visualTier = visualEvidenceTier(visualSimilarity)
    if (visualTier === 'strong') reasons.push('visual-strong')
    else if (visualTier === 'moderate') reasons.push('visual-moderate')
    else reasons.push('visual-weak')
  }

  return { card, textScore, visualPoints, visualSimilarity, reasons }
}

/**
 * P93 §6/§12 — continuous, non-negative visual-anchor reliability. Replaces P88's absolute
 * dominance guard entirely (see module doc). Returns the single candidate the visual channel most
 * confidently supports this scan (the "anchor" — highest finite similarity) plus a [0,1]
 * reliability score combining two continuous signals, or `null` when no candidate has any finite
 * similarity at all (no visual evidence this scan).
 *
 * - `strengthFactor`: how far into calibrated same-card territory the anchor's OWN similarity
 *   sits, reusing `visualEvidencePoints`'s own curve (`points / ceilingPoints`) — never a second,
 *   independently-tunable calibration to drift out of sync with the point curve itself.
 * - `marginFactor`: how much clearer the anchor is than the next-best visual candidate,
 *   saturating at `ANCHOR_MARGIN_SATURATE` similarity units (chosen from P84's own calibration:
 *   the geometry-only-distortion regime's mean true-vs-nearest-wrong margin is ~0.14 — see
 *   docs/SCANNER_RESEARCH.md §7i). A single visual candidate with nothing to compare against uses
 *   a fixed neutral factor rather than 0 (unprovably discriminative is not the same as
 *   disproven) or 1 (an unverified lone reading should not receive the SAME credit as one that
 *   has demonstrably separated itself from its neighbours).
 *
 * Critically, under P84's own catastrophic-defect calibration (same-card mean ~0.10-0.13,
 * nearest-wrong mean ~0.28-0.41 — WRONG-card similarity systematically HIGHER), `strengthFactor`
 * for whichever candidate tops that regime is already near zero (the curve itself has barely
 * begun rising by similarity 0.41), so reliability stays near zero regardless of margin — the
 * guard-equivalent mechanism stays structurally inert in exactly the regime where a real spike
 * would otherwise be most dangerous, without needing a second, separate abstention check.
 */
const ANCHOR_BOOST_MAX = 0.8
const ANCHOR_MARGIN_SATURATE = 0.12
const ANCHOR_SINGLE_CANDIDATE_MARGIN_FACTOR = 0.7
/** Below this reliability, the boost (and its diagnostic reason code) is treated as a no-op —
 *  avoids a cosmetic +0/+1-point "corroborated" label on evidence too thin to mean anything. */
const ANCHOR_RELIABILITY_MIN = 0.05

export interface VisualAnchorReliability {
  readonly cardId: string
  readonly similarity: number
  readonly reliability: number
}

export function computeVisualAnchorReliability(
  entries: readonly ScoredEntry[],
): VisualAnchorReliability | null {
  let anchor: ScoredEntry | null = null
  let runnerUpSimilarity: number | null = null
  for (const entry of entries) {
    const s = entry.visualSimilarity
    if (s === null || !Number.isFinite(s)) continue
    if (anchor === null || s > anchor.visualSimilarity!) {
      if (anchor !== null) runnerUpSimilarity = anchor.visualSimilarity
      anchor = entry
    } else if (runnerUpSimilarity === null || s > runnerUpSimilarity) {
      runnerUpSimilarity = s
    }
  }
  if (anchor === null || anchor.visualSimilarity === null) return null

  const strengthFactor = anchor.visualPoints / VISUAL_EVIDENCE_CURVE.ceilingPoints
  const marginFactor =
    runnerUpSimilarity === null
      ? ANCHOR_SINGLE_CANDIDATE_MARGIN_FACTOR
      : Math.max(0, Math.min(1, (anchor.visualSimilarity - runnerUpSimilarity) / ANCHOR_MARGIN_SATURATE))

  const reliability = Math.max(0, Math.min(1, strengthFactor * marginFactor))
  return { cardId: anchor.card.cardId, similarity: anchor.visualSimilarity, reliability }
}

/** Applies the anchor's corroboration boost (P93 §6/§12) — ADDITIVE ONLY, never touches any other
 *  candidate's score. Returns each entry's final unclamped raw score plus the visual reliability
 *  actually attributed to it (0 for every non-anchor candidate). */
function applyVisualAnchorReliability(
  entries: readonly ScoredEntry[],
): ReadonlyArray<{ entry: ScoredEntry; rawRankScore: number; visualReliability: number }> {
  const anchor = computeVisualAnchorReliability(entries)
  return entries.map((entry) => {
    const base = entry.textScore + entry.visualPoints
    if (
      anchor === null ||
      entry.card.cardId !== anchor.cardId ||
      anchor.reliability < ANCHOR_RELIABILITY_MIN
    ) {
      return { entry, rawRankScore: base, visualReliability: 0 }
    }
    const boost = Math.round(entry.visualPoints * ANCHOR_BOOST_MAX * anchor.reliability)
    return { entry, rawRankScore: base + boost, visualReliability: anchor.reliability }
  })
}

function toDisplayScore(rawRankScore: number): number {
  return Math.max(0, Math.min(100, Math.round(rawRankScore)))
}

/**
 * Ranks candidates against parsed signals plus optional per-candidate visual evidence (P76,
 * D-097). Bounded output, deterministic order — full-resolution `rawRankScore` desc, then own
 * `visualSimilarity` desc, then `cardId` asc as the FINAL exact-identity-stability fallback only
 * (P93/N-05: never the meaningful signal) — duplicates removed.
 *
 * P93 deliberately does NOT add "original retrieval-array position" as a tie-break step between
 * those two, even though it reads naturally as a candidate signal: `candidates` here is simply
 * whatever order the data layer happened to hand in, and this module has always guaranteed
 * (pinned by `tests/domain/scanner/engine.test.ts`'s "input permutation cannot change ranked
 * output" property test) that reversing that input array can never change the result. A retrieval
 * RANK (e.g. the catalog search's own relevance ordering) would be a legitimate additional signal
 * if the data layer threaded one through as an explicit field — plain array position is not the
 * same thing and would silently break that invariant instead.
 *
 * `visualScores` candidates that never appeared in the text-search pool must already be merged
 * into `candidates` by the data layer (P76 §16's hybrid retrieval) — this function only SCORES,
 * never fetches or invents identity.
 */
/**
 * P90 §21 (debug-only): the SAME dedup/score/anchor-reliability/sort pipeline
 * {@link rankScannerCandidates} uses, but returns every candidate rather than truncating to
 * `SCORING_TIERS.maxReturnedCandidates` — needed by the expected-card-rank debug tool, which must
 * report a real rank position even for a candidate production would never surface in the visible
 * top N. Never called from the production matching path (`matchScannerObservation`); reuses this
 * module's own private scoring/anchor-reliability logic so the debug tool cannot silently drift
 * from what production actually computes.
 */
export function rankScannerCandidatesFull(
  signals: ParsedScannerSignals,
  candidates: readonly ScannerCandidateRecord[],
  visualScores?: VisualEvidenceByCard,
): readonly RankedScannerCandidate[] {
  const deduped = new Map<string, ScoredEntry>()
  for (const card of candidates) {
    if (!deduped.has(card.cardId)) {
      deduped.set(card.cardId, scoreCandidate(signals, card, visualScores))
    }
  }

  const boosted = applyVisualAnchorReliability([...deduped.values()])
  const withReasons = boosted.map(({ entry, rawRankScore, visualReliability }) => {
    const reasons =
      visualReliability >= ANCHOR_RELIABILITY_MIN
        ? [...entry.reasons, 'visual-anchor-corroborated' as const]
        : entry.reasons
    return { entry, rawRankScore, visualReliability, reasons }
  })

  return withReasons
    .sort((a, b) => {
      if (b.rawRankScore !== a.rawRankScore) return b.rawRankScore - a.rawRankScore
      const aSim = a.entry.visualSimilarity ?? -Infinity
      const bSim = b.entry.visualSimilarity ?? -Infinity
      if (bSim !== aSim) return bSim - aSim
      return a.entry.card.cardId < b.entry.card.cardId
        ? -1
        : a.entry.card.cardId > b.entry.card.cardId
          ? 1
          : 0
    })
    .map(
      ({ entry, rawRankScore, visualReliability, reasons }): RankedScannerCandidate => ({
        card: entry.card,
        score: toDisplayScore(rawRankScore),
        rawRankScore,
        reasons,
        visualSimilarity: entry.visualSimilarity,
        visualReliability,
      }),
    )
}

export function rankScannerCandidates(
  signals: ParsedScannerSignals,
  candidates: readonly ScannerCandidateRecord[],
  visualScores?: VisualEvidenceByCard,
): ScannerMatch {
  if (!hasUsableSignal(signals, visualScores)) {
    return {
      tier: 'none',
      candidates: [],
      signals,
      notes: ['insufficient-signal'],
    }
  }

  const sorted = rankScannerCandidatesFull(signals, candidates, visualScores)
  const bounded = sorted.slice(0, SCORING_TIERS.maxReturnedCandidates)

  const top = bounded[0]
  const runnerUp = bounded[1]
  const notes: ScannerNoteCode[] = []
  let tier: ScannerConfidenceTier
  if (!top) {
    tier = 'none'
  } else {
    // P93/N-05: tier/margin decisions read the full-resolution rawRankScore, never the clamped
    // display score — see SCORING_TIERS's own doc.
    tier =
      top.rawRankScore >= SCORING_TIERS.highMinScore
        ? 'high'
        : top.rawRankScore >= SCORING_TIERS.mediumMinScore
          ? 'medium'
          : top.rawRankScore >= SCORING_TIERS.lowMinScore
            ? 'low'
            : 'none'
    if (runnerUp) {
      const margin = top.rawRankScore - runnerUp.rawRankScore
      if (tier === 'high' && margin < SCORING_TIERS.highMinMargin) {
        tier = 'medium'
        notes.push('runner-up-margin-small')
      } else if (tier === 'medium' && margin < SCORING_TIERS.mediumMinMargin) {
        tier = 'low'
        notes.push('runner-up-margin-small')
      }
    } else {
      notes.push('single-candidate')
    }
  }

  // P88 §4/F-26: 'visual-text-disagreement' used to be pure telemetry (no reader anywhere) — now
  // it actually caps tier. Restricted to a MEANINGFUL visual disagreement (moderate/strong tier
  // only, never 'weak'/catastrophic — prompt §3/§4: a low-quality visual read must never punish
  // otherwise-trustworthy text evidence).
  if (visualScores && visualScores.size > 0 && top) {
    let textOnlyTopCardId: string | null = null
    let textOnlyBestScore = -1
    for (const card of candidates) {
      const textOnly = scoreCandidate(signals, card)
      if (textOnly.textScore > textOnlyBestScore) {
        textOnlyBestScore = textOnly.textScore
        textOnlyTopCardId = card.cardId
      }
    }
    let visualOnlyTopCardId: string | null = null
    let visualOnlyBestSimilarity = -Infinity
    for (const [cardId, similarity] of visualScores.entries()) {
      if (similarity > visualOnlyBestSimilarity) {
        visualOnlyBestSimilarity = similarity
        visualOnlyTopCardId = cardId
      }
    }
    const visualOnlyTier = visualEvidenceTier(visualOnlyBestSimilarity)
    if (
      textOnlyTopCardId !== null &&
      visualOnlyTopCardId !== null &&
      textOnlyTopCardId !== visualOnlyTopCardId &&
      textOnlyBestScore > 0 &&
      (visualOnlyTier === 'moderate' || visualOnlyTier === 'strong')
    ) {
      notes.push('visual-text-disagreement')
      if (tier === 'high') tier = 'medium'
    }
  }

  return { tier, candidates: bounded, signals, notes }
}

/** Convenience composition: observation → signals → ranked match. */
export function matchScannerObservation(
  observation: ScannerObservation,
  candidates: readonly ScannerCandidateRecord[],
  visualScores?: VisualEvidenceByCard,
): ScannerMatch {
  return rankScannerCandidates(parseScannerSignals(observation), candidates, visualScores)
}
