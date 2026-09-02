/**
 * Deterministic scanner matching engine (P67 §14–§15, §17).
 *
 * Pure ranking over catalog records the data layer has already retrieved. No network, no React,
 * no randomness, no object-iteration-order dependence — equal input always produces an equal,
 * stably ordered result.
 *
 * ── Scoring model ────────────────────────────────────────────────────────────────────────────
 * Additive explainable points, clamped to [0, 100]. Weights encode how identifying each piece
 * of printed text actually is on a real Pokémon card:
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
 * - Language match +5 / mismatch −12: agreement corroborates; disagreement is real evidence
 *   against (a Japanese card will not read "Surging Sparks").
 *
 * The arithmetic itself enforces the prompt's uniqueness rules (P67 §9): name-exact alone tops
 * out at 35 → LOW; id-exact alone reaches 50 → MEDIUM at best; HIGH requires the composition
 * of id + name (+set/language), i.e. genuinely convergent printed evidence.
 *
 * ── Confidence ───────────────────────────────────────────────────────────────────────────────
 * Tier comes from score AND ambiguity: a top score with a nearly-equal runner-up is DEMOTED
 * (high needs ≥15 points of margin, medium ≥8). Ranking must surface ambiguity, never invent
 * certainty.
 */
import { compareCollectorNumber } from './collector-compare'
import { parseCollectorNumber } from './collector-number'
import { parseCollectorNumberStructured, type CollectorParseConfidence } from './collector-parse'
import { compareNames } from './name-similarity'
import { normalizeCardText, parseLanguageHint } from './normalize'
import { compareSetHint } from './set-hint'
import { visualEvidencePoints, visualEvidenceTier } from './visual-evidence'
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
  /** Observation language agrees with the card's catalog language. */
  languageMatch: 5,
  /** Observation language disagrees — subtracted, because it argues AGAINST the candidate. */
  languageMismatchPenalty: 12,
} as const

/** Score bands and ambiguity margins. Exported and pinned by tests like the weights. */
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

function scoreCandidate(
  signals: ParsedScannerSignals,
  card: ScannerCandidateRecord,
  visualScores?: VisualEvidenceByCard,
): RankedScannerCandidate {
  const reasons: ScannerReasonCode[] = []
  let score = 0

  // P88 §8/F-12: id/name evidence points are scaled by how trustworthy the underlying OCR read
  // actually was (reliability 1 when the observation supplied no confidence — every pre-P88
  // caller/test) — a low-confidence-but-structurally-plausible read no longer scores identically
  // to a clean, confident one, the "confidently wrong" gap F-12 found.
  const idEvidence = compareCollectorNumber(signals.collectorNumber, card.localId)
  if (idEvidence === 'exact') {
    score += Math.round(SCORING_WEIGHTS.collectorNumberExact * signals.collectorReliability)
    reasons.push('collector-number-exact')
  } else if (idEvidence === 'folded') {
    score += Math.round(SCORING_WEIGHTS.collectorNumberFolded * signals.collectorReliability)
    reasons.push('collector-number-ocr-folded')
  } else if (idEvidence === 'numeric') {
    score += Math.round(SCORING_WEIGHTS.collectorNumberNumericOnly * signals.collectorReliability)
    reasons.push('collector-number-numeric-only')
  }

  const nameEvidence = compareNames(signals.normalizedName, card.name)
  if (nameEvidence === 'exact') {
    score += Math.round(SCORING_WEIGHTS.nameExact * signals.nameReliability)
    reasons.push('name-exact')
  } else if (nameEvidence === 'close') {
    score += Math.round(SCORING_WEIGHTS.nameClose * signals.nameReliability)
    reasons.push('name-close')
  } else if (nameEvidence === 'partial') {
    score += Math.round(SCORING_WEIGHTS.namePartial * signals.nameReliability)
    reasons.push('name-partial')
  }

  const setEvidence = compareSetHint(signals.setHint, card.setName)
  if (setEvidence === 'exact') {
    score += SCORING_WEIGHTS.setExact
    reasons.push('set-exact')
  } else if (setEvidence === 'close') {
    score += SCORING_WEIGHTS.setClose
    reasons.push('set-close')
  }

  if (signals.languageHint !== null) {
    if (signals.languageHint === card.language) {
      score += SCORING_WEIGHTS.languageMatch
      reasons.push('language-match')
    } else {
      score -= SCORING_WEIGHTS.languageMismatchPenalty
      reasons.push('language-mismatch')
    }
  }

  const visualSimilarity = visualScores?.get(card.cardId) ?? null
  const visualTier = visualEvidenceTier(visualSimilarity)
  const visualPoints = visualEvidencePoints(visualSimilarity)
  if (visualPoints > 0) {
    score += visualPoints
    if (visualTier === 'strong') reasons.push('visual-strong')
    else if (visualTier === 'moderate') reasons.push('visual-moderate')
    else reasons.push('visual-weak')
  }

  const clamped = Math.max(0, Math.min(100, score))
  return { card, score: clamped, reasons, visualSimilarity }
}

/**
 * P88 §2/§3/F-02 — visual-dominance guard. A text-favoured candidate whose OWN visual similarity
 * is none/weak must not outrank a DIFFERENT candidate the visual channel is confident about
 * (>= strongMin) purely because a coincidental OCR text convergence (e.g. id-exact + name-exact
 * = 75) happens to sit above that visual match's point value — the exact mechanism F-02 found.
 *
 * The guard only fires when the visual channel produced a genuinely STRONG anchor for some
 * specific card (never for the catastrophic/weak regime — P84's calibration shows a value like
 * 0.18 is nowhere near this band, so a trustworthy OCR-exact read is never touched when visual
 * evidence is merely absent or weak, satisfying the opposite required property from prompt §3).
 * A candidate whose OWN visual similarity also reaches 'strong' is NEVER guarded (two genuinely
 * similar prints/artworks — collector number, not visual, should differentiate those, per the
 * scenario-C "two legitimate same-name printings" requirement).
 *
 * `OVERWHELMING_TEXT_SCORE` is an escape hatch for the (extremely rare) case where a wrong card's
 * TEXT evidence alone is essentially total-coverage-convergent (id + name + set + language all
 * agreeing) — a coincidence so complete it is treated as its own strong evidence rather than
 * guarded away.
 */
const VISUAL_DOMINANCE_TEXT_FACTOR = 0.5
const OVERWHELMING_TEXT_SCORE = 90

function applyVisualDominanceGuard(
  scored: readonly RankedScannerCandidate[],
  signals: ParsedScannerSignals,
): { guarded: readonly RankedScannerCandidate[]; anyGuarded: boolean } {
  let anchorCardId: string | null = null
  let anchorSimilarity = -Infinity
  for (const entry of scored) {
    if (
      entry.visualSimilarity !== null &&
      entry.visualSimilarity !== undefined &&
      Number.isFinite(entry.visualSimilarity) &&
      entry.visualSimilarity > anchorSimilarity
    ) {
      anchorSimilarity = entry.visualSimilarity
      anchorCardId = entry.card.cardId
    }
  }
  if (anchorCardId === null || visualEvidenceTier(anchorSimilarity) !== 'strong') {
    return { guarded: scored, anyGuarded: false }
  }

  let anyGuarded = false
  const guarded = scored.map((entry) => {
    if (entry.card.cardId === anchorCardId) return entry
    const ownTier = visualEvidenceTier(entry.visualSimilarity)
    if (ownTier !== 'none' && ownTier !== 'weak') return entry

    const textOnlyScore = scoreCandidate(signals, entry.card).score
    if (textOnlyScore >= OVERWHELMING_TEXT_SCORE) return entry

    const ownVisualPoints = visualEvidencePoints(entry.visualSimilarity)
    const guardedScore = Math.max(
      0,
      Math.min(100, Math.round(textOnlyScore * VISUAL_DOMINANCE_TEXT_FACTOR) + ownVisualPoints),
    )
    if (guardedScore >= entry.score) return entry
    anyGuarded = true
    return {
      ...entry,
      score: guardedScore,
      reasons: [...entry.reasons, 'visual-dominance-guarded' as const],
    }
  })
  return { guarded, anyGuarded }
}

/**
 * Ranks candidates against parsed signals plus optional per-candidate visual evidence (P76,
 * D-097). Bounded output, deterministic order (score desc, then cardId asc so equal scores never
 * depend on input order), duplicates removed. `visualScores` candidates that never appeared in
 * the text-search pool must already be merged into `candidates` by the data layer (P76 §16's
 * hybrid retrieval) — this function only SCORES, never fetches or invents identity.
 */
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

  const deduped = new Map<string, RankedScannerCandidate>()
  for (const card of candidates) {
    if (!deduped.has(card.cardId)) {
      deduped.set(card.cardId, scoreCandidate(signals, card, visualScores))
    }
  }
  const { guarded } = applyVisualDominanceGuard([...deduped.values()], signals)
  const sorted = [...guarded].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.card.cardId < b.card.cardId ? -1 : a.card.cardId > b.card.cardId ? 1 : 0
  })
  const bounded = sorted.slice(0, SCORING_TIERS.maxReturnedCandidates)

  const top = bounded[0]
  const runnerUp = bounded[1]
  const notes: ScannerNoteCode[] = []
  let tier: ScannerConfidenceTier
  if (!top) {
    tier = 'none'
  } else {
    tier =
      top.score >= SCORING_TIERS.highMinScore
        ? 'high'
        : top.score >= SCORING_TIERS.mediumMinScore
          ? 'medium'
          : top.score >= SCORING_TIERS.lowMinScore
            ? 'low'
            : 'none'
    if (runnerUp) {
      const margin = top.score - runnerUp.score
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
      if (textOnly.score > textOnlyBestScore) {
        textOnlyBestScore = textOnly.score
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
