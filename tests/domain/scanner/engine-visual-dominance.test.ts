import { describe, expect, it } from 'vitest'
import {
  matchScannerObservation,
  ocrTextReliability,
  structuralReliability,
  visualEvidencePoints,
  visualEvidenceTier,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../../src/domain/scanner'

/**
 * P88 §19 — adversarial evidence-combination suite (F-02 redesign). Each case mirrors a scenario
 * from the prompt's own adversarial list, engineered so a correct card and a coincidentally
 * text-matching WRONG card compete for rank #1. This is the suite that "F-02 is not fixed until"
 * (prompt §18) — the guard in engine.ts's `applyVisualDominanceGuard` is what these pin.
 */

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

describe('P88 scenario A — strong correct visual must beat a coincidental wrong-card OCR text match', () => {
  it('correct card (visual 0.90) outranks a different card with exact id+name text convergence', () => {
    const correct = card('correct', 'Shieldon', '58', 'Diamond & Pearl')
    // A different, unrelated card that happens to share the OCR-read id/name exactly.
    const wrong = card('wrong', 'Pidgey', '58', 'Base Set')
    const visualScores: VisualEvidenceByCard = new Map([
      ['correct', 0.9],
      ['wrong', 0.05],
    ])
    const match = matchScannerObservation(
      { rawNameText: 'Pidgey', rawCollectorNumberText: '58', languageHint: 'en' },
      [correct, wrong],
      visualScores,
    )
    expect(match.candidates[0]?.card.cardId).toBe('correct')
  })

  it("the pure repro: correct card has ZERO text evidence of its own (F-02's exact failure mode)", () => {
    // Isolates the audit's precise mechanism — the CORRECT card's own printed id/name are totally
    // unrelated to what OCR read (a real photo with a badly misread number/name), so it earns NO
    // text points at all; only the WRONG card coincidentally converges with the OCR text. Under
    // the pre-P88 scoring (visual ceiling 62, id+name+language = 80), the wrong card scored 80 vs
    // the correct card's 48 — the wrong card won unconditionally. This is the case the dominance
    // guard exists for.
    const correct = card('correct', 'Shieldon', '999', 'Diamond & Pearl')
    const wrong = card('wrong', 'Pidgey', '58', 'Base Set')
    const visualScores: VisualEvidenceByCard = new Map([
      ['correct', 0.9],
      ['wrong', 0.05],
    ])
    const match = matchScannerObservation(
      { rawNameText: 'Pidgey', rawCollectorNumberText: '58', languageHint: 'en' },
      [correct, wrong],
      visualScores,
    )
    expect(match.candidates[0]?.card.cardId).toBe('correct')
    // The wrong card's coincidental text convergence must have been visibly discounted.
    const wrongEntry = match.candidates.find((c) => c.card.cardId === 'wrong')
    expect(wrongEntry?.reasons).toContain('visual-dominance-guarded')
  })
})

describe('P88 scenario B — weak/catastrophic visual (~0.18) must never overpower trustworthy exact OCR', () => {
  it('a card with confident exact OCR wins even when every visual reading is catastrophic', () => {
    const correct = card('correct', 'Pikachu', '58', 'Base Set')
    const other = card('other', 'Raichu', '26', 'Base Set')
    // P84 calibration: under combined defects, same-card similarity ~0.10-0.19, nearest-wrong
    // ~0.28-0.33 — neither reaches even the 'weak' tier (weakMin 0.55), let alone 'strong'.
    const visualScores: VisualEvidenceByCard = new Map([
      ['correct', 0.18],
      ['other', 0.28],
    ])
    const match = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        languageHint: 'en',
        nameOcrConfidence: 92,
        collectorOcrConfidence: 90,
      },
      [correct, other],
      visualScores,
    )
    expect(match.candidates[0]?.card.cardId).toBe('correct')
    expect(match.tier).not.toBe('none')
  })
})

describe('P88 scenario C — two legitimate same-name printings, collector number differentiates', () => {
  it('the printing whose number matches wins even when both share visually-similar (reprint) art', () => {
    const original = card('original', 'Charizard', '4', 'Base Set')
    const reprint = card('reprint', 'Charizard', 'CC002', 'Celebrations Classic Collection')
    // Same artwork family — DINOv2 rates both plausibly close; NEITHER is a lone 'strong' anchor
    // the other lacks, so the dominance guard must not fire against either.
    const visualScores: VisualEvidenceByCard = new Map([
      ['original', 0.85],
      ['reprint', 0.83],
    ])
    const match = matchScannerObservation(
      { rawNameText: 'Charizard', rawCollectorNumberText: '4', languageHint: 'en' },
      [original, reprint],
      visualScores,
    )
    expect(match.candidates[0]?.card.cardId).toBe('original')
  })
})

describe('P88 scenario E — wrong OCR text + weak visual yields no confident match', () => {
  it('neither channel is trustworthy: result stays LOW/NONE, never a false HIGH', () => {
    const a = card('a', 'Pikachu', '58', 'Base Set')
    const b = card('b', 'Bulbasaur', '44', 'Base Set')
    const visualScores: VisualEvidenceByCard = new Map([
      ['a', 0.3],
      ['b', 0.35],
    ])
    const match = matchScannerObservation(
      { rawNameText: 'Zzqx', rawCollectorNumberText: '999', languageHint: 'en' },
      [a, b],
      visualScores,
    )
    expect(match.tier === 'none' || match.tier === 'low').toBe(true)
  })
})

describe('P88 scenario F — strong visual/text disagreement caps tier below HIGH (F-26)', () => {
  it('a meaningful (moderate/strong) disagreement never lets the text-favoured candidate reach HIGH', () => {
    const textFavoured = card('text', 'Pikachu', '58', 'Base Set')
    const visualFavoured = card('visual', 'Raichu', '26', 'Base Set')
    const match = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        rawSetText: 'Base Set',
        languageHint: 'en',
      },
      [textFavoured, visualFavoured],
      new Map([['visual', 0.85]]),
    )
    expect(match.notes).toContain('visual-text-disagreement')
    expect(match.tier).not.toBe('high')
  })

  it('a catastrophic/weak disagreement never punishes otherwise-strong text (F-26 opposite requirement)', () => {
    const textFavoured = card('text', 'Pikachu', '58', 'Base Set')
    const other = card('other', 'Raichu', '26', 'Base Set')
    const match = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        rawSetText: 'Base Set',
        languageHint: 'en',
      },
      [textFavoured, other],
      // 'other' reads a weak, non-diagnostic similarity — must not trigger the disagreement cap.
      new Map([['other', 0.56]]),
    )
    expect(match.notes).not.toContain('visual-text-disagreement')
    expect(match.tier).toBe('high')
  })
})

describe('P88 scenario G — two printings, correct exact image favored honestly', () => {
  it('when text ties (same name, no number read), a decisively stronger visual match wins', () => {
    const correct = card('correct', 'Charizard', '4', 'Base Set')
    const other = card('other', 'Charizard', '150', 'XY')
    const match = matchScannerObservation(
      { rawNameText: 'Charizard', languageHint: 'en' },
      [correct, other],
      new Map([
        ['correct', 0.93],
        ['other', 0.3],
      ]),
    )
    expect(match.candidates[0]?.card.cardId).toBe('correct')
  })
})

describe('F-27 — non-finite visual similarity fails closed', () => {
  it('NaN/Infinity/-Infinity all resolve to no visual evidence, never a corrupted score', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(visualEvidenceTier(value)).toBe('none')
      expect(visualEvidencePoints(value)).toBe(0)
    }
  })

  it('a NaN similarity in the evidence map never crashes or corrupts ranking', () => {
    const a = card('a', 'Pikachu', '58', 'Base Set')
    const match = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58', languageHint: 'en' },
      [a],
      new Map([['a', NaN]]),
    )
    expect(match.candidates[0]?.visualSimilarity).toBeNaN()
    expect(Number.isFinite(match.candidates[0]?.score)).toBe(true)
  })
})

describe('F-12/P88 §8 — OCR confidence discounts text evidence reliability', () => {
  it('ocrTextReliability is full-strength above the confidence floor and unknown (undefined)', () => {
    expect(ocrTextReliability(undefined)).toBe(1)
    expect(ocrTextReliability(null)).toBe(1)
    expect(ocrTextReliability(95)).toBe(1)
  })

  it('a very low OCR confidence discounts, never zeroes, an otherwise-exact text match', () => {
    expect(ocrTextReliability(5)).toBeLessThan(1)
    expect(ocrTextReliability(5)).toBeGreaterThan(0)
  })

  it('a low-confidence exact id+name match scores below the same match at full confidence', () => {
    const a = card('a', 'Pikachu', '58', 'Base Set')
    const confident = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        nameOcrConfidence: 95,
        collectorOcrConfidence: 95,
      },
      [a],
    )
    const noisy = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        nameOcrConfidence: 8,
        collectorOcrConfidence: 8,
      },
      [a],
    )
    expect(noisy.candidates[0]!.score).toBeLessThan(confident.candidates[0]!.score)
  })

  it('structuralReliability only discounts a LOW-confidence shape, not the ordinary medium shape', () => {
    expect(structuralReliability('high')).toBe(1)
    expect(structuralReliability('medium')).toBe(1)
    expect(structuralReliability('low')).toBeLessThan(1)
    expect(structuralReliability(undefined)).toBe(1)
  })

  it('a copyright-year-shaped low-confidence collector read is discounted vs. a real id shape', () => {
    const a = card('a', 'Pikachu', '58', 'Base Set')
    // "1995" structurally parses (bare numeric) but P85's own guard classifies a bare 4+-digit
    // run as LOW confidence (copyright-year shape) — its evidence must count for less than a
    // real 2-digit vintage id at the same OCR confidence.
    const yearShaped = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '1995', collectorOcrConfidence: 90 },
      [card('a2', 'Pikachu', '1995', 'Base Set')],
    )
    const realIdShaped = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58', collectorOcrConfidence: 90 },
      [a],
    )
    expect(yearShaped.candidates[0]!.score).toBeLessThan(realIdShaped.candidates[0]!.score)
  })
})
