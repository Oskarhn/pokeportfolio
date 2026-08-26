import { describe, expect, it } from 'vitest'
import { compareNames } from '../../../src/domain/scanner'

/**
 * Name matching (P67 §8): exact is strong evidence; one-character OCR misses are reasonable;
 * unrelated names must never score strongly just because an edit ratio passes.
 */
describe('compareNames', () => {
  it('treats normalized-identical names as exact', () => {
    expect(compareNames('Pikachu', 'Pikachu')).toBe('exact')
    expect(compareNames('MR. MIME', 'Mr. Mime')).toBe('exact')
    expect(compareNames("Farfetch'd", 'farfetchd')).toBe('exact')
    expect(compareNames('Flabébé', 'Flabebe')).toBe('exact')
    expect(compareNames('Nidoran♀', 'NidoranF')).toBe('exact')
  })

  it('accepts one-character OCR substitutions on real Pokémon names', () => {
    expect(compareNames('P1kachu', 'Pikachu')).toBe('close')
    expect(compareNames('Charizord', 'Charizard')).toBe('close')
    // Gardevoir with a dropped accent/misread middle vowel:
    expect(compareNames('Gordevoir', 'Gardevoir')).toBe('close')
  })

  it('scales tolerance with length — long names allow more edits, short ones almost none', () => {
    expect(compareNames('Mew', 'Mev')).toBe('close')
    // Two edits on a 3-letter name exceed the short-name tolerance:
    expect(compareNames('Mew', 'Abc')).not.toBe('close')
    expect(compareNames('Zapdos', 'Zapdos!'.replace('!', ''))).toBe('exact')
    // A long OCR mangling with several scattered errors stays close:
    expect(compareNames('Blastoise', 'Blastoisc')).toBe('close')
  })

  it('never calls unrelated names close merely because lengths are similar', () => {
    // Same-ish length, genuinely different words: the absolute-distance guard rejects them.
    expect(compareNames('Diglett', 'Pikachu')).toBe('none')
    expect(compareNames('Charizard', 'Venusaur')).toBe('none')
    expect(compareNames('Mewtwo', 'Wailord')).toBe('none')
  })

  it('gives partial credit for containment of a substantial fragment', () => {
    expect(compareNames('Pika', 'Pikachu')).toBe('partial')
    // A one-character tail miss is already within distance tolerance and rates close:
    expect(compareNames('Pikachu', 'Pikachus')).toBe('close')
    // Three-letter fragments inside long names are noise magnets, not signals:
    expect(compareNames('Zek', 'Zekrom')).toBe('none')
  })

  it('rejects too-short observations outright', () => {
    expect(compareNames('', 'Pikachu')).toBe('none')
    expect(compareNames(null, 'Pikachu')).toBe('none')
    expect(compareNames('Pi', 'Pikachu')).toBe('none')
  })
})
