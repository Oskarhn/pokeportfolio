// Capture-quality heuristics computed from pixel data ALONE (§15) — no reference image, no
// embedding, nothing the real scanner wouldn't have at the moment of capture. Every metric here is
// a plain, auditable formula (no learned weights) so the eventual quality gate stays a transparent
// rule tree, not a black box.
import sharp from 'sharp'

async function toGrayRaw(buffer, maxDim = 256) {
  const { data, info } = await sharp(buffer)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Laplacian variance — the standard, cheap blur proxy. Higher = sharper. */
function laplacianVariance(gray, width, height) {
  const lap = new Float64Array(width * height)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      const value = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width]
      lap[i] = value
    }
  }
  let mean = 0
  const n = lap.length
  for (let i = 0; i < n; i += 1) mean += lap[i]
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i += 1) variance += (lap[i] - mean) ** 2
  variance /= n
  return variance
}

/** Tenengrad: mean squared Sobel gradient magnitude — a second, independent sharpness proxy. */
function tenengrad(gray, width, height) {
  let sum = 0
  let count = 0
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
      sum += gx * gx + gy * gy
      count += 1
    }
  }
  return sum / count
}

/** Glare metric: fraction of pixels that are both very bright (>=250/255) and low-saturation
 *  (near-white, not just a bright saturated color) — a cheap specular-highlight proxy. */
async function glareFraction(buffer, maxDim = 256) {
  const { data, info } = await sharp(buffer)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const pixelCount = info.width * info.height
  let glarePixels = 0
  let clippedChannelPixels = 0
  for (let p = 0; p < pixelCount; p += 1) {
    const r = data[p * channels]
    const g = data[p * channels + 1]
    const b = data[p * channels + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    if (max >= 250 && sat <= 0.12) glarePixels += 1
    if (r >= 254 || g >= 254 || b >= 254) clippedChannelPixels += 1
  }
  return {
    glareFraction: glarePixels / pixelCount,
    clippedFraction: clippedChannelPixels / pixelCount,
  }
}

/** Shadow-variation metric: coefficient of variation of a heavily downsampled luminance field —
 *  a cheap proxy for uneven illumination across the frame (a flat-lit card has low CV; a card with
 *  a hard shadow crossing it has high CV). */
async function shadowVariation(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(16, 16, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  let mean = 0
  for (let i = 0; i < n; i += 1) mean += data[i]
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i += 1) variance += (data[i] - mean) ** 2
  variance /= n
  const stddev = Math.sqrt(variance)
  return mean > 0 ? stddev / mean : 0
}

/** Overall brightness/contrast (global mean + stddev of luminance, full-res-independent). */
async function brightnessContrast(gray, width, height) {
  const n = width * height
  let mean = 0
  for (let i = 0; i < n; i += 1) mean += gray[i]
  mean /= n
  let variance = 0
  for (let i = 0; i < n; i += 1) variance += (gray[i] - mean) ** 2
  variance /= n
  return { brightnessMean: mean, contrastStd: Math.sqrt(variance) }
}

/**
 * Computes the full capture-quality feature vector for one image buffer. This is the ONLY input
 * the §15 quality gate is allowed to use — no card identity, no embedding, no retrieval result.
 */
export async function computeQualityMetrics(buffer) {
  const { data: gray, width, height } = await toGrayRaw(buffer)
  const lapVar = laplacianVariance(gray, width, height)
  const tng = tenengrad(gray, width, height)
  const { glareFraction: glare, clippedFraction } = await glareFraction(buffer)
  const shadowCv = await shadowVariation(buffer)
  const { brightnessMean, contrastStd } = await brightnessContrast(gray, width, height)
  return {
    laplacianVariance: lapVar,
    tenengrad: tng,
    glareFraction: glare,
    clippedFraction,
    shadowCv,
    brightnessMean,
    contrastStd,
  }
}
