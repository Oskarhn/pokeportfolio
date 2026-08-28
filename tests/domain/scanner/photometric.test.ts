import { describe, expect, it } from 'vitest'
import {
  normalizePhotometricRgba,
  PHOTOMETRIC_DESATURATION_FRACTION,
  type PhotometricRgbaImage,
} from '../../../src/domain/scanner/photometric'

/**
 * P80 §5 — photometric normalization for the visual-embedding query. Pure/deterministic, mirrors
 * roi.ts's OCR contrast-normalization tests in spirit (percentile stretch, flat-image safety) plus
 * new coverage for the bounded desaturation term this module adds.
 */

function solidImage(width: number, height: number, r: number, g: number, b: number, a = 255) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return { data, width, height }
}

describe('normalizePhotometricRgba', () => {
  it('is deterministic — identical bytes in, identical bytes out', () => {
    const image: PhotometricRgbaImage = {
      data: new Uint8ClampedArray(Array.from({ length: 16 * 16 * 4 }, (_, i) => (i * 37) % 256)),
      width: 16,
      height: 16,
    }
    const a = normalizePhotometricRgba(image)
    const b = normalizePhotometricRgba(image)
    expect([...a.data]).toEqual([...b.data])
  })

  it('a perfectly flat image is returned unchanged (nothing to stretch)', () => {
    const image = solidImage(6, 6, 120, 80, 200)
    const out = normalizePhotometricRgba(image)
    expect([...out.data]).toEqual([...image.data])
  })

  it('stretches a narrow luma histogram toward the full range', () => {
    const width = 10
    const height = 10
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i += 1) {
      const value = 100 + ((i * 7) % 50) // narrow band [100,150)
      data[i * 4] = value
      data[i * 4 + 1] = value
      data[i * 4 + 2] = value
      data[i * 4 + 3] = 255
    }
    const out = normalizePhotometricRgba({ data, width, height }, 0) // no desaturation, isolate contrast
    const values = [...out.data].filter((_, i) => i % 4 === 0)
    expect(Math.min(...values)).toBeLessThanOrEqual(5)
    expect(Math.max(...values)).toBeGreaterThanOrEqual(250)
  })

  it('preserves the alpha channel exactly', () => {
    const image = solidImage(4, 4, 10, 200, 30, 77)
    // Give it SOME luma variance so the stretch branch actually runs (not the flat shortcut).
    image.data[0] = 5
    const out = normalizePhotometricRgba(image)
    for (let i = 0; i < 16; i += 1) expect(out.data[i * 4 + 3]).toBe(77)
  })

  it('desaturation pulls a saturated color toward its own greyscale value', () => {
    // Pure, highly saturated red with a little variance elsewhere so contrast-stretch runs.
    const width = 8
    const height = 8
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = 220 - (i % 20) // slight variance
      data[i * 4 + 1] = 10
      data[i * 4 + 2] = 10
      data[i * 4 + 3] = 255
    }
    const noDesaturation = normalizePhotometricRgba({ data, width, height }, 0)
    const fullDesaturation = normalizePhotometricRgba({ data, width, height }, 1)
    // With desaturationFraction=1, every pixel becomes its own greyscale value -> R/G/B equal.
    for (let i = 0; i < 4; i += 1) {
      const r = fullDesaturation.data[i * 4] ?? 0
      const g = fullDesaturation.data[i * 4 + 1] ?? 0
      const b = fullDesaturation.data[i * 4 + 2] ?? 0
      expect(r).toBe(g)
      expect(g).toBe(b)
    }
    // With no desaturation, the channel SPREAD stays large (red channel well above green/blue).
    const spreadAt = (out: PhotometricRgbaImage, i: number) =>
      (out.data[i * 4] ?? 0) - (out.data[i * 4 + 1] ?? 0)
    expect(spreadAt(noDesaturation, 0)).toBeGreaterThan(spreadAt(fullDesaturation, 0))
  })

  it('the default desaturation fraction is bounded — a real nudge, never full grayscale', () => {
    expect(PHOTOMETRIC_DESATURATION_FRACTION).toBeGreaterThan(0)
    expect(PHOTOMETRIC_DESATURATION_FRACTION).toBeLessThan(0.5)
  })

  it('an empty image never throws', () => {
    expect(() =>
      normalizePhotometricRgba({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
    ).not.toThrow()
  })
})
