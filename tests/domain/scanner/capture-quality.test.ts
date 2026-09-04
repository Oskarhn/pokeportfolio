import { describe, expect, it } from 'vitest'
import {
  computeBlurScore,
  shouldAbstainForBlur,
  BLUR_ABSTAIN_THRESHOLD,
} from '../../../src/domain/scanner/capture-quality'
import type { RgbaImage } from '../../../src/domain/scanner/rectify'

/**
 * P91 §15/§36 — capture-quality abstention gate (D-103). See the module header for the honest
 * scope this is calibrated against: it detects severe blur specifically, not bad captures in
 * general (P91's benchmark showed near-zero recall on the non-blurry geometry-only failure mode).
 */

function solidImage(width: number, height: number, r: number, g: number, b: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

/** A checkerboard has maximal local contrast at every interior pixel — the sharpest possible
 *  synthetic image for a Laplacian-variance metric. */
function checkerboard(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      const value = (x + y) % 2 === 0 ? 255 : 0
      data[i * 4] = value
      data[i * 4 + 1] = value
      data[i * 4 + 2] = value
      data[i * 4 + 3] = 255
    }
  }
  return { data, width, height }
}

/** A smooth horizontal gradient — no sharp edges anywhere, a proxy for a heavily blurred photo. */
function smoothGradient(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x
      const value = Math.round((x / Math.max(1, width - 1)) * 255)
      data[i * 4] = value
      data[i * 4 + 1] = value
      data[i * 4 + 2] = value
      data[i * 4 + 3] = 255
    }
  }
  return { data, width, height }
}

describe('computeBlurScore', () => {
  it('is deterministic — identical bytes in, identical score out', () => {
    const image = checkerboard(64, 64)
    expect(computeBlurScore(image)).toBe(computeBlurScore(image))
  })

  it('a perfectly flat image scores ~zero (no edges at all, modulo float64 noise)', () => {
    const image = solidImage(64, 64, 128, 128, 128)
    expect(computeBlurScore(image)).toBeCloseTo(0, 20)
  })

  it('a high-frequency checkerboard scores far higher than a smooth gradient of the same size', () => {
    const sharp = computeBlurScore(checkerboard(64, 64))
    const smooth = computeBlurScore(smoothGradient(64, 64))
    expect(sharp).toBeGreaterThan(smooth)
    // Not just "greater" — the whole premise of the gate is a large, usable separation.
    expect(sharp).toBeGreaterThan(smooth * 10)
  })

  it('handles images smaller than the internal downsample target without throwing', () => {
    expect(() => computeBlurScore(checkerboard(4, 4))).not.toThrow()
    expect(() => computeBlurScore(solidImage(1, 1, 0, 0, 0))).not.toThrow()
  })

  it('handles a zero-area image without throwing', () => {
    const image: RgbaImage = { data: new Uint8ClampedArray(0), width: 0, height: 0 }
    expect(computeBlurScore(image)).toBe(0)
  })
})

describe('shouldAbstainForBlur', () => {
  it('does not abstain on a sharp checkerboard at the default threshold', () => {
    expect(shouldAbstainForBlur(checkerboard(128, 128))).toBe(false)
  })

  it('abstains on a perfectly flat (zero-variance) image at the default threshold', () => {
    expect(shouldAbstainForBlur(solidImage(128, 128, 128, 128, 128))).toBe(true)
  })

  it('honors a caller-supplied threshold override', () => {
    const image = checkerboard(128, 128)
    const score = computeBlurScore(image)
    expect(shouldAbstainForBlur(image, score + 1)).toBe(true)
    expect(shouldAbstainForBlur(image, score - 1)).toBe(false)
  })

  it('the exported default threshold is the P91-calibrated constant, not a placeholder', () => {
    expect(BLUR_ABSTAIN_THRESHOLD).toBe(378)
  })
})
