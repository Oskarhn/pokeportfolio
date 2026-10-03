import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  matchScannerObservation,
  SCORING_TIERS,
  parseScannerSignals,
  rankScannerCandidates,
} from '../../../src/domain/scanner'
import type {
  ScannerCandidateRecord,
  ScannerObservation,
  VisualEvidenceByCard,
} from '../../../src/domain/scanner'
import { initialScannerState, scannerReducer } from '../../../src/features/scanner/state'

/**
 * P151 confidence policy. Two rules under test:
 *
 *  1. VISUAL-ONLY EVIDENCE NEVER CLAIMS HIGH. Artwork identifies a card's art, not its printing:
 *     reprints/promos share art across sets. Measured on the real production index
 *     (`pnpm scanner:confidence:audit`, docs/SCANNER_RESEARCH.md P151) the old rule made a sibling
 *     printing HIGH — preselected — in ~6-10% of scans whose true printing has no reference image.
 *  2. THE PRINTING/VARIANT IS NEVER INFERRED. The scanner identifies a CARD; which printing (holo,
 *     reverse holo, stamp, ...) is always the user's explicit choice unless the catalog has exactly
 *     one active printing.
 */

function record(
  cardId: string,
  name: string,
  localId: string,
  setName = 'Set',
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
    setId: setName,
    setName,
    variantCount: 1,
  }
}

const NO_TEXT: ScannerObservation = { rawNameText: '', rawCollectorNumberText: '' }

describe('P151 — visual-only evidence can never be HIGH', () => {
  it('a would-be HIGH with zero text evidence is held at MEDIUM and says why', () => {
    const match = matchScannerObservation(
      NO_TEXT,
      [record('a', 'Pikachu', '58'), record('b', 'Other', '99')],
      new Map([
        ['a', 0.9],
        ['b', 0.5],
      ]),
    )
    expect(match.candidates[0]?.card.cardId).toBe('a')
    expect(match.candidates[0]?.rawRankScore).toBeGreaterThanOrEqual(SCORING_TIERS.highMinScore)
    expect(match.tier).toBe('medium')
    expect(match.notes).toContain('visual-only-uncorroborated')
  })

  it('the unindexed-printing case: the ONLY visual hit is a same-art sibling printing — never HIGH', () => {
    // The true printing has no reference image; its reprint sibling (same art, other set) does.
    const match = matchScannerObservation(
      NO_TEXT,
      [record('sibling', 'Pikachu', '58', 'Base Set 2')],
      new Map([['sibling', 0.95]]),
    )
    expect(match.tier).not.toBe('high')
  })

  it('property: over 20,000 random visual-only score maps the tier is never HIGH, and never worse than the old rule made it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -0.2, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }),
        (similarities) => {
          const cards = similarities.map((_, i) =>
            record(`c${String(i)}`, `Card ${String(i)}`, String(i + 1)),
          )
          const scores: VisualEvidenceByCard = new Map(
            similarities.map((s, i) => [`c${String(i)}`, s]),
          )
          const match = rankScannerCandidates(parseScannerSignals(NO_TEXT), cards, scores)
          expect(match.tier).not.toBe('high')
          // Holding a would-be HIGH at MEDIUM is the ONLY thing the cap does: any other tier is
          // exactly what the score/margin rules alone decided.
          if (match.notes.includes('visual-only-uncorroborated')) expect(match.tier).toBe('medium')
        },
      ),
      { numRuns: 20_000 },
    )
  })

  it('any readable printed text lifts the cap: name-only and number-only corroborated reads still reach HIGH', () => {
    const cards = [record('a', 'Pikachu', '58'), record('b', 'Other', '99')]
    const scores: VisualEvidenceByCard = new Map([
      ['a', 0.9],
      ['b', 0.5],
    ])
    const nameOnly = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '' },
      cards,
      scores,
    )
    const numberOnly = matchScannerObservation(
      { rawNameText: '', rawCollectorNumberText: '58/102' },
      cards,
      scores,
    )
    expect(nameOnly.tier).toBe('high')
    expect(numberOnly.tier).toBe('high')
    expect(nameOnly.notes).not.toContain('visual-only-uncorroborated')
  })

  it('text alone tops out at MEDIUM in production (no set text is ever read) — unchanged, so HIGH now always means two independent channels agree', () => {
    const match = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '58/102' },
      [record('a', 'Pikachu', '58'), record('b', 'Other', '99')],
    )
    expect(match.candidates[0]?.rawRankScore).toBe(75) // id exact 45 + name exact 30, no set hint
    expect(match.tier).toBe('medium')
    expect(match.notes).not.toContain('visual-only-uncorroborated')
  })
})

describe('P151 — the visual/text disagreement cap also holds in the MODERATE similarity tier', () => {
  /**
   * Regression for the surviving mutant P130 (B-08 / M7) found: applying the disagreement cap only
   * for a `strong` visual read went unnoticed by every existing test. Here the text-best card A
   * (collector number exact) loses to card B (name exact + a MODERATE 0.79 visual anchor) on raw
   * score by a HIGH-sized margin, yet the two channels disagree about which card it is.
   */
  it('caps HIGH to MEDIUM when a moderate (0.68-0.82) visual read backs a different card than the text does', () => {
    const cardA = record('a', 'Zzzzzz', '45')
    const cardB = record('b', 'Charizard', '99')
    const match = matchScannerObservation(
      { rawNameText: 'Charizard', rawCollectorNumberText: '45/100' },
      [cardA, cardB],
      new Map([['b', 0.79]]),
    )
    expect(match.candidates[0]?.card.cardId).toBe('b')
    const margin =
      (match.candidates[0]?.rawRankScore ?? 0) - (match.candidates[1]?.rawRankScore ?? 0)
    expect(match.candidates[0]?.rawRankScore).toBeGreaterThanOrEqual(SCORING_TIERS.highMinScore)
    expect(margin).toBeGreaterThanOrEqual(SCORING_TIERS.highMinMargin)
    expect(match.notes).toContain('visual-text-disagreement')
    expect(match.tier).toBe('medium')
  })

  it('a WEAK (< 0.68) visual disagreement does not demote otherwise-trustworthy text (documented behaviour, unchanged)', () => {
    const match = matchScannerObservation(
      { rawNameText: 'Charizard', rawCollectorNumberText: '99/100' },
      [record('b', 'Charizard', '99'), record('a', 'Zzzzzz', '45')],
      new Map([['a', 0.6]]),
    )
    expect(match.notes).not.toContain('visual-text-disagreement')
  })
})

describe('P151 — the printing is never inferred (holo / reverse holo / stamp)', () => {
  const holo = { id: 'variant-holo', label: 'Holo' }
  const reverse = { id: 'variant-reverse', label: 'Reverse holo' }

  function atConfirm() {
    const chosen = scannerReducer(initialScannerState, {
      type: 'CONFIRM_CARD_PRESSED',
      candidate: { candidateId: 'card-1', name: 'Pikachu' },
    })
    return chosen
  }

  it('several active printings stay UNCHOSEN and confirming without a choice is refused', () => {
    let state = atConfirm()
    state = scannerReducer(state, { type: 'CONFIRM_VARIANTS_LOADED', variants: [holo, reverse] })
    expect(state.confirmVariantId).toBeNull()
    const refused = scannerReducer(state, { type: 'CARD_CONFIRMED' })
    expect(refused.step).toBe('confirm')
    expect(refused.batch).toHaveLength(0)
    expect(refused.confirmValidationError).toMatch(/version/i)
  })

  it('exactly ONE active printing is preselected (a catalog fact, not an inference)', () => {
    let state = atConfirm()
    state = scannerReducer(state, { type: 'CONFIRM_VARIANTS_LOADED', variants: [holo] })
    expect(state.confirmVariantId).toBe('variant-holo')
  })

  it('a HIGH result preselects the CARD only — the printing is still asked for', () => {
    const analyzed = scannerReducer(initialScannerState, {
      type: 'ANALYSIS_COMPLETED',
      analysis: {
        confidence: 'HIGH',
        candidates: [{ candidateId: 'card-1', name: 'Pikachu' }],
      },
    })
    expect(analyzed.selectedCandidate?.candidateId).toBe('card-1')
    expect(analyzed.confirmVariantId).toBeNull()
  })
})
