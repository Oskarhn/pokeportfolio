import { describe, expect, it } from 'vitest'
import {
  detectCardQuadrilateral,
  rectifyCard,
  toGrayscaleRgba,
  warpPerspective,
  type Point,
  type Quadrilateral,
  type RgbaImage,
} from '../../../src/domain/scanner/rectify'

/**
 * Rectification is pure, platform-neutral math (P79) — every case here runs against synthetic
 * pixel buffers in plain Node, no canvas/DOM needed, matching the project's standing test
 * discipline for the rest of the scanner's geometry/preprocessing code (guide-geometry.test.ts,
 * roi.test.ts).
 */

function solidRgba(
  width: number,
  height: number,
  color: [number, number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = color[0]
    data[i * 4 + 1] = color[1]
    data[i * 4 + 2] = color[2]
    data[i * 4 + 3] = color[3]
  }
  return { data, width, height }
}

/** Point-in-convex-quad via consistent-sign cross products (TL→TR→BR→BL winding). Test-only
 *  fixture helper, deliberately independent of rectify.ts's own internal implementation. */
function pointInQuad(px: number, py: number, quad: Quadrilateral): boolean {
  const pts = [quad.tl, quad.tr, quad.br, quad.bl]
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  let sign = 0
  for (let i = 0; i < 4; i += 1) {
    const a = pts[i] ?? pts[0]!
    const b = pts[(i + 1) % 4] ?? pts[0]!
    const c = cross(a, b, { x: px, y: py })
    if (c === 0) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Paints a filled quadrilateral of `fg` over a `bg`-filled canvas — the synthetic "card on a
 *  table" fixture every detection test builds on. */
function paintQuad(
  width: number,
  height: number,
  bg: [number, number, number, number],
  fg: [number, number, number, number],
  quad: Quadrilateral,
): RgbaImage {
  const image = solidRgba(width, height, bg)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pointInQuad(x + 0.5, y + 0.5, quad)) {
        const idx = (y * width + x) * 4
        image.data[idx] = fg[0]
        image.data[idx + 1] = fg[1]
        image.data[idx + 2] = fg[2]
        image.data[idx + 3] = fg[3]
      }
    }
  }
  return image
}

function rectQuad(left: number, top: number, width: number, height: number): Quadrilateral {
  return {
    tl: { x: left, y: top },
    tr: { x: left + width, y: top },
    bl: { x: left, y: top + height },
    br: { x: left + width, y: top + height },
  }
}

describe('toGrayscaleRgba', () => {
  it('applies the same BT.601 weighting as roi.ts (pinned so both stay in agreement)', () => {
    const image = solidRgba(1, 1, [100, 150, 200, 255])
    const gray = toGrayscaleRgba(image)
    const expected = Math.round(0.299 * 100 + 0.587 * 150 + 0.114 * 200)
    expect(gray.data[0]).toBe(expected)
  })
})

describe('warpPerspective — bilinear quadrilateral resampling', () => {
  it('warping the axis-aligned full-image corners is a plain resize (identity at the corners)', () => {
    const image = solidRgba(10, 10, [10, 20, 30, 255])
    // Overwrite one corner pixel with a distinct color to check corner mapping precisely.
    image.data[0] = 255
    image.data[1] = 0
    image.data[2] = 0
    const warped = warpPerspective(image, rectQuad(0, 0, 9, 9), 5, 5)
    expect(warped.width).toBe(5)
    expect(warped.height).toBe(5)
    // Output (0,0) maps to source (0,0) — the red pixel.
    expect(warped.data[0]).toBe(255)
    expect(warped.data[1]).toBe(0)
  })

  it('a solid-color quad warps to a uniformly solid output (away from any edge blending)', () => {
    const image = paintQuad(
      200,
      200,
      [0, 0, 0, 255],
      [200, 100, 50, 255],
      rectQuad(20, 20, 140, 140),
    )
    const warped = warpPerspective(image, rectQuad(20, 20, 140, 140), 40, 40)
    // Sample well inside the output, away from bilinear edge blending.
    const idx = (20 * 40 + 20) * 4
    expect(warped.data[idx]).toBeCloseTo(200, 0)
    expect(warped.data[idx + 1]).toBeCloseTo(100, 0)
    expect(warped.data[idx + 2]).toBeCloseTo(50, 0)
  })

  it('a skewed (non-axis-aligned) quad still resamples the interior as uniform color', () => {
    const skewed: Quadrilateral = {
      tl: { x: 30, y: 20 },
      tr: { x: 170, y: 25 },
      bl: { x: 25, y: 175 },
      br: { x: 175, y: 170 },
    }
    const image = paintQuad(200, 200, [0, 0, 0, 255], [10, 250, 30, 255], skewed)
    const warped = warpPerspective(image, skewed, 50, 70)
    const idx = (35 * 50 + 25) * 4
    expect(warped.data[idx]).toBeCloseTo(10, 0)
    expect(warped.data[idx + 1]).toBeCloseTo(250, 0)
    expect(warped.data[idx + 2]).toBeCloseTo(30, 0)
  })

  it('never divides by zero or crashes on a 1x1 output', () => {
    const image = solidRgba(10, 10, [1, 2, 3, 255])
    expect(() => warpPerspective(image, rectQuad(0, 0, 9, 9), 1, 1)).not.toThrow()
  })
})

describe('detectCardQuadrilateral', () => {
  it('finds a card whose real edges sit INSIDE the nominal rect (over-generous guide alignment)', () => {
    const trueQuad = rectQuad(60, 55, 120, 168)
    const image = paintQuad(240, 280, [15, 15, 15, 255], [230, 230, 230, 255], trueQuad)
    const gray = toGrayscaleRgba(image)
    // Nominal rect is the GUIDE the user aligned to — larger than the true card, simulating
    // background visible inside the guide.
    const nominal = { left: 40, top: 30, width: 160, height: 220 }
    const detected = detectCardQuadrilateral(gray, nominal, 40)
    expect(detected).not.toBeNull()
    if (detected === null) return
    expect(Math.abs(detected.tl.x - trueQuad.tl.x)).toBeLessThan(4)
    expect(Math.abs(detected.tl.y - trueQuad.tl.y)).toBeLessThan(4)
    expect(Math.abs(detected.br.x - trueQuad.br.x)).toBeLessThan(4)
    expect(Math.abs(detected.br.y - trueQuad.br.y)).toBeLessThan(4)
  })

  it('finds a genuinely SKEWED card (mild hand-held tilt), not just an axis-aligned box', () => {
    const trueQuad: Quadrilateral = {
      tl: { x: 55, y: 48 },
      tr: { x: 185, y: 58 },
      bl: { x: 50, y: 235 },
      br: { x: 180, y: 225 },
    }
    const image = paintQuad(240, 280, [10, 10, 10, 255], [235, 235, 235, 255], trueQuad)
    const gray = toGrayscaleRgba(image)
    const nominal = { left: 50, top: 50, width: 130, height: 180 }
    const detected = detectCardQuadrilateral(gray, nominal, 40)
    expect(detected).not.toBeNull()
    if (detected === null) return
    // Skew direction is preserved (not snapped to axis-aligned): the true quad's top edge tilts
    // down left-to-right (tl.y < tr.y) and its bottom edge tilts UP left-to-right (bl.y > br.y).
    expect(detected.tl.y).toBeLessThan(detected.tr.y)
    expect(detected.bl.y).toBeGreaterThan(detected.br.y)
    expect(Math.abs(detected.tl.x - trueQuad.tl.x)).toBeLessThan(8)
    expect(Math.abs(detected.br.x - trueQuad.br.x)).toBeLessThan(8)
  })

  it('returns null over a uniform image with no real edge to find', () => {
    const image = solidRgba(240, 280, [128, 128, 128, 255])
    const gray = toGrayscaleRgba(image)
    const nominal = { left: 40, top: 30, width: 160, height: 220 }
    expect(detectCardQuadrilateral(gray, nominal, 40)).toBeNull()
  })

  it('rejects a nonsense sliver rect rather than returning a degenerate quadrilateral', () => {
    expect(
      detectCardQuadrilateral(toGrayscaleRgba(solidRgba(50, 50, [1, 1, 1, 255])), {
        left: 10,
        top: 10,
        width: 5,
        height: 5,
      }),
    ).toBeNull()
  })
})

describe('rectifyCard — composed detect + warp with graceful fallback', () => {
  it('falls back to the plain nominal rect (a crop+resize) when nothing plausible is detected', () => {
    const image = solidRgba(240, 280, [90, 90, 90, 255])
    const nominal = { left: 40, top: 30, width: 160, height: 220 }
    const result = rectifyCard(image, nominal, 100, 140)
    expect(result.usedFallback).toBe(true)
    expect(result.image.width).toBe(100)
    expect(result.image.height).toBe(140)
    expect(result.corners.tl).toEqual({ x: nominal.left, y: nominal.top })
  })

  it('uses the detected quadrilateral (not the fallback) when a real card boundary is present', () => {
    const trueQuad = rectQuad(60, 55, 120, 168)
    const image = paintQuad(240, 280, [15, 15, 15, 255], [230, 230, 230, 255], trueQuad)
    const nominal = { left: 40, top: 30, width: 160, height: 220 }
    const result = rectifyCard(image, nominal, 100, 140)
    expect(result.usedFallback).toBe(false)
    // The rectified output should be dominated by the card's own (light) color, not the dark
    // background it was surrounded by — proof the warp sampled from the DETECTED boundary.
    const centerIdx = (70 * 100 + 50) * 4
    expect(result.image.data[centerIdx] ?? 0).toBeGreaterThan(150)
  })

  it('never throws for a degenerate nominal rect (defensive floor)', () => {
    const image = solidRgba(240, 280, [1, 1, 1, 255])
    expect(() => rectifyCard(image, { left: 0, top: 0, width: 2, height: 2 }, 50, 70)).not.toThrow()
  })
})
