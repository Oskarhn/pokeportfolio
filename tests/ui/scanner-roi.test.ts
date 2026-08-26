import { describe, expect, it } from 'vitest'
import {
  NAME_ROI_FRACTIONS,
  NUMBER_ROI_FRACTIONS,
  normalizeContrast,
  roiPixelRect,
  toGrayscale,
  ROI_UPSCALE_MIN_HEIGHT_PX,
  type GrayImage,
} from '../../src/features/scanner/roi'

/**
 * ROI extraction + preprocessing rules (prompt §14/§15). The fraction constants are the single
 * researched definition (name strip top-left; collector number bottom-right) and every mapped
 * rect must stay strictly inside its card. Preprocessing is deterministic byte-for-byte.
 */

function grayOf(width: number, height: number, fill: number): GrayImage {
  return { data: new Uint8ClampedArray(width * height).fill(fill), width, height }
}

describe('ROI fraction constants', () => {
  it('name strip = top ~20%, left ~62% of the card', () => {
    expect(NAME_ROI_FRACTIONS.top).toBe(0)
    expect(NAME_ROI_FRACTIONS.left).toBe(0)
    expect(NAME_ROI_FRACTIONS.height).toBeCloseTo(0.2)
    expect(NAME_ROI_FRACTIONS.width).toBeCloseTo(0.62)
    expect(NAME_ROI_FRACTIONS.left + NAME_ROI_FRACTIONS.width).toBeLessThanOrEqual(1)
  })

  it('collector-number strip = bottom ~13%, right ~55% of the card', () => {
    expect(NUMBER_ROI_FRACTIONS.top).toBeCloseTo(0.87)
    expect(NUMBER_ROI_FRACTIONS.left).toBeCloseTo(0.45)
    expect(NUMBER_ROI_FRACTIONS.height).toBeCloseTo(0.13)
    expect(NUMBER_ROI_FRACTIONS.width).toBeCloseTo(0.55)
    expect(NUMBER_ROI_FRACTIONS.left + NUMBER_ROI_FRACTIONS.width).toBeLessThanOrEqual(1)
    expect(NUMBER_ROI_FRACTIONS.top + NUMBER_ROI_FRACTIONS.height).toBeLessThanOrEqual(1)
  })
})

describe('roiPixelRect mapping', () => {
  const card = { left: 100, top: 200, width: 500, height: 700 }

  it('maps fractions into absolute pixels inside the CARD rect', () => {
    const name = roiPixelRect(card, NAME_ROI_FRACTIONS)
    expect(name.left).toBe(100)
    expect(name.top).toBe(200)
    expect(name.width).toBe(Math.round(500 * 0.62))
    expect(name.height).toBe(Math.round(700 * 0.2))
  })

  it('number strip hugs the bottom-right corner of the card', () => {
    const number = roiPixelRect(card, NUMBER_ROI_FRACTIONS)
    expect(number.left + number.width).toBe(600)
    expect(number.top + number.height).toBe(900)
    expect(number.left).toBeGreaterThan(card.left)
  })

  it('never leaves the card bounds even for odd dimensions', () => {
    const sizes: [number, number][] = [
      [37, 51],
      [1280, 1792],
      [11, 13],
    ]
    for (const [w, h] of sizes) {
      for (const fractions of [NAME_ROI_FRACTIONS, NUMBER_ROI_FRACTIONS]) {
        const rect = roiPixelRect({ left: 3, top: 7, width: w, height: h }, fractions)
        expect(rect.left).toBeGreaterThanOrEqual(3)
        expect(rect.top).toBeGreaterThanOrEqual(7)
        expect(rect.left + rect.width).toBeLessThanOrEqual(3 + w)
        expect(rect.top + rect.height).toBeLessThanOrEqual(7 + h)
      }
    }
  })

  it('is stable under repeated evaluation', () => {
    expect(roiPixelRect(card, NUMBER_ROI_FRACTIONS)).toEqual(
      roiPixelRect(card, NUMBER_ROI_FRACTIONS),
    )
  })
})

describe('preprocessing determinism', () => {
  it('toGrayscale uses BT.601 luma', () => {
    const rgb: GrayImage = {
      data: new Uint8ClampedArray([
        255,
        0,
        0,
        255, // pure red
        0,
        255,
        0,
        255, // pure green
        0,
        0,
        255,
        255, // pure blue
        255,
        255,
        255,
        255, // white
      ]),
      width: 2,
      height: 2,
    }
    const gray = toGrayscale(rgb)
    expect(gray.data[0]).toBe(Math.round(0.299 * 255))
    expect(gray.data[1]).toBe(Math.round(0.587 * 255))
    expect(gray.data[2]).toBe(Math.round(0.114 * 255))
    expect(gray.data[3]).toBe(255)
  })

  it('normalizeContrast stretches a narrow histogram to full range', () => {
    // All values between 100 and 150 → stretched so low≈0 and high≈255.
    const image = grayOf(10, 10, 125)
    for (let i = 0; i < image.data.length; i += 1) {
      image.data[i] = 100 + ((i * 7) % 50)
    }
    const out = normalizeContrast(image)
    const min = Math.min(...out.data)
    const max = Math.max(...out.data)
    expect(min).toBeLessThanOrEqual(5)
    expect(max).toBeGreaterThanOrEqual(250)
  })

  it('normalizeContrast is deterministic — identical bytes in, identical bytes out', () => {
    const image = grayOf(8, 8, 90)
    for (let i = 0; i < image.data.length; i += 1) image.data[i] = (i * 31) % 256
    const a = normalizeContrast(image)
    const b = normalizeContrast(image)
    expect([...a.data]).toEqual([...b.data])
  })

  it('a flat image stays flat instead of amplifying noise', () => {
    const out = normalizeContrast(grayOf(4, 4, 120))
    expect(new Set(out.data).size).toBe(1)
  })

  it('the upscale threshold is small enough to matter only for thin strips', () => {
    expect(ROI_UPSCALE_MIN_HEIGHT_PX).toBeGreaterThanOrEqual(24)
    expect(ROI_UPSCALE_MIN_HEIGHT_PX).toBeLessThanOrEqual(96)
  })
})
