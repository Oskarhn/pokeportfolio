/**
 * Card rectification (P79): turns a phone capture that may be tilted, off-centre inside its
 * guide, or surrounded by background into a canonical, document-like card image BEFORE anything
 * embeds or reads it. Pure and platform-neutral — plain RGBA/greyscale typed arrays in, typed
 * arrays out, no DOM/canvas anywhere in this file — so the exact same code runs in the browser
 * worker path (`src/features/scanner/rectify-capture.ts`) and in the offline Node benchmark
 * (`scripts/scanner-visual-benchmark`), the same shared-implementation discipline the embedding
 * pipeline already holds (visual-worker.ts / embed.mjs).
 *
 * Two independent pieces:
 *
 * 1. {@link detectCardQuadrilateral} — given a greyscale image and a NOMINAL rectangle (where the
 *    card should roughly be — the guide rect the user aligned to), searches a bounded margin band
 *    around each of its four sides for the card's actual edge (a Sobel gradient-magnitude ridge),
 *    fits a line per side with simple outlier rejection, and intersects adjacent lines into four
 *    corners. A battery of sanity checks (convexity, angle, size, aspect) rejects anything that
 *    doesn't look like a plausible card boundary — returning null (never a wild guess) so the
 *    caller can fall back to the plain nominal rectangle.
 *
 * 2. {@link warpPerspective} — resamples a quadrilateral region of a source RGBA image onto a
 *    canonical output rectangle via BILINEAR QUADRILATERAL INTERPOLATION (not a full projective
 *    homography — see the function doc for why that's a deliberate, disclosed simplification).
 *
 * {@link rectifyCard} composes both: on detection failure it warps the plain nominal rectangle
 * instead (mathematically a crop+resize, since bilinear-interpolating an axis-aligned rectangle's
 * corners is exactly that) — so "rectification failed" and "no rectification requested" produce
 * pixel-identical output through the same one code path, never a second special case.
 */

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Quadrilateral {
  readonly tl: Point
  readonly tr: Point
  readonly bl: Point
  readonly br: Point
}

export interface RectPixelRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface GrayImage {
  readonly data: Uint8ClampedArray | Float32Array
  readonly width: number
  readonly height: number
}

export interface RgbaImage {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** How far, in pixels, the edge search is allowed to look outward/inward from the nominal side —
 *  the margin the caller must have included in the source image around the nominal rect. */
export const DEFAULT_EDGE_SEARCH_MARGIN_PX = 48
/** Sample lines per side when hunting for the card boundary. */
const SAMPLES_PER_SIDE = 16
/** Fraction inset from each side's own corners before sampling starts — avoids corner artefacts
 *  (rounded card corners, guide-overlay corner glyphs) from contaminating the line fit. */
const SIDE_SAMPLE_INSET_FRACTION = 0.12
/** A sample point whose fitted-line residual exceeds this many multiples of the median absolute
 *  residual is treated as an outlier and dropped before refitting once. */
const OUTLIER_RESIDUAL_MULTIPLE = 3
/** Minimum plausible interior angle (degrees) — rejects near-degenerate quads from noise. */
const MIN_CORNER_ANGLE_DEG = 55
const MAX_CORNER_ANGLE_DEG = 125
/** A detected side length must fall within this multiple of the nominal side length. */
const MIN_SIDE_RATIO = 0.55
const MAX_SIDE_RATIO = 1.6

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** RGBA → greyscale, ITU-R BT.601 — matches roi.ts's toGrayscale weighting exactly (duplicated
 *  deliberately: domain code must not import from features/, the same layering the visual
 *  pipeline already accepts — see visual-worker.ts's own duplication note). */
export function toGrayscaleRgba(image: RgbaImage): GrayImage {
  const out = new Uint8ClampedArray(image.width * image.height)
  for (let i = 0; i < out.length; i += 1) {
    const r = image.data[i * 4] ?? 0
    const g = image.data[i * 4 + 1] ?? 0
    const b = image.data[i * 4 + 2] ?? 0
    out[i] = Math.round(luma(r, g, b))
  }
  return { data: out, width: image.width, height: image.height }
}

/** 3x3 Sobel gradient magnitude. Border pixels (no full 3x3 neighbourhood) are 0 — the edge
 *  search never samples within 1px of the image boundary anyway. */
function sobelMagnitude(gray: GrayImage): Float32Array {
  const { width, height, data } = gray
  const out = new Float32Array(width * height)
  const at = (x: number, y: number): number => data[y * width + x] ?? 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        -at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1) +
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1)
      const gy =
        -at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1) +
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1)
      out[y * width + x] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return out
}

interface LinePoint {
  along: number
  offset: number
}

/** A peak must beat the search band's own average score by this multiple before it counts as a
 *  real edge — otherwise a perfectly flat/uniform region (no edge anywhere) would silently
 *  "detect" whatever position happened to score first, instead of correctly finding nothing. */
const EDGE_PEAK_TO_AVERAGE_RATIO = 4
/** Absolute floor beneath the ratio check — guards the (rare) case where the average itself is
 *  already near zero, which would make almost any nonzero peak pass a pure ratio test. */
const EDGE_PEAK_ABSOLUTE_FLOOR = 25

/** Best offset (perpendicular position, in source pixels) for one sample line: the location of
 *  maximum smoothed gradient magnitude within [center-margin, center+margin]. `along` is fixed;
 *  the search runs over `offset`. `windowRadius` averages a few neighbouring `along` positions to
 *  damp single-pixel noise. Returns null when nothing in the band looks like a real edge (the
 *  peak never meaningfully beats the band's own average) — never a first-position-wins guess. */
function findEdgeOffset(
  magnitude: Float32Array,
  width: number,
  height: number,
  axis: 'row-is-along' | 'col-is-along',
  along: number,
  center: number,
  margin: number,
  windowRadius: number,
): number | null {
  const lo = Math.max(1, Math.round(center - margin))
  const hi = axis === 'row-is-along' ? height - 2 : width - 2
  const upperBound = Math.min(hi, Math.round(center + margin))
  let bestOffset: number | null = null
  let bestScore = -Infinity
  let scoreSum = 0
  let scoreCount = 0
  for (let offset = lo; offset <= upperBound; offset += 1) {
    let score = 0
    for (let d = -windowRadius; d <= windowRadius; d += 1) {
      const a = along + d
      // 'row-is-along' sides (top/bottom) scan candidate ROWS (offset = y) while jittering the
      // COLUMN (a = along + d) for the averaging window; 'col-is-along' sides (left/right) scan
      // candidate COLUMNS (offset = x) while jittering the ROW.
      const x = axis === 'row-is-along' ? a : offset
      const y = axis === 'row-is-along' ? offset : a
      if (x < 0 || x >= width || y < 0 || y >= height) continue
      score += magnitude[y * width + x] ?? 0
    }
    scoreSum += score
    scoreCount += 1
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }
  if (bestOffset === null || scoreCount === 0) return null
  const average = scoreSum / scoreCount
  const threshold = Math.max(EDGE_PEAK_ABSOLUTE_FLOOR, average * EDGE_PEAK_TO_AVERAGE_RATIO)
  return bestScore >= threshold ? bestOffset : null
}

/** Least-squares fit of offset = a*along + b, with one round of outlier rejection by median
 *  absolute residual. Returns null when fewer than 2 points remain. */
function fitLine(points: readonly LinePoint[]): { a: number; b: number } | null {
  function leastSquares(pts: readonly LinePoint[]): { a: number; b: number } | null {
    if (pts.length < 2) return null
    let sumX = 0
    let sumY = 0
    let sumXY = 0
    let sumXX = 0
    for (const p of pts) {
      sumX += p.along
      sumY += p.offset
      sumXY += p.along * p.offset
      sumXX += p.along * p.along
    }
    const n = pts.length
    const denominator = n * sumXX - sumX * sumX
    if (Math.abs(denominator) < 1e-9) return null
    const a = (n * sumXY - sumX * sumY) / denominator
    const b = (sumY - a * sumX) / n
    return { a, b }
  }
  const first = leastSquares(points)
  if (first === null) return null
  const residuals = points.map((p) => Math.abs(p.offset - (first.a * p.along + first.b)))
  const sorted = [...residuals].sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
  const threshold = Math.max(2, median * OUTLIER_RESIDUAL_MULTIPLE)
  const filtered = points.filter((_, i) => (residuals[i] ?? 0) <= threshold)
  if (filtered.length < 2 || filtered.length === points.length) return first
  return leastSquares(filtered) ?? first
}

/** Intersection of a horizontal-ish line (offset(y) = a*x + b, i.e. y = a*x + b) and a
 *  vertical-ish line (offset(x) = a*y + b, i.e. x = a*y + b). Returns null for near-parallel
 *  lines (never divide by ~0 into a wild point). */
function intersectHorizontalVertical(
  horizontal: { a: number; b: number },
  vertical: { a: number; b: number },
): Point | null {
  const denominator = 1 - vertical.a * horizontal.a
  if (Math.abs(denominator) < 1e-6) return null
  const x = (vertical.a * horizontal.b + vertical.b) / denominator
  const y = horizontal.a * x + horizontal.b
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function distance(p: Point, q: Point): number {
  return Math.hypot(p.x - q.x, p.y - q.y)
}

function angleBetweenDeg(a: Point, vertex: Point, b: Point): number {
  const v1x = a.x - vertex.x
  const v1y = a.y - vertex.y
  const v2x = b.x - vertex.x
  const v2y = b.y - vertex.y
  const dot = v1x * v2x + v1y * v2y
  const mag1 = Math.hypot(v1x, v1y)
  const mag2 = Math.hypot(v2x, v2y)
  if (mag1 < 1e-6 || mag2 < 1e-6) return 0
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)))
  return (Math.acos(cos) * 180) / Math.PI
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/** True when TL→TR→BR→BL→TL turns consistently one way (a simple convex quadrilateral, not a
 *  bowtie or a wildly concave shape from a bad line fit). */
function isConvexInOrder(q: Quadrilateral): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl]
  const crosses = pts.map((p, i) => cross(p, pts[(i + 1) % 4] ?? p, pts[(i + 2) % 4] ?? p))
  const positive = crosses.filter((c) => c > 0).length
  const negative = crosses.filter((c) => c < 0).length
  return positive === 0 || negative === 0
}

function validateQuadrilateral(q: Quadrilateral, nominal: RectPixelRect): boolean {
  if (![q.tl, q.tr, q.bl, q.br].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
    return false
  }
  if (!isConvexInOrder(q)) return false

  const angles = [
    angleBetweenDeg(q.bl, q.tl, q.tr),
    angleBetweenDeg(q.tl, q.tr, q.br),
    angleBetweenDeg(q.tr, q.br, q.bl),
    angleBetweenDeg(q.br, q.bl, q.tl),
  ]
  if (angles.some((deg) => deg < MIN_CORNER_ANGLE_DEG || deg > MAX_CORNER_ANGLE_DEG)) return false

  const topW = distance(q.tl, q.tr)
  const bottomW = distance(q.bl, q.br)
  const leftH = distance(q.tl, q.bl)
  const rightH = distance(q.tr, q.br)
  const widthOk = [topW, bottomW].every(
    (w) => w >= nominal.width * MIN_SIDE_RATIO && w <= nominal.width * MAX_SIDE_RATIO,
  )
  const heightOk = [leftH, rightH].every(
    (h) => h >= nominal.height * MIN_SIDE_RATIO && h <= nominal.height * MAX_SIDE_RATIO,
  )
  return widthOk && heightOk
}

/**
 * Searches a bounded margin around each side of `nominalRect` for the card's real edge and
 * returns the four corners of the best-fit quadrilateral, or null when nothing plausible was
 * found (the caller falls back to `nominalRect` itself). `nominalRect` and `margin` are in the
 * SAME pixel space as `gray`.
 */
export function detectCardQuadrilateral(
  gray: GrayImage,
  nominalRect: RectPixelRect,
  margin = DEFAULT_EDGE_SEARCH_MARGIN_PX,
): Quadrilateral | null {
  if (nominalRect.width < 20 || nominalRect.height < 20) return null
  const magnitude = sobelMagnitude(gray)
  const { width, height } = gray
  const inset = SIDE_SAMPLE_INSET_FRACTION

  function samplesAlong(start: number, span: number): number[] {
    const from = start + span * inset
    const to = start + span * (1 - inset)
    const points: number[] = []
    for (let i = 0; i < SAMPLES_PER_SIDE; i += 1) {
      const denominator: number = SAMPLES_PER_SIDE - 1
      const t = denominator === 0 ? 0.5 : i / denominator
      points.push(Math.round(from + (to - from) * t))
    }
    return points
  }

  const nominalRight = nominalRect.left + nominalRect.width
  const nominalBottom = nominalRect.top + nominalRect.height

  // Top/bottom: scan vertically (offset = y) at columns along the side's width.
  const topPoints: LinePoint[] = []
  const bottomPoints: LinePoint[] = []
  for (const x of samplesAlong(nominalRect.left, nominalRect.width)) {
    const topY = findEdgeOffset(
      magnitude,
      width,
      height,
      'row-is-along',
      x,
      nominalRect.top,
      margin,
      2,
    )
    if (topY !== null) topPoints.push({ along: x, offset: topY })
    const bottomY = findEdgeOffset(
      magnitude,
      width,
      height,
      'row-is-along',
      x,
      nominalBottom,
      margin,
      2,
    )
    if (bottomY !== null) bottomPoints.push({ along: x, offset: bottomY })
  }

  // Left/right: scan horizontally (offset = x) at rows along the side's height.
  const leftPoints: LinePoint[] = []
  const rightPoints: LinePoint[] = []
  for (const y of samplesAlong(nominalRect.top, nominalRect.height)) {
    const leftX = findEdgeOffset(
      magnitude,
      width,
      height,
      'col-is-along',
      y,
      nominalRect.left,
      margin,
      2,
    )
    if (leftX !== null) leftPoints.push({ along: y, offset: leftX })
    const rightX = findEdgeOffset(
      magnitude,
      width,
      height,
      'col-is-along',
      y,
      nominalRight,
      margin,
      2,
    )
    if (rightX !== null) rightPoints.push({ along: y, offset: rightX })
  }

  const topLine = fitLine(topPoints)
  const bottomLine = fitLine(bottomPoints)
  const leftLine = fitLine(leftPoints)
  const rightLine = fitLine(rightPoints)
  if (!topLine || !bottomLine || !leftLine || !rightLine) return null

  const tl = intersectHorizontalVertical(topLine, leftLine)
  const tr = intersectHorizontalVertical(topLine, rightLine)
  const bl = intersectHorizontalVertical(bottomLine, leftLine)
  const br = intersectHorizontalVertical(bottomLine, rightLine)
  if (!tl || !tr || !bl || !br) return null

  const quad: Quadrilateral = { tl, tr, bl, br }
  return validateQuadrilateral(quad, nominalRect) ? quad : null
}

function nominalRectToQuadrilateral(rect: RectPixelRect): Quadrilateral {
  return {
    tl: { x: rect.left, y: rect.top },
    tr: { x: rect.left + rect.width, y: rect.top },
    bl: { x: rect.left, y: rect.top + rect.height },
    br: { x: rect.left + rect.width, y: rect.top + rect.height },
  }
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function bilinearSampleRgba(
  image: RgbaImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const { width, height, data } = image
  const cx = Math.max(0, Math.min(width - 1.001, x))
  const cy = Math.max(0, Math.min(height - 1.001, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = cx - x0
  const fy = cy - y0
  const idx = (xx: number, yy: number) => (yy * width + xx) * 4
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = 0; c < 4; c += 1) {
    const v00 = data[idx(x0, y0) + c] ?? 0
    const v10 = data[idx(x1, y0) + c] ?? 0
    const v01 = data[idx(x0, y1) + c] ?? 0
    const v11 = data[idx(x1, y1) + c] ?? 0
    const top = v00 + (v10 - v00) * fx
    const bottom = v01 + (v11 - v01) * fx
    out[c] = top + (bottom - top) * fy
  }
  return out
}

/**
 * Resamples the quadrilateral `corners` of `image` onto an `outWidth` x `outHeight` canonical
 * rectangle via BILINEAR QUADRILATERAL INTERPOLATION: each output pixel's source location is the
 * bilinear blend of the four corners at that pixel's normalized (u, v) position, then
 * bilinear-sampled from the source image.
 *
 * This is a deliberate simplification, not a full projective (homography) warp — documented
 * honestly rather than silently understated. A true 4-point DLT homography is more accurate for
 * SEVERE perspective (extreme viewing angles, e.g. scanning a card flat on a table from near eye
 * level) and was the rejected alternative: it requires solving an 8x8 linear system for every
 * capture and is meaningfully harder to get right (and to verify correct) than direct bilinear
 * interpolation, which needs no matrix solve — the destination grid's normalized (u, v) already
 * IS the interpolation parameter. For the moderate hand-held tilt this project's own capture UX
 * produces (a guide overlay the user visually aligns to, not a document scanner photographing a
 * page from an arbitrary angle), the two approaches coincide closely; if a future benchmark ever
 * shows genuine severe-perspective misses that pass detection but still recognize poorly, the DLT
 * upgrade is a self-contained follow-up (same detected-quadrilateral input, different resampling
 * function) — nothing about this module's public shape would need to change.
 */
export function warpPerspective(
  image: RgbaImage,
  corners: Quadrilateral,
  outWidth: number,
  outHeight: number,
): RgbaImage {
  const data = new Uint8ClampedArray(Math.max(1, outWidth) * Math.max(1, outHeight) * 4)
  for (let oy = 0; oy < outHeight; oy += 1) {
    const v = outHeight === 1 ? 0 : oy / (outHeight - 1)
    const left = lerpPoint(corners.tl, corners.bl, v)
    const right = lerpPoint(corners.tr, corners.br, v)
    for (let ox = 0; ox < outWidth; ox += 1) {
      const u = outWidth === 1 ? 0 : ox / (outWidth - 1)
      const src = lerpPoint(left, right, u)
      const [r, g, b, a] = bilinearSampleRgba(image, src.x, src.y)
      const outIdx = (oy * outWidth + ox) * 4
      data[outIdx] = r
      data[outIdx + 1] = g
      data[outIdx + 2] = b
      data[outIdx + 3] = a
    }
  }
  return { data, width: outWidth, height: outHeight }
}

export interface RectifyCardResult {
  readonly image: RgbaImage
  readonly corners: Quadrilateral
  /** True when detection failed validation and the plain nominal rectangle was warped instead
   *  (pixel-equivalent to a crop+resize — never a crash, never a guess). */
  readonly usedFallback: boolean
}

/**
 * Detects the card's real boundary within `nominalRect` (±`margin`) inside `rgba` and warps it to
 * an `outWidth` x `outHeight` canonical image. Falls back to warping the plain `nominalRect`
 * (mathematically a crop+resize) when detection finds nothing plausible — always returns a
 * usable image, never throws for a bad detection.
 */
export function rectifyCard(
  rgba: RgbaImage,
  nominalRect: RectPixelRect,
  outWidth: number,
  outHeight: number,
  margin = DEFAULT_EDGE_SEARCH_MARGIN_PX,
): RectifyCardResult {
  const gray = toGrayscaleRgba(rgba)
  const detected = detectCardQuadrilateral(gray, nominalRect, margin)
  const corners = detected ?? nominalRectToQuadrilateral(nominalRect)
  const image = warpPerspective(rgba, corners, outWidth, outHeight)
  return { image, corners, usedFallback: detected === null }
}
