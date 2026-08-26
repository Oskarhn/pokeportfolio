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
  /** Upper bound on returned candidates (UX_FLOWS F12 shows at most three; headroom for UI). */
  maxReturnedCandidates: 5,
  /** Normalized-name characters required before a name counts as a usable signal (P67 §17). */
  minNameLengthForSignal: 3,
} as const

/** Parses one observation into comparable signals. Junk/short fields become null — absence of
 *  evidence, never a guess. `visualSimilarity` is intentionally dropped here (reserved seam). */
export function parseScannerSignals(observation: ScannerObservation): ParsedScannerSignals {
  const normalizedNameRaw = observation.rawNameText?.trim() ?? ''
  const normalized = normalizedNameRaw === '' ? '' : normalizeCardText(normalizedNameRaw)
  const setHintRaw = observation.rawSetText?.trim() ?? ''
  const setHintNormalized = setHintRaw === '' ? '' : normalizeCardText(setHintRaw)
  return {
    normalizedName: normalized.length >= SCORING_TIERS.minNameLengthForSignal ? normalized : null,
    collectorNumber: observation.rawCollectorNumberText
      ? parseCollectorNumber(observation.rawCollectorNumberText)
      : null,
    setHint: setHintNormalized.length >= 4 ? setHintNormalized : null,
    languageHint: parseLanguageHint(observation.languageHint),
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

  const idEvidence = compareCollectorNumber(signals.collectorNumber, card.localId)
  if (idEvidence === 'exact') {
    score += SCORING_WEIGHTS.collectorNumberExact
    reasons.push('collector-number-exact')
  } else if (idEvidence === 'folded') {
    score += SCORING_WEIGHTS.collectorNumberFolded
    reasons.push('collector-number-ocr-folded')
  } else if (idEvidence === 'numeric') {
    score += SCORING_WEIGHTS.collectorNumberNumericOnly
    reasons.push('collector-number-numeric-only')
  }

  const nameEvidence = compareNames(signals.normalizedName, card.name)
  if (nameEvidence === 'exact') {
    score += SCORING_WEIGHTS.nameExact
    reasons.push('name-exact')
  } else if (nameEvidence === 'close') {
    score += SCORING_WEIGHTS.nameClose
    reasons.push('name-close')
  } else if (nameEvidence === 'partial') {
    score += SCORING_WEIGHTS.namePartial
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
  const sorted = [...deduped.values()].sort((a, b) => {
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
    if (
      textOnlyTopCardId !== null &&
      visualOnlyTopCardId !== null &&
      textOnlyTopCardId !== visualOnlyTopCardId &&
      textOnlyBestScore > 0 &&
      visualEvidenceTier(visualOnlyBestSimilarity) !== 'none'
    ) {
      notes.push('visual-text-disagreement')
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
