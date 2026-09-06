import { describe, expect, it } from 'vitest'
import {
  preprocessRgbaForDino,
  DINO_CROP_SIZE,
  DINO_IMAGE_MEAN,
  DINO_IMAGE_STD,
  DINO_RESCALE_FACTOR,
} from '../../../src/domain/scanner/dino-preprocess'
import type { RgbaImage } from '../../../src/domain/scanner/rectify'

/**
 * P96/D-107 — canvas-free DINOv2 preprocessing, the WebKit/OffscreenCanvas fix's core module. See
 * scripts/scanner-preprocess-parity/ for the real retrieval-outcome parity benchmark against the
 * library's own AutoProcessor path; these tests pin the module's own arithmetic in isolation
 * (shape, range, known-input-known-output cases), which the parity benchmark alone cannot do
 * cheaply in CI.
 */

function solidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return { data, width, height }
}

function expectedNormalized(byteValue: number, channel: 0 | 1 | 2): number {
  return (byteValue * DINO_RESCALE_FACTOR - DINO_IMAGE_MEAN[channel]) / DINO_IMAGE_STD[channel]
}

describe('preprocessRgbaForDino', () => {
  it('always returns a [3, 224, 224] CHW tensor regardless of input shape', () => {
    const cases: [number, number][] = [
      [700, 980], // portrait iPhone-crop-like
      [980, 700], // landscape
      [224, 224], // already exactly the crop size — no resize/crop should be a no-op path
      [256, 256], // exactly the resize target on both dims
      [301, 407], // odd, non-round dimensions
      [4032, 3024], // large real iPhone photo dimensions
      [225, 225], // one pixel over the crop size on both dims
    ]
    for (const [width, height] of cases) {
      const result = preprocessRgbaForDino(solidRgba(width, height, 100, 150, 200))
      expect(result.dims).toEqual([3, DINO_CROP_SIZE, DINO_CROP_SIZE])
      expect(result.data.length).toBe(3 * DINO_CROP_SIZE * DINO_CROP_SIZE)
    }
  })

  it('normalizes a solid-color image to the exact expected per-channel value everywhere', () => {
    // A solid color survives resize/crop unchanged (bilinear of a constant field is that same
    // constant), so every output pixel must equal the direct rescale+normalize formula exactly.
    const result = preprocessRgbaForDino(solidRgba(512, 512, 128, 64, 32))
    const plane = DINO_CROP_SIZE * DINO_CROP_SIZE
    const expectedR = expectedNormalized(128, 0)
    const expectedG = expectedNormalized(64, 1)
    const expectedB = expectedNormalized(32, 2)
    for (let p = 0; p < plane; p += 1) {
      expect(result.data[p]).toBeCloseTo(expectedR, 5)
      expect(result.data[plane + p]).toBeCloseTo(expectedG, 5)
      expect(result.data[2 * plane + p]).toBeCloseTo(expectedB, 5)
    }
  })

  it('ignores the alpha channel entirely (RGBA transparency edge case)', () => {
    const opaque = preprocessRgbaForDino(solidRgba(400, 400, 200, 100, 50, 255))
    const transparent = preprocessRgbaForDino(solidRgba(400, 400, 200, 100, 50, 0))
    expect(Array.from(transparent.data)).toEqual(Array.from(opaque.data))
  })

  it('produces every value inside the theoretical normalized range for byte input [0,255]', () => {
    // A wide gradient exercises resize/crop with real spatial variation, not a constant field.
    const width = 600
    const height = 450
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        data[i] = Math.floor((x / width) * 255)
        data[i + 1] = Math.floor((y / height) * 255)
        data[i + 2] = 128
        data[i + 3] = 255
      }
    }
    const result = preprocessRgbaForDino({ data, width, height })
    const plane = DINO_CROP_SIZE * DINO_CROP_SIZE
    const minR = expectedNormalized(0, 0)
    const maxR = expectedNormalized(255, 0)
    for (let p = 0; p < plane; p += 1) {
      const v = result.data[p]!
      expect(v).toBeGreaterThanOrEqual(minR - 1e-6)
      expect(v).toBeLessThanOrEqual(maxR + 1e-6)
    }
    expect(result.data.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('center-crops symmetrically: a color block centered in the source stays centered after crop', () => {
    // Bilinear resize of a hard-edged block is not pixel-exact, but the RESULT must still be
    // horizontally/vertically symmetric for a source that is itself symmetric — a real geometry
    // regression (e.g. an off-by-one crop offset) would break this symmetry, a resize-algorithm
    // choice would not.
    // Square source: the resize scale factor is identical on both axes and the post-resize
    // dimension (256x256) minus the crop size (224) is exactly 32 either way, so the center-crop
    // offset is an exact integer on both axes with no floor-rounding asymmetry to account for.
    const width = 800
    const height = 800
    // Block boundaries are computed symmetrically around the true pixel-grid center
    // ((width-1)/2, (height-1)/2), not via independent `x > lo && x < hi` fractions — those are
    // only symmetric when both cutoffs land on integers AND the block's pixel count is even in a
    // way that matches the grid's own center, which `0.4*width`/`0.6*width` does not guarantee.
    const halfBlock = width * 0.1
    const data = new Uint8ClampedArray(width * height * 4)
    data.fill(20) // dark background, alpha included harmlessly (overwritten below for RGB)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4
        const inBlock =
          Math.abs(x - (width - 1) / 2) < halfBlock && Math.abs(y - (height - 1) / 2) < halfBlock
        const v = inBlock ? 240 : 20
        data[i] = v
        data[i + 1] = v
        data[i + 2] = v
        data[i + 3] = 255
      }
    }
    const result = preprocessRgbaForDino({ data, width, height })
    const size = DINO_CROP_SIZE
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const mirroredX = size - 1 - x
        const mirroredY = size - 1 - y
        const v = result.data[y * size + x]!
        const mirrored = result.data[mirroredY * size + mirroredX]!
        expect(v).toBeCloseTo(mirrored, 3)
      }
    }
  })

  it('is a pure function: calling it twice on identical input gives byte-identical output', () => {
    const image = solidRgba(701, 933, 77, 88, 99)
    const a = preprocessRgbaForDino(image)
    const b = preprocessRgbaForDino(image)
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
  })
})
