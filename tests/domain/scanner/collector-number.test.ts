import { describe, expect, it } from 'vitest'
import { compareCollectorNumber, parseCollectorNumber } from '../../../src/domain/scanner'

/**
 * Collector-number parsing against REAL catalog shapes (P67 §7). Canonical local_id examples
 * from DATA_MODEL.md §3.1 and the M5 migrations: "4", "112", "001/165", "SV049", "TG12", "H31".
 * Observed scan shapes per prompt: "123/198", "001/078", "TG01/TG30", "SV001/SV122",
 * "GG01/GG70", promo-like ids, single ids without totals.
 */
describe('parseCollectorNumber — canonical observed shapes', () => {
  it('parses plain modern numbering with total', () => {
    const parsed = parseCollectorNumber('123/198')
    expect(parsed).toMatchObject({ prefix: '', numericText: '123', suffix: '', total: 198 })
    expect(parsed?.numeric).toBe(123)
  })

  it('parses zero-padded older numbering', () => {
    expect(parseCollectorNumber('001/078')).toMatchObject({
      prefix: '',
      numericText: '001',
      numeric: 1,
      suffix: '',
      total: 78,
    })
  })

  it('keeps prefixed sub-numberings intact (Trainer Gallery / Shiny Vault style)', () => {
    expect(parseCollectorNumber('TG01/TG30')).toMatchObject({
      prefix: 'TG',
      numericText: '01',
      numeric: 1,
      suffix: '',
      // The right side of TG01/TG30 is another LOCAL ID, not a total — inventing one would be
      // fabrication, so total stays null.
      total: null,
    })
    expect(parseCollectorNumber('GG01/GG70')).toMatchObject({
      prefix: 'GG',
      numeric: 1,
      total: null,
    })
    expect(parseCollectorNumber('SV001/SV122')).toMatchObject({
      prefix: 'SV',
      numericText: '001',
      numeric: 1,
      total: null,
    })
  })

  it('parses bare ids without totals', () => {
    expect(parseCollectorNumber('4')).toMatchObject({ prefix: '', numeric: 4, total: null })
    expect(parseCollectorNumber('H31')).toMatchObject({ prefix: 'H', numeric: 31 })
    expect(parseCollectorNumber('112')).toMatchObject({ prefix: '', numeric: 112 })
  })

  it('is case-insensitive on the prefix', () => {
    expect(parseCollectorNumber('tg02')).toMatchObject({ prefix: 'TG', numeric: 2 })
  })

  it('recovers OCR-inserted spaces inside one token ("SV0 01" → SV001)', () => {
    expect(parseCollectorNumber('SV0 01')).toMatchObject({ prefix: 'SV', numericText: '001' })
    expect(parseCollectorNumber('T G0 4')).toMatchObject({ prefix: 'TG', numericText: '04' })
  })

  it('recovers a LOST SLASH as number + total ("123 198")', () => {
    expect(parseCollectorNumber('123 198')).toMatchObject({ numeric: 123, total: 198 })
    expect(parseCollectorNumber('4 102')).toMatchObject({ numeric: 4, total: 102 })
    // Two pure-digit groups is the lost-slash shape; a lettered first group joins instead so
    // this never misreads as number+total:
    expect(parseCollectorNumber('SV0 01')).toMatchObject({ prefix: 'SV', numeric: 1, total: null })
  })

  it('folds conservative OCR letter confusions ONLY in id context', () => {
    // I/l read for 1 inside what should be digits:
    expect(compareCollectorNumber(parseCollectorNumber('II2'), '112')).toBe('folded')
    // O read for 0 in a prefixed id: the greedy letter prefix absorbs the O's at parse time,
    // so this recovers through the whole-id fold comparison — folded strength, never exact.
    expect(compareCollectorNumber(parseCollectorNumber('SVOO1'), 'SV001')).toBe('folded')
    expect(compareCollectorNumber(parseCollectorNumber('SVOO1'), 'SV001')).not.toBe('exact')
    // S read for 5:
    expect(compareCollectorNumber(parseCollectorNumber('TGS1'), 'TG51')).toBe('folded')
  })

  it('never folds digit-less prose into an id (fail closed)', () => {
    // "PIKACHU" contains no digit, so no id structure may be manufactured from it.
    expect(parseCollectorNumber('Pikachu')).toBeNull()
  })

  it('fails closed on noise — no digit-bearing structure means null', () => {
    expect(parseCollectorNumber('')).toBeNull()
    expect(parseCollectorNumber('   ')).toBeNull()
    expect(parseCollectorNumber('Pikachu')).toBeNull()
    expect(parseCollectorNumber('///')).toBeNull()
    expect(parseCollectorNumber('--')).toBeNull()
  })

  it('ignores junk after the total instead of guessing', () => {
    expect(parseCollectorNumber('123/198 x2')).toMatchObject({ numeric: 123, total: 198 })
  })
})

describe('compareCollectorNumber — evidence levels vs canonical local_id', () => {
  it('rates exact matches across padding differences ("001" vs "1")', () => {
    const observed = parseCollectorNumber('001')
    expect(compareCollectorNumber(observed, '1')).toBe('exact')
    expect(compareCollectorNumber(observed, '001/165')).toBe('exact')
  })

  it('matches canonical local_ids that literally carry a total', () => {
    // DATA_MODEL.md §3.1 documents stored rows like "001/165".
    const observed = parseCollectorNumber('001/165')
    expect(compareCollectorNumber(observed, '001/165')).toBe('exact')
    expect(compareCollectorNumber(observed, '1')).toBe('exact')
  })

  it('prefers exact over folded when both could apply', () => {
    expect(compareCollectorNumber(parseCollectorNumber('TG01'), 'TG01')).toBe('exact')
  })

  it('downgrades S/O/I/L fold recoveries to "folded", never exact', () => {
    // The known collision class: a letter prefix folding into digits ("SO1" ≈ "501") must
    // support a candidate at reduced strength, never certify it.
    expect(compareCollectorNumber(parseCollectorNumber('SO1'), '501')).toBe('folded')
  })

  it('reports numeric-only when prefixes differ', () => {
    expect(compareCollectorNumber(parseCollectorNumber('TG04'), 'GG04')).toBe('numeric')
  })

  it('returns none for different numbers and for absent observations', () => {
    expect(compareCollectorNumber(parseCollectorNumber('123'), '456')).toBe('none')
    expect(compareCollectorNumber(null, '123')).toBe('none')
  })

  it('never confuses two distinct real ids through the fold', () => {
    // The fold is allowed to collide ("S01"/"501") but that collision must stay at "folded"
    // strength; genuinely distinct ids without a fold path stay distinct.
    expect(compareCollectorNumber(parseCollectorNumber('TG01'), 'TG02')).toBe('none')
    expect(compareCollectorNumber(parseCollectorNumber('H31'), 'H32')).toBe('none')
  })
})
