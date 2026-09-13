import { describe, expect, it } from 'vitest'
import {
  cardRectInWorkingSpace,
  detectionMarginPx,
  detectionWorkingScale,
  expandRectForDetection,
  rectifyCapture,
  RECTIFY_EXPAND_FRACTION,
  type CapturedFrame,
} from '../../src/features/scanner/rectify-capture'

/**
 * The canvas-drawing orchestration itself needs a real browser (same standing precedent as
 * capture.ts's own tests), but every genuine geometry decision here is pure and pinned in plain
 * Node — this is the P79 "prove what image space is being cropped from" mapping (prompt §6/Q1).
 */

describe('expandRectForDetection', () => {
  it('grows every side by the fraction, clamped to the frame bounds', () => {
    const grown = expandRectForDetection(
      { left: 100, top: 100, width: 200, height: 280 },
      0.2,
      1000,
      1000,
    )
    expect(grown).toEqual({ left: 60, top: 44, width: 280, height: 392 })
  })

  it('clamps against the frame edge instead of producing negative/out-of-bounds coordinates', () => {
    const grown = expandRectForDetection(
      { left: 5, top: 5, width: 100, height: 140 },
      0.5,
      1000,
      1000,
    )
    expect(grown.left).toBe(0)
    expect(grown.top).toBe(0)
  })

  it('a cardRect already covering the whole frame (file uploads) cannot expand past it', () => {
    const grown = expandRectForDetection(
      { left: 0, top: 0, width: 500, height: 700 },
      RECTIFY_EXPAND_FRACTION,
      500,
      700,
    )
    expect(grown).toEqual({ left: 0, top: 0, width: 500, height: 700 })
  })
})

describe('detectionWorkingScale', () => {
  it('never upscales a source already under the bound', () => {
    expect(detectionWorkingScale(300, 400, 1000)).toBe(1)
  })

  it('shrinks proportionally when the long edge exceeds the bound', () => {
    expect(detectionWorkingScale(2000, 1000, 1000)).toBe(0.5)
  })
})

describe('cardRectInWorkingSpace', () => {
  it('maps the original cardRect into the working canvas local coordinates, scaled', () => {
    const cardRect = { left: 100, top: 100, width: 200, height: 280 }
    const expandedRect = { left: 60, top: 44, width: 280, height: 392 }
    const mapped = cardRectInWorkingSpace(cardRect, expandedRect, 0.5)
    // The card sits 40px right/56px down from the expanded region's own top-left, at full scale;
    // at 0.5 working scale that's 20/28, and the card's own 200x280 becomes 100x140.
    expect(mapped).toEqual({ left: 20, top: 28, width: 100, height: 140 })
  })

  it('is the identity when there is no expansion at all', () => {
    const rect = { left: 0, top: 0, width: 500, height: 700 }
    expect(cardRectInWorkingSpace(rect, rect, 1)).toEqual(rect)
  })
})

describe('detectionMarginPx', () => {
  it('is half the tighter dimension of expansion room, scaled', () => {
    const cardRect = { left: 100, top: 100, width: 200, height: 280 }
    const expandedRect = { left: 60, top: 44, width: 280, height: 392 }
    // room = min((280-200)/2, (392-280)/2) = min(40, 56) = 40, scaled by 0.5 => 20.
    expect(detectionMarginPx(cardRect, expandedRect, 0.5)).toBe(20)
  })

  it('floors to a small real margin when there is zero expansion room', () => {
    const rect = { left: 0, top: 0, width: 500, height: 700 }
    expect(detectionMarginPx(rect, rect, 1)).toBeGreaterThanOrEqual(12)
  })
})

describe('rectifyCapture — graceful degradation', () => {
  function frame(): CapturedFrame {
    return {
      blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
      width: 400,
      height: 560,
      cardRect: { left: 40, top: 40, width: 320, height: 448 },
    }
  }

  it('never throws and falls back to the original capture when createImageBitmap is unavailable', async () => {
    const capture = frame()
    const result = await rectifyCapture(capture)
    expect(result.usedFallback).toBe(true)
    expect(result.corners).toBeNull()
    expect(result.frame).toBe(capture)
    expect(result.debugRawCropBlob).toBeNull()
  })

  it('debug mode still degrades to the same fallback shape, never throwing', async () => {
    const result = await rectifyCapture(frame(), { debug: true })
    expect(result.usedFallback).toBe(true)
    expect(result.debugRawCropBlob).toBeNull()
  })
})
