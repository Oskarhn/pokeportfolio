import { describe, expect, it } from 'vitest'
import {
  matchScannerObservation,
  ocrTextReliability,
  parseScannerSignals,
  rankScannerCandidates,
  rankScannerCandidatesFull,
  SCORING_WEIGHTS,
  shouldAbstainForBlurScore,
  structuralReliability,
  visualEvidencePoints,
  visualEvidenceTier,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../../src/domain/scanner'

/**
 * P93 §28 — the permanent regression suite for the M15 matcher correctness rewrite (D-106).
 * Numbered M93-1 through M93-16 to match the prompt's own required-repro list. Several of these
 * scenarios are ALSO covered (with different framing) by engine.test.ts, engine-visual-
 * dominance.test.ts and visual-hybrid.test.ts — deliberate overlap, not redundancy: this file is
 * the one place a future auditor can find every P93-required case addressed by its own name.
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

describe('M93-1 — continuous visual score', () => {
  it('is monotonic non-decreasing across the full similarity range', () => {
    const steps: number[] = []
    for (let s = 0; s <= 1; s += 0.02) steps.push(Number(s.toFixed(2)))
    let previous = -Infinity
    for (const s of steps) {
      const points = visualEvidencePoints(s)
      expect(points).toBeGreaterThanOrEqual(previous)
      previous = points
    }
  })

  it('produces genuinely distinct intermediate values, not a two-value step function', () => {
    const sampled = new Set(
      [0.5, 0.6, 0.65, 0.7, 0.75, 0.78, 0.8, 0.82, 0.85, 0.9, 0.95].map((s) =>
        visualEvidencePoints(s),
      ),
    )
    // A genuinely continuous curve over this range should hit well over half as many distinct
    // point values as similarity samples — a discrete band curve would collapse to 3-4.
    expect(sampled.size).toBeGreaterThanOrEqual(8)
  })
})

describe('M93-2 — no discontinuity at the old absolute 0.82 threshold', () => {
  it('every ±0.001 step near 0.82 changes points by at most a couple of points, never 17', () => {
    for (let s = 0.8; s < 0.84; s += 0.001) {
      const a = visualEvidencePoints(Number(s.toFixed(3)))
      const b = visualEvidencePoints(Number((s + 0.001).toFixed(3)))
      expect(Math.abs(b - a)).toBeLessThanOrEqual(2)
    }
  })

  it('the specific old cliff points (0.819999 vs 0.82) now differ by at most 1 point', () => {
    const justBelow = visualEvidencePoints(0.819999)
    const at = visualEvidencePoints(0.82)
    expect(Math.abs(at - justBelow)).toBeLessThanOrEqual(1)
  })
})

describe('M93-3 — non-finite similarity fails closed', () => {
  it('NaN/Infinity/-Infinity/null/undefined all resolve to zero points and tier none', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined]) {
      expect(visualEvidencePoints(value)).toBe(0)
      expect(visualEvidenceTier(value)).toBe('none')
    }
  })
})

describe('M93-4 — the exact 0.81 F-02 repro (P84 mean genuine-match similarity)', () => {
  it('a correct card at similarity 0.812 (P84 calibrated MEAN, not a cherry-picked 0.9) with zero own text beats a coincidental id+name text convergence on a wrong card', () => {
    const correct = card('correct', 'Shieldon', '999', 'Diamond & Pearl')
    const wrong = card('wrong', 'Pidgey', '58', 'Base Set')
    const visualScores: VisualEvidenceByCard = new Map([
      ['correct', 0.812],
      ['wrong', 0.05],
    ])
    const match = matchScannerObservation(
      { rawNameText: 'Pidgey', rawCollectorNumberText: '58', languageHint: 'en' },
      [correct, wrong],
      visualScores,
    )
    expect(match.candidates[0]?.card.cardId).toBe('correct')
    const wrongEntry = match.candidates.find((c) => c.card.cardId === 'wrong')
    // The wrong card's coincidental text score (id-exact 45 + name-exact 30 = 75, language no
    // longer scores) is untouched — proof nothing was discounted (see M93-5).
    expect(wrongEntry?.rawRankScore).toBe(75)
  })
})

describe('M93-5 — a lone wrong-card visual spike never discounts a DIFFERENT candidate’s reliable OCR', () => {
  it('the true card’s full text evidence is never reduced by the presence of a competing visual anchor', () => {
    const trueCard = card('true-card', 'Pikachu', '58', 'Base Set')
    const spikedWrong = card('spiked-wrong', 'Raichu', '26', 'Base Set')
    const match = matchScannerObservation(
      {
        rawNameText: 'Pikachu',
        rawCollectorNumberText: '58',
        nameOcrConfidence: 95,
        collectorOcrConfidence: 95,
      },
      [trueCard, spikedWrong],
      // Only the WRONG card has any visual reading at all — a single, unrelated spike.
      new Map([['spiked-wrong', 0.85]]),
    )
    const trueEntry = match.candidates.find((c) => c.card.cardId === 'true-card')
    // id-exact(45) + name-exact(30) at full OCR reliability, unmodified by the competing anchor.
    expect(trueEntry?.rawRankScore).toBe(75)
    expect(trueEntry?.reasons).not.toContain('visual-anchor-corroborated')
  })
})

describe('M93-6 — cardId is never the meaningful tie-break', () => {
  it('a lexically-later cardId with genuinely stronger evidence still outranks a lexically-earlier one', () => {
    const alpha = card('aaa-weaker', 'Bulbasaur', '99', 'Base Set') // wrong id/name, alphabetically first
    const zulu = card('zzz-stronger', 'Pikachu', '58', 'Base Set') // matches the scan exactly
    const match = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58' },
      [alpha, zulu],
    )
    expect(match.candidates[0]?.card.cardId).toBe('zzz-stronger')
  })

  it('cardId only decides a genuine, total evidence tie (same score, same visual similarity)', () => {
    const a = card('b-card', 'Charizard', '4', 'Base Set')
    const b = card('a-card', 'Charizard', '4', 'Base Set')
    const match = matchScannerObservation(
      { rawNameText: 'Charizard', rawCollectorNumberText: '4' },
      [a, b],
    )
    // Identical evidence on both sides — the only remaining, purely cosmetic tie-break is cardId.
    expect(match.candidates[0]?.card.cardId).toBe('a-card')
  })
})

describe('M93-7 — raw-score ranking is preserved even when display scores both clamp to 100', () => {
  it('two candidates that both clamp to a 100 display score still rank by their real raw score', () => {
    const strongest = card('strongest', 'Charizard', '4', 'Base Set')
    const alsoHigh = card('also-high', 'Charizard', '4a', 'Base Set')
    const match = matchScannerObservation(
      { rawNameText: 'Charizard', rawCollectorNumberText: '4' },
      [strongest, alsoHigh],
      new Map([
        ['strongest', 0.97],
        ['also-high', 0.9],
      ]),
    )
    const top = match.candidates[0]!
    const runnerUp = match.candidates[1]!
    expect(top.card.cardId).toBe('strongest')
    expect(top.score).toBeLessThanOrEqual(100)
    expect(runnerUp.score).toBeLessThanOrEqual(100)
    // The real discriminator is the raw score, not the (possibly identically-clamped) display one.
    expect(top.rawRankScore).toBeGreaterThan(runnerUp.rawRankScore)
  })
})

describe('M93-8 — all-weak evidence never produces a confident result', () => {
  it('catastrophic visual + garbage OCR stays at NONE or LOW, never MEDIUM/HIGH', () => {
    const a = card('a', 'Pikachu', '58', 'Base Set')
    const b = card('b', 'Bulbasaur', '44', 'Base Set')
    const match = matchScannerObservation(
      { rawNameText: 'Zzqx', rawCollectorNumberText: '999', languageHint: 'en' },
      [a, b],
      new Map([
        ['a', 0.3],
        ['b', 0.35],
      ]),
    )
    expect(['none', 'low']).toContain(match.tier)
  })
})

describe('M93-9 — severe blur abstains the visual channel', () => {
  it('a blur score below the calibrated threshold abstains', () => {
    expect(shouldAbstainForBlurScore(100)).toBe(true) // well below BLUR_ABSTAIN_THRESHOLD (378)
  })

  it('a null blur score (rectification produced no working image at all) does not abstain on its own', () => {
    expect(shouldAbstainForBlurScore(null)).toBe(false)
  })
})

describe('M93-10 — a good (sharp) image is not blur-abstained', () => {
  it('a blur score comfortably above the threshold does not abstain', () => {
    expect(shouldAbstainForBlurScore(900)).toBe(false)
  })

  it('a caller-supplied threshold is honored (used by benchmark/tuning tooling)', () => {
    expect(shouldAbstainForBlurScore(400, 500)).toBe(true)
    expect(shouldAbstainForBlurScore(600, 500)).toBe(false)
  })
})

describe('M93-11 — language agreement does not double-count already-filter-enforced evidence', () => {
  it('an English hint against an English candidate scores the same as no language hint at all', () => {
    const a = card('a', 'Pikachu', '58', 'Base Set')
    const withHint = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58', languageHint: 'en' },
      [a],
    )
    const withoutHint = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58' },
      [a],
    )
    expect(withHint.candidates[0]?.score).toBe(withoutHint.candidates[0]?.score)
    // The reason code is still surfaced for diagnostics even though it moved zero points.
    expect(withHint.candidates[0]?.reasons).toContain('language-match')
  })

  it('a genuine language MISMATCH remains real, scored evidence (not eligibility-only)', () => {
    const jaCard = card('j1', 'リザードン', '004', '拡張パック')
    const mismatched: ScannerCandidateRecord = { ...jaCard, language: 'ja' }
    const match = matchScannerObservation({ rawCollectorNumberText: '004', languageHint: 'en' }, [
      mismatched,
    ])
    expect(match.candidates[0]?.score).toBe(
      SCORING_WEIGHTS.collectorNumberExact - SCORING_WEIGHTS.languageMismatchPenalty,
    )
  })
})

describe('M93-12 — see tests/ui/scanner-analyze.test.ts (looksLikeBodyTextNotName suite)', () => {
  it('is a pointer, not a duplicate — the real case lives next to the function it tests', () => {
    expect(true).toBe(true)
  })
})

describe('M93-13 — P88 OCR-confidence reliability behavior is preserved', () => {
  it('a low-confidence exact match scores below the same match at full confidence', () => {
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
    expect(ocrTextReliability(8)).toBeLessThan(ocrTextReliability(95))
    expect(structuralReliability('low')).toBeLessThan(structuralReliability('medium'))
  })
})

describe('M93-14 — visual/text disagreement semantics unchanged by the redesign', () => {
  it('a meaningful (moderate/strong) disagreement still caps tier below HIGH', () => {
    const textFavoured = card('text', 'Pikachu', '58', 'Base Set')
    const visualFavoured = card('visual', 'Raichu', '26', 'Base Set')
    const match = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58', rawSetText: 'Base Set' },
      [textFavoured, visualFavoured],
      new Map([['visual', 0.85]]),
    )
    expect(match.notes).toContain('visual-text-disagreement')
    expect(match.tier).not.toBe('high')
  })
})

describe('M93-15 — the expected-card debug tool uses IDENTICAL scoring to production', () => {
  it('rankScannerCandidatesFull and rankScannerCandidates agree on every shared candidate’s score', () => {
    const candidates = [
      card('a', 'Pikachu', '58', 'Base Set'),
      card('b', 'Raichu', '26', 'Base Set'),
      card('c', 'Pichu', '1', 'Neo Genesis'),
    ]
    const signals = parseScannerSignals({
      rawNameText: 'Pikachu',
      rawCollectorNumberText: '58',
      languageHint: 'en',
    })
    const visualScores: VisualEvidenceByCard = new Map([
      ['a', 0.9],
      ['b', 0.4],
    ])
    const full = rankScannerCandidatesFull(signals, candidates, visualScores)
    const bounded = rankScannerCandidates(signals, candidates, visualScores)
    for (const boundedEntry of bounded.candidates) {
      const fullEntry = full.find((c) => c.card.cardId === boundedEntry.card.cardId)
      expect(fullEntry?.score).toBe(boundedEntry.score)
      expect(fullEntry?.rawRankScore).toBe(boundedEntry.rawRankScore)
      expect(fullEntry?.reasons).toEqual(boundedEntry.reasons)
    }
  })
})

describe('M93-16 — performance smoke (matcher stays negligible with the new anchor-reliability pass)', () => {
  it('ranks 40 candidates x 5000 iterations well under a catastrophic-only budget', () => {
    const catalog: ScannerCandidateRecord[] = Array.from({ length: 40 }, (_, i) =>
      card(`perf-${i}`, `Pokémon ${i}`, `${(i % 250) + 1}/400`, `Set ${i % 10}`),
    )
    const visualScores: VisualEvidenceByCard = new Map(
      catalog.map((c, i) => [c.cardId, 0.4 + (i % 10) * 0.05]),
    )
    const signals = parseScannerSignals({
      rawNameText: 'Pokémon 7',
      rawCollectorNumberText: '8/400',
      languageHint: 'en',
    })
    rankScannerCandidates(signals, catalog, visualScores) // warm-up
    const RUNS = 5000
    const startedAt = performance.now()
    for (let i = 0; i < RUNS; i += 1) {
      rankScannerCandidates(signals, catalog, visualScores)
    }
    const avgMs = (performance.now() - startedAt) / RUNS
    console.info('[M93-16] avg ms per ranking of 40 candidates:', avgMs.toFixed(4))
    // Catastrophic-only budget (same discipline as engine.test.ts's own §22 smoke test) — this
    // catches a hang/exponential blow-up, not an ordinary 2-10x slowdown.
    expect(avgMs).toBeLessThan(5)
  })
})
