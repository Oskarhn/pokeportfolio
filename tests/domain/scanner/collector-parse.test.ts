import { describe, expect, it } from 'vitest'
import { parseCollectorNumberStructured } from '../../../src/domain/scanner/collector-parse'

/**
 * P85 §8/§16 O85-9/O85-10/O85-11/O85-12 — structured collector-number parsing. Confidence is
 * about STRUCTURAL plausibility, independent of raw OCR confidence: a total ("X/Y") is the
 * strongest signal, a bare numeric id or known prefix is ordinary, and a generic single letter
 * plus a stray digit or two with no corroboration ("Z7", "x2") must never read as meaningful.
 */

describe('parseCollectorNumberStructured', () => {
  it('O85-9: modern format with total — high confidence', () => {
    const result = parseCollectorNumberStructured('049/197')
    expect(result.confidence).toBe('high')
    expect(result.numericComponent).toBe('049')
    expect(result.setTotal).toBe(197)
    expect(result.normalized).toBe('049/197')
  })

  it('O85-11: vintage format with total — high confidence', () => {
    const result = parseCollectorNumberStructured('4/102')
    expect(result.confidence).toBe('high')
    expect(result.setTotal).toBe(102)
  })

  it('O85-10: promo/subset prefix format (TG) without a total — medium confidence', () => {
    const result = parseCollectorNumberStructured('TG01/TG30')
    expect(result.prefix).toBe('TG')
    expect(result.setTotal).toBeNull()
    expect(result.confidence).toBe('medium')
    expect(result.normalized).toBe('TG01')
  })

  it('O85-10: SWSH promo prefix format — medium confidence', () => {
    const result = parseCollectorNumberStructured('SWSH007')
    expect(result.prefix).toBe('SWSH')
    expect(result.confidence).toBe('medium')
  })

  it('SV prefix format — medium confidence', () => {
    const result = parseCollectorNumberStructured('SV123')
    expect(result.prefix).toBe('SV')
    expect(result.confidence).toBe('medium')
  })

  it('the one real single-letter prefix (H, Neo-era Prime) — medium confidence', () => {
    const result = parseCollectorNumberStructured('H31')
    expect(result.confidence).toBe('medium')
  })

  it('bare numeric id, no prefix, no total — medium confidence (ordinary vintage shape)', () => {
    const result = parseCollectorNumberStructured('4')
    expect(result.confidence).toBe('medium')
  })

  it('O85-12: a generic single-letter prefix plus a stray digit is LOW confidence, never high/medium', () => {
    const result = parseCollectorNumberStructured('Z7')
    expect(result.confidence).toBe('low')
  })

  it('O85-12/P85 §7f: a bare 4+-digit run with no total is LOW confidence (real copyright-year false-positive shape)', () => {
    const result = parseCollectorNumberStructured('1995')
    expect(result.confidence).toBe('low')
  })

  it('O85-12: lowercase noise normalizes but still scores LOW confidence', () => {
    const result = parseCollectorNumberStructured('x2')
    expect(result.confidence).toBe('low')
  })

  it('O85-12: text with no digits at all never parses — confidence none', () => {
    const result = parseCollectorNumberStructured('RE')
    expect(result.normalized).toBeNull()
    expect(result.confidence).toBe('none')
  })

  it('empty string never parses', () => {
    const result = parseCollectorNumberStructured('')
    expect(result.confidence).toBe('none')
  })

  it('preserves the raw input verbatim for debuggability', () => {
    const result = parseCollectorNumberStructured('  tg01/tg30  ')
    expect(result.raw).toBe('  tg01/tg30  ')
  })
})
