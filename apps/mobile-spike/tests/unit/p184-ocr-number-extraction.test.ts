import {
  pickCollectorNumber,
  findSlashTokens,
  type OcrLine,
} from '../../src/features/scanner-native/ocr-adapter'

// The recogniser exposes plain text lines with a vertical position; the collector-number picker
// must prefer a printed "N/M" token in the lower card, and must NOT read HP / damage / weakness
// numbers as a collector number (real vintage cards: "30", "60", "100 HP6", "I00" were picked).
// All text below is invented; no real card text.

const H = 1000
const line = (text: string, topFraction: number): OcrLine => ({
  text,
  confidenceScore: null,
  top: Math.round(topFraction * H),
  height: 30,
})

describe('pickCollectorNumber', () => {
  it('reads a modern printed number at the bottom', () => {
    expect(pickCollectorNumber([line('Sparkfin', 0.05), line('058/191', 0.93)], H)).toBe('058/191')
  })

  it('finds the number INSIDE a long bottom line (illustrator credit + number on one line)', () => {
    const lines = [line('Sparkfin', 0.05), line('Illus. Some Artist   58/102   (c) test', 0.94)]
    expect(pickCollectorNumber(lines, H)).toBe('58/102')
  })

  it('does not mistake mid-card numbers for the collector number', () => {
    const lines = [
      line('Sparkfin', 0.05),
      line('Thunder Jolt does 30 damage', 0.5),
      line('30', 0.7),
      line('60', 0.74),
      line('100 HP6', 0.78),
      line('40 HP', 0.08),
    ]
    expect(pickCollectorNumber(lines, H)).toBeNull()
  })

  it('ignores a fraction-like phrase mid-card ("1/2 the damage")', () => {
    expect(pickCollectorNumber([line('Discard 1/20 of the deck', 0.45)], H)).toBeNull()
  })

  it('reads prefixed ids with a slash and without one', () => {
    expect(pickCollectorNumber([line('TG12/TG30', 0.93)], H)).toBe('TG12/TG30')
    expect(pickCollectorNumber([line('SV049', 0.93)], H)).toBe('SV049')
    expect(pickCollectorNumber([line('H31', 0.95)], H)).toBe('H31')
  })

  it('accepts a bare digit run only in the very bottom band', () => {
    expect(pickCollectorNumber([line('58', 0.96)], H)).toBe('58')
    expect(pickCollectorNumber([line('58', 0.8)], H)).toBeNull()
  })

  it('the LOWEST printed number wins when the text has several', () => {
    const lines = [line('12/34', 0.62), line('058/191', 0.95)]
    expect(pickCollectorNumber(lines, H)).toBe('058/191')
  })

  it('a slash token above the lower band is not trusted', () => {
    expect(pickCollectorNumber([line('058/191', 0.3)], H)).toBeNull()
  })

  it('an empty read is null, never a guess', () => {
    expect(pickCollectorNumber([], H)).toBeNull()
  })

  it('uses the reference height it is given: a 4000 px frame position against a 1600 px height would mislead', () => {
    // 800/4000 = 0.2 of the card (mid-card); against a wrong 1600 reference it would read as 0.5.
    expect(
      pickCollectorNumber([{ text: '30', confidenceScore: null, top: 3400, height: 30 }], 4000),
    ).toBeNull()
    expect(
      pickCollectorNumber([{ text: '30', confidenceScore: null, top: 3900, height: 30 }], 4000),
    ).toBe('30')
  })
})

describe('findSlashTokens', () => {
  it('finds every printed N/M token and reports its position', () => {
    const tokens = findSlashTokens([line('a 1/22 b', 0.4), line('c 058/191', 0.9)])
    expect(tokens.map((t) => t.text)).toEqual(['1/22', '058/191'])
  })

  it('does not match dates, ratios inside longer digit runs or URLs', () => {
    expect(findSlashTokens([line('12/31/2026', 0.9), line('http://x/12/345', 0.9)])).toEqual([])
  })
})
