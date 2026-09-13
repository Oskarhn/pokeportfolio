// Photometric normalization candidates (§11) evaluated as QUERY-side pre-embedding transforms.
// Every variant takes a JPEG/WEBP buffer and returns a JPEG buffer of the same content — cheap,
// deterministic, sharp-only (no new dependency). Not all of §11's brainstormed list is implemented
// as a fully distinct transform (shades-of-gray/Lab-L/HSV-V normalization are close numerical
// cousins of the gray-world and percentile-clip variants below); this is the honestly-scoped
// working subset, not the full wishlist.
import sharp from 'sharp'

export const NORMALIZATION_VARIANTS = [
  'none',
  'clahe',
  'grayWorld',
  'percentileClip',
  'gammaAdaptive',
  'retinexSingleScale',
  'unsharpMask',
  'grayscaleTriplicate',
]

async function readRaw(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

async function fromRaw(data, width, height, channels) {
  return sharp(data, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer()
}

async function grayWorld(buffer) {
  const { data, width, height, channels } = await readRaw(buffer)
  const n = width * height
  let sumR = 0,
    sumG = 0,
    sumB = 0
  for (let p = 0; p < n; p += 1) {
    sumR += data[p * channels]
    sumG += data[p * channels + 1]
    sumB += data[p * channels + 2]
  }
  const meanR = sumR / n,
    meanG = sumG / n,
    meanB = sumB / n
  const gray = (meanR + meanG + meanB) / 3
  const scaleR = meanR > 0 ? gray / meanR : 1
  const scaleG = meanG > 0 ? gray / meanG : 1
  const scaleB = meanB > 0 ? gray / meanB : 1
  const out = Buffer.from(data)
  for (let p = 0; p < n; p += 1) {
    out[p * channels] = Math.min(255, Math.round(data[p * channels] * scaleR))
    out[p * channels + 1] = Math.min(255, Math.round(data[p * channels + 1] * scaleG))
    out[p * channels + 2] = Math.min(255, Math.round(data[p * channels + 2] * scaleB))
  }
  return fromRaw(out, width, height, channels)
}

async function percentileClip(buffer, lowPct = 0.02, highPct = 0.98) {
  const { data, width, height, channels } = await readRaw(buffer)
  const n = width * height
  const out = Buffer.from(data)
  for (let c = 0; c < 3; c += 1) {
    const hist = new Uint32Array(256)
    for (let p = 0; p < n; p += 1) hist[data[p * channels + c]] += 1
    let cum = 0
    let lo = 0,
      hi = 255
    const loTarget = lowPct * n
    const hiTarget = highPct * n
    for (let v = 0; v < 256; v += 1) {
      cum += hist[v]
      if (cum >= loTarget) {
        lo = v
        break
      }
    }
    cum = 0
    for (let v = 0; v < 256; v += 1) {
      cum += hist[v]
      if (cum >= hiTarget) {
        hi = v
        break
      }
    }
    const range = Math.max(1, hi - lo)
    for (let p = 0; p < n; p += 1) {
      const v = data[p * channels + c]
      out[p * channels + c] = Math.max(0, Math.min(255, Math.round(((v - lo) / range) * 255)))
    }
  }
  return fromRaw(out, width, height, channels)
}

async function gammaAdaptive(buffer) {
  const stats = await sharp(buffer).stats()
  const meanLuma =
    (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3 / 255
  if (meanLuma <= 0.001 || meanLuma >= 0.999) return sharp(buffer).jpeg({ quality: 90 }).toBuffer()
  // Solve gamma so that mean^(1/gamma) == 0.5 (target mid-gray), clamped to sharp's valid range.
  const gamma = Math.min(3.0, Math.max(1.0, Math.log(0.5) / Math.log(meanLuma)))
  return sharp(buffer).gamma(gamma).jpeg({ quality: 90 }).toBuffer()
}

async function retinexSingleScale(buffer) {
  const meta = await sharp(buffer).metadata()
  const width = meta.width ?? 400
  const height = meta.height ?? 560
  const sigma = Math.max(4, Math.round(Math.min(width, height) * 0.08))
  const { data: orig, channels } = await readRaw(buffer)
  const blurred = await sharp(buffer).ensureAlpha().blur(sigma).raw().toBuffer()
  const n = width * height
  const out = Buffer.from(orig)
  for (let p = 0; p < n; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const i = p * channels + c
      const lOrig = Math.log(1 + orig[i])
      const lBlur = Math.log(1 + blurred[i])
      // Single-scale retinex: log(I) - log(blur(I)), rescaled from its natural [-ln255, ln255]
      // range back into 0-255 with a fixed linear map (deterministic, no per-image auto-stretch
      // beyond percentileClip's own separate variant).
      const r = lOrig - lBlur
      out[i] = Math.max(0, Math.min(255, Math.round(128 + r * 60)))
    }
  }
  return fromRaw(out, width, height, channels)
}

/** Applies one named normalization variant to a query image buffer before embedding. */
export async function applyNormalization(name, buffer) {
  switch (name) {
    case 'none':
      return sharp(buffer).jpeg({ quality: 90 }).toBuffer()
    case 'clahe':
      return sharp(buffer)
        .clahe({ width: 32, height: 32, maxSlope: 3 })
        .jpeg({ quality: 90 })
        .toBuffer()
    case 'grayWorld':
      return grayWorld(buffer)
    case 'percentileClip':
      return percentileClip(buffer)
    case 'gammaAdaptive':
      return gammaAdaptive(buffer)
    case 'retinexSingleScale':
      return retinexSingleScale(buffer)
    case 'unsharpMask':
      return sharp(buffer)
        .sharpen({ sigma: 1.5, m1: 1.5, m2: 2.5 })
        .jpeg({ quality: 90 })
        .toBuffer()
    case 'grayscaleTriplicate':
      return sharp(buffer).grayscale().jpeg({ quality: 90 }).toBuffer()
    default:
      throw new Error(`Unknown normalization variant: ${name}`)
  }
}
