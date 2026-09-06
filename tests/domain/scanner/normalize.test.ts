import { describe, expect, it } from 'vitest'
import { normalizeCardText, parseLanguageHint } from '../../../src/domain/scanner'

/**
 * Normalization invariants (P67 §6): identical treatment of both comparison sides, accent
 * folding, Pokémon special characters, punctuation — and CONSERVATISM about OCR confusions
 * (digits and letters are never swapped here; that is the collector-number layer's job).
 */
describe('normalizeCardText', () => {
  it('lowercases and collapses whitespace and punctuation noise', () => {
    expect(normalizeCardText('  Pikachu ')).toBe('pikachu')
    expect(normalizeCardText('MR.   MIME')).toBe('mr mime')
    expect(normalizeCardText('Type: Null')).toBe('type null')
  })

  it('folds accented Pokémon names (precomposed and decomposed é agree)', () => {
    // Flabébé appears with precomposed é in TCGdex data; OCR frequently emits decomposed or
    // accent-less text. All three forms must normalize identically.
    const precomposed = 'Flab\u00e9b\u00e9'
    const decomposed = 'Flabe\u0301be\u0301'
    expect(normalizeCardText(precomposed)).toBe(normalizeCardText(decomposed))
    expect(normalizeCardText(precomposed)).toBe('flabebe')
    expect(normalizeCardText(precomposed)).toBe(normalizeCardText('FLABEBE'))
  })

  it("removes apostrophes so Farfetch'd compares as farfetchd", () => {
    expect(normalizeCardText("Farfetch'd")).toBe(normalizeCardText('farfetchd'))
    expect(normalizeCardText('\u2018Mime\u2019')).toBe('mime')
  })

  it('treats hyphens as separators so Ho-Oh has one canonical form', () => {
    expect(normalizeCardText('Ho-Oh')).toBe(normalizeCardText('ho oh'))
    expect(normalizeCardText('Ho-Oh')).toBe('ho oh')
  })

  it('keeps Nidoran♀ and Nidoran♂ DISTINCT — stripping would fabricate ambiguity', () => {
    expect(normalizeCardText('Nidoran\u2640')).not.toBe(normalizeCardText('Nidoran\u2642'))
    expect(normalizeCardText('Nidoran\u2640')).toBe('nidoranf')
    expect(normalizeCardText('Nidoran\u2642')).toBe('nidoranm')
  })

  it('never swaps digits and letters — 0/O and 1/I stay distinct at this layer', () => {
    // Context-sensitive substitutions live ONLY in the collector-number comparator. A name
    // containing a misread digit must not silently become another name.
    expect(normalizeCardText('P0kemon')).not.toBe(normalizeCardText('Pokemon'))
    expect(normalizeCardText('P1kachu')).not.toBe(normalizeCardText('Pikachu'))
    expect(normalizeCardText('Chariz0rd')).not.toBe(normalizeCardText('Charizard'))
  })

  it('preserves non-Latin scripts instead of erasing them', () => {
    // Japanese catalog names are real candidate names (DATA_MODEL.md §3.2). Normalization must
    // not reduce them to '' — that would make unrelated ja cards compare "equal".
    const ja = normalizeCardText('リザードン')
    expect(ja.length).toBeGreaterThan(0)
    expect(normalizeCardText('リザードン')).toBe(ja)
  })
})

describe('parseLanguageHint', () => {
  it('accepts code and word forms', () => {
    expect(parseLanguageHint('en')).toBe('en')
    expect(parseLanguageHint('English')).toBe('en')
    expect(parseLanguageHint('ja')).toBe('ja')
    expect(parseLanguageHint('Japanese')).toBe('ja')
  })

  it('maps unknown hints to null — absence of evidence, never a guess', () => {
    expect(parseLanguageHint(null)).toBeNull()
    expect(parseLanguageHint(undefined)).toBeNull()
    expect(parseLanguageHint('')).toBeNull()
    expect(parseLanguageHint('   ')).toBeNull()
    expect(parseLanguageHint('fr')).toBeNull()
    expect(parseLanguageHint('german')).toBeNull()
  })
})
