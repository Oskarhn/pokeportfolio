// P95 §3: extends P91's quality/metrics.mjs (untouched, still used standalone by experiment 05)
// with a few more pixel-only capture-quality proxies for the continuous-severity correlation
// study. Every metric is still pixel-only, no card identity, no embedding, no retrieval result —
// same discipline as metrics.mjs.
import sharp from 'sharp'
import { computeQualityMetrics } from './metrics.mjs'

async function toGrayRaw(buffer, maxDim = 256) {
  const { data, info } = await sharp(buffer)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Edge density: fraction of pixels whose Sobel gradient magnitude exceeds a fixed threshold —
 *  a cheap, thresholded proxy for "how much real card-edge/text structure survived," independent
 *  of Tenengrad's raw mean-squared-gradient scale. */
function edgeDensity(gray, width, height, threshold = 40) {
  let edgePixels = 0
  let total = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const gx =
        -gray[i - width - 1] -
        2 * gray[i - 1] -
        gray[i + width - 1] +
        gray[i - width + 1] +
        2 * gray[i + 1] +
        gray[i + width + 1]
      const gy =
        -gray[i - width - 1] -
        2 * gray[i - width] -
        gray[i - width + 1] +
        gray[i + width - 1] +
        2 * gray[i + width] +
        gray[i + width + 1]
      const mag = Math.sqrt(gx * gx + gy * gy)
      if (mag > threshold) edgePixels += 1
      total += 1
    }
  }
  return edgePixels / total
}

/** Dark-clipping fraction: pixels pinned at/near 0 in any channel (shadow crush), independent of
 *  metrics.ts's bright/glare clipping fraction. */
async function darkClippedFraction(buffer, maxDim = 256) {
  const { data, info } = await sharp(buffer)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const pixelCount = info.width * info.height
  let dark = 0
  for (let p = 0; p < pixelCount; p += 1) {
    const r = data[p * channels]
    const g = data[p * channels + 1]
    const b = data[p * channels + 2]
    if (r <= 2 || g <= 2 || b <= 2) dark += 1
  }
  return dark / pixelCount
}

/** Local luminance variation: mean of per-block standard deviation over a coarse 8x8 grid of
 *  blocks — distinct from metrics.ts's shadowCv (a single global CV over a 16x16 downsample):
 *  this captures uneven micro-contrast (patchy glare/shadow/noise) rather than one smooth gradient
 *  across the whole frame. */
async function localLuminanceVariation(buffer, grid = 8) {
  const size = grid * 32
  const { data, info } = await sharp(buffer)
    .resize(size, size, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const blockW = Math.floor(w / grid)
  const blockH = Math.floor(h / grid)
  const blockStds = []
  for (let by = 0; by < grid; by += 1) {
    for (let bx = 0; bx < grid; bx += 1) {
      let sum = 0
      let n = 0
      for (let y = by * blockH; y < (by + 1) * blockH; y += 1) {
        for (let x = bx * blockW; x < (bx + 1) * blockW; x += 1) {
          sum += data[y * w + x]
          n += 1
        }
      }
      const mean = sum / n
      let variance = 0
      for (let y = by * blockH; y < (by + 1) * blockH; y += 1) {
        for (let x = bx * blockW; x < (bx + 1) * blockW; x += 1) {
          variance += (data[y * w + x] - mean) ** 2
        }
      }
      blockStds.push(Math.sqrt(variance / n))
    }
  }
  const meanBlockStd = blockStds.reduce((a, b) => a + b, 0) / blockStds.length
  let varOfBlockStds = 0
  for (const s of blockStds) varOfBlockStds += (s - meanBlockStd) ** 2
  varOfBlockStds /= blockStds.length
  return { meanBlockStd, blockStdSpread: Math.sqrt(varOfBlockStds) }
}

/**
 * Full P95 feature vector: everything P91's computeQualityMetrics already returns, plus
 * edgeDensity, darkClippedFraction, meanBlockStd/blockStdSpread. Superset, backward-compatible.
 */
export async function computeQualityMetricsV2(buffer) {
  const base = await computeQualityMetrics(buffer)
  const { data: gray, width, height } = await toGrayRaw(buffer)
  const edge = edgeDensity(gray, width, height)
  const dark = await darkClippedFraction(buffer)
  const local = await localLuminanceVariation(buffer)
  return {
    ...base,
    edgeDensity: edge,
    darkClippedFraction: dark,
    meanBlockStd: local.meanBlockStd,
    blockStdSpread: local.blockStdSpread,
  }
}

export const METRIC_DIRECTIONS_V2 = {
  laplacianVariance: 'low-is-bad',
  tenengrad: 'low-is-bad',
  edgeDensity: 'low-is-bad',
  glareFraction: 'high-is-bad',
  clippedFraction: 'high-is-bad',
  darkClippedFraction: 'high-is-bad',
  shadowCv: 'high-is-bad',
  contrastStd: 'low-is-bad',
  meanBlockStd: 'low-is-bad',
  blockStdSpread: 'high-is-bad',
}
