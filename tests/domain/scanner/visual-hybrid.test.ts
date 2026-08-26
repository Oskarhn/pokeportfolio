/**
 * Hybrid visual-evidence scoring (P76, D-097): prompt §44's V8–V13, plus V15 (manual fallback
 * ends up covered by "no visual evidence at all" degrading to the existing text-only path — the
 * exact behaviour engine.test.ts already pins, unchanged).
 */
import { describe, expect, it } from 'vitest'
import {
  matchScannerObservation,
  rankScannerCandidates,
  parseScannerSignals,
  visualEvidenceTier,
  visualEvidencePoints,
  VISUAL_SIMILARITY_THRESHOLDS,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../../src/domain/scanner'

function card(
  cardId: string,
  name: string,
  localId: string,
  setName = 'Base Set',
): ScannerCandidateRecord {
  return {
    cardId,
    name,
    localId,
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: 'en',
    setId: `${setName}-en`,
    setName,
    variantCount: 1,
  }
}

describe('visual-evidence calibration', () => {
  it('tiers follow the documented threshold order', () => {
    expect(visualEvidenceTier(0.95)).toBe('strong')
    expect(visualEvidenceTier(VISUAL_SIMILARITY_THRESHOLDS.strongMin)).toBe('strong')
    expect(visualEvidenceTier(VISUAL_SIMILARITY_THRESHOLDS.moderateMin)).toBe('moderate')
    expect(visualEvidenceTier(VISUAL_SIMILARITY_THRESHOLDS.weakMin)).toBe('weak')
    expect(visualEvidenceTier(0.1)).toBe('none')
    expect(visualEvidenceTier(null)).toBe('none')
  })

  it('points scale monotonically with similarity and are zero below the floor', () => {
    expect(visualEvidencePoints(0.5)).toBe(0)
    expect(visualEvidencePoints(0.99)).toBeGreaterThan(visualEvidencePoints(0.7))
    expect(visualEvidencePoints(1)).toBeGreaterThanOrEqual(visualEvidencePoints(0.99))
  })
})

describe('V8 — OCR absent, visual strong: still produces a shortlist', () => {
  it('returns candidates from visual evidence alone when text signals are empty', () => {
    const candidates = [card('a', 'Pikachu', '58'), card('b', 'Charizard', '4')]
    const visualScores: VisualEvidenceByCard = new Map([['a', 0.95]])
    const match = matchScannerObservation(
      { rawNameText: null, rawCollectorNumberText: null, rawSetText: null, languageHint: null },
      candidates,
      visualScores,
    )
    expect(match.tier).not.toBe('none')
    expect(match.candidates[0]?.card.cardId).toBe('a')
  })

  it('still returns NO_MATCH when there is neither text nor visual evidence', () => {
    const candidates = [card('a', 'Pikachu', '58')]
    const match = matchScannerObservation(
      { rawNameText: null, rawCollectorNumberText: null, rawSetText: null, languageHint: null },
      candidates,
    )
    expect(match.tier).toBe('none')
    expect(match.candidates).toEqual([])
  })
})

describe('V9 — OCR + visual agreement raises evidence above either alone', () => {
  it('a card with both matching text and strong visual similarity outscores text-only', () => {
    const candidates = [card('a', 'Pikachu', '58')]
    const textOnly = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        rawSetText: null,
        languageHint: 'en',
      },
      candidates,
    )
    const withVisual = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        rawSetText: null,
        languageHint: 'en',
      },
      candidates,
      new Map([['a', 0.95]]),
    )
    expect(withVisual.candidates[0]!.score).toBeGreaterThan(textOnly.candidates[0]!.score)
  })
})

describe('V10 — OCR/visual disagreement lowers confidence vs. agreement', () => {
  it('two plausible candidates (one text-favoured, one visually-favoured) score closer than a clean agreeing case', () => {
    const candidates = [card('text-match', 'Pikachu', '58'), card('visual-match', 'Raichu', '26')]
    const agreeing = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        rawSetText: null,
        languageHint: 'en',
      },
      candidates,
      new Map([['text-match', 0.9]]),
    )
    const disagreeing = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        rawSetText: null,
        languageHint: 'en',
      },
      candidates,
      new Map([['visual-match', 0.9]]),
    )
    const agreeingMargin = agreeing.candidates[0]!.score - (agreeing.candidates[1]?.score ?? 0)
    const disagreeingMargin =
      disagreeing.candidates[0]!.score - (disagreeing.candidates[1]?.score ?? 0)
    expect(disagreeingMargin).toBeLessThan(agreeingMargin)
    expect(disagreeing.notes).toContain('visual-text-disagreement')
    expect(agreeing.notes).not.toContain('visual-text-disagreement')
  })
})

describe('V11 — near-equal visual candidates remain ambiguous', () => {
  it('two cards with nearly identical visual similarity do not reach HIGH from visual alone', () => {
    const candidates = [card('a', 'Pikachu', '58'), card('b', 'Pikachu', '59')]
    const match = matchScannerObservation(
      { rawNameText: null, rawCollectorNumberText: null, rawSetText: null, languageHint: null },
      candidates,
      new Map([
        ['a', 0.9],
        ['b', 0.89],
      ]),
    )
    expect(match.tier).not.toBe('high')
  })
})

describe('V12 — same-art alternatives surfaced, not silently picked', () => {
  it('a reprint with identical visual similarity to the original stays in the candidate list', () => {
    const candidates = [
      card('original', 'Charizard', '4', 'Base Set'),
      card('reprint', 'Charizard', 'CC002', 'Celebrations Classic Collection'),
    ]
    const match = matchScannerObservation(
      {
        rawNameText: 'Charizard',
        rawCollectorNumberText: null,
        rawSetText: null,
        languageHint: 'en',
      },
      candidates,
      new Map([
        ['original', 0.93],
        ['reprint', 0.93],
      ]),
    )
    const ids = match.candidates.map((c) => c.card.cardId)
    expect(ids).toContain('original')
    expect(ids).toContain('reprint')
  })
})

describe('V13 — no auto-add even at HIGH confidence', () => {
  it('rankScannerCandidates never mutates or returns anything beyond an explainable ranking', () => {
    const candidates = [card('a', 'Charizard', '4')]
    const signals = parseScannerSignals({
      rawNameText: 'Charizard',
      rawCollectorNumberText: '4/102',
      rawSetText: 'Base Set',
      languageHint: 'en',
    })
    const match = rankScannerCandidates(signals, candidates, new Map([['a', 0.99]]))
    expect(match.tier).toBe('high')
    // The match is pure data — confirmation/commit is a separate, explicit step elsewhere
    // (controller.ts's commitBatch); nothing in this call graph can add to a portfolio.
    expect(Object.keys(match)).toEqual(['tier', 'candidates', 'signals', 'notes'])
  })
})

describe('backward compatibility: visualScores is optional', () => {
  it('omitting visualScores entirely reproduces the pre-P76 text-only behaviour', () => {
    const candidates = [card('a', 'Charizard', '4')]
    const observation = {
      rawNameText: 'Charizard',
      rawCollectorNumberText: '4/102',
      rawSetText: 'Base Set',
      languageHint: 'en' as const,
    }
    const withUndefined = matchScannerObservation(observation, candidates, undefined)
    const withoutArg = matchScannerObservation(observation, candidates)
    expect(withUndefined).toEqual(withoutArg)
  })
})
