import { describe, expect, it } from 'vitest'
import {
  CARD_ASPECT_TOLERANCE,
  FILE_CROP_INSET,
  GUIDE_HEIGHT_FRACTION,
  GUIDE_MAX_WIDTH_FRACTION,
  cardRectFromVideo,
  clampRectToBounds,
  computeGuideRect,
  decideFileCardRect,
  scaleCardRect,
} from '../../src/features/scanner/guide-geometry'

/**
 * The shared guide→source geometry model (prompt §10/I19) and the deterministic file-photo
 * crop policy (prompt §11/I20). These are THE numbers OCR trusts: portrait and landscape
 * sources under object-fit: cover must map the rendered 5:7 guide into source pixels without
 * ever leaving bounds, preserving the centre and the ratio, with stable rounding.
 */

describe('guide rect in element space', () => {
  it('is centred at 58% height while the width fits', () => {
    const rect = computeGuideRect(400, 800)
    expect(rect.height).toBeCloseTo(800 * GUIDE_HEIGHT_FRACTION)
    expect(rect.left + rect.width / 2).toBeCloseTo(200)
    expect(rect.top + rect.height / 2).toBeCloseTo(400)
  })

  it('shrinks height to hold the 5:7 ratio when the width cap binds', () => {
    // Tall narrow element: the 86%-width cap binds, so height follows from the ratio.
    const rect = computeGuideRect(200, 800)
    expect(rect.width).toBeCloseTo(200 * GUIDE_MAX_WIDTH_FRACTION)
    expect(rect.height).toBeCloseTo(rect.width * (7 / 5))
    expect(rect.left + rect.width / 2).toBeCloseTo(100)
    expect(rect.top + rect.height / 2).toBeCloseTo(400)
  })

  it('always keeps exactly the 5:7 aspect', () => {
    const sizes: [number, number][] = [
      [360, 640],
      [1080, 810],
      [320, 480],
      [500, 500],
    ]
    for (const [w, h] of sizes) {
      const rect = computeGuideRect(w, h)
      expect(rect.width / rect.height).toBeCloseTo(5 / 7)
    }
  })
})

describe('cardRectFromVideo — object-fit cover mapping', () => {
  it('portrait source in a portrait viewport maps the guide fully inside', () => {
    // iPhone-style video 1080×1920 shown in a ~390×700 element.
    const rect = cardRectFromVideo(1080, 1920, 390, 700)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.left + rect.width).toBeLessThanOrEqual(1080)
    expect(rect.top + rect.height).toBeLessThanOrEqual(1920)
    expect(rect.width / rect.height).toBeCloseTo(5 / 7, 2)
  })

  it('landscape source in a portrait viewport (cover crops sides) stays centred and bounded', () => {
    // Desktop webcam 1920×1080 displayed in a tall phone-shaped element.
    const elementWidth = 390
    const elementHeight = 700
    const rect = cardRectFromVideo(1920, 1080, elementWidth, elementHeight)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.left + rect.width).toBeLessThanOrEqual(1920)
    expect(rect.top + rect.height).toBeLessThanOrEqual(1080)
    // Cover scales by height here; the horizontal centre of the frame must remain the centre of the rect.
    expect(Math.abs(rect.left + rect.width / 2 - 960)).toBeLessThanOrEqual(1)
    expect(rect.width / rect.height).toBeCloseTo(5 / 7, 1)
  })

  it('portrait source in a landscape viewport (cover crops top/bottom)', () => {
    const rect = cardRectFromVideo(1080, 1920, 1200, 500)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.left + rect.width).toBeLessThanOrEqual(1080)
    expect(rect.top).toBeGreaterThanOrEqual(0)
    expect(rect.top + rect.height).toBeLessThanOrEqual(1920)
    expect(Math.abs(rect.top + rect.height / 2 - 960)).toBeLessThanOrEqual(1)
  })

  it('never produces an empty rect', () => {
    const rect = cardRectFromVideo(640, 480, 100, 50)
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('rounding is stable — identical inputs give identical integers', () => {
    const a = cardRectFromVideo(1080, 1920, 391, 703)
    const b = cardRectFromVideo(1080, 1920, 391, 703)
    expect(a).toEqual(b)
    expect(Number.isInteger(a.left)).toBe(true)
    expect(Number.isInteger(a.width)).toBe(true)
  })

  it('refuses impossible dimensions instead of guessing geometry', () => {
    expect(() => cardRectFromVideo(0, 0, 100, 100)).toThrow()
    expect(() => cardRectFromVideo(1080, 1920, 0, 0)).toThrow()
  })
})

describe('clamping and scaling helpers', () => {
  it('clampRectToBounds pulls rects back inside the frame', () => {
    const clamped = clampRectToBounds({ left: -20, top: -10, width: 90, height: 80 }, 100, 100)
    expect(clamped.left).toBe(0)
    expect(clamped.top).toBe(0)
    expect(clamped.left + clamped.width).toBeLessThanOrEqual(100)
    expect(clamped.top + clamped.height).toBeLessThanOrEqual(100)
  })

  it('scaleCardRect rescales into captured pixel space with integer output', () => {
    const scaled = scaleCardRect({ left: 100, top: 50, width: 300, height: 420 }, 0.5, 0.5)
    expect(scaled).toEqual({ left: 50, top: 25, width: 150, height: 210 })
  })
})

describe('file-photo card-rect policy (I20)', () => {
  it('a photo already shaped like a card uses the FULL image as the card rect', () => {
    const rect = decideFileCardRect(700, 980) // aspect ≈ 0.714
    expect(rect).toEqual({ left: 0, top: 0, width: 700, height: 980 })
  })

  it('tolerance around the card shape still counts as full-frame', () => {
    const rect = decideFileCardRect(700, 900) // aspect 0.777 — inside ±CARD_ASPECT_TOLERANCE
    expect(Math.abs(0.777 - 5 / 7)).toBeLessThanOrEqual(CARD_ASPECT_TOLERANCE)
    expect(rect).toEqual({ left: 0, top: 0, width: 700, height: 900 })
  })

  it('a wide photo gets a conservative centred 5:7 crop, inset from the edges', () => {
    const rect = decideFileCardRect(2000, 1000)
    expect(rect.width / rect.height).toBeCloseTo(5 / 7, 2)
    // Inset: smaller than the largest inscribed 5:7 rect by FILE_CROP_INSET.
    const largestHeight = 1000
    const largestWidth = largestHeight * (5 / 7)
    expect(rect.height).toBeLessThan(largestHeight)
    expect(rect.width).toBeLessThan(largestWidth)
    expect(Math.abs(rect.left + rect.width / 2 - 1000)).toBeLessThanOrEqual(1)
    expect(Math.abs(rect.top + rect.height / 2 - 500)).toBeLessThanOrEqual(1)
  })

  it('a tall photo gets the same treatment rotated', () => {
    const rect = decideFileCardRect(1000, 2400)
    expect(rect.width / rect.height).toBeCloseTo(5 / 7, 2)
    expect(rect.height).toBeLessThan(2400)
    expect(rect.left).toBeGreaterThanOrEqual(0)
    expect(rect.top).toBeGreaterThanOrEqual(0)
  })

  it('the policy is deterministic — same image twice, same rect', () => {
    expect(decideFileCardRect(4032, 3024)).toEqual(decideFileCardRect(4032, 3024))
  })

  it('inset constant is genuinely conservative', () => {
    expect(FILE_CROP_INSET).toBeGreaterThan(0.75)
    expect(FILE_CROP_INSET).toBeLessThan(1)
  })

  it('refuses dimension-less images', () => {
    expect(() => decideFileCardRect(0, 100)).toThrow()
  })
})
