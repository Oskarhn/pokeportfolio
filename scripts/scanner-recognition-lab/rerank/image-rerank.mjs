// Image-to-image rerank signals (§26) computable with sharp alone — no OpenCV/ORB dependency
// added (§25's local-feature-matching idea is reasoned-deferred; see the P91 report for why: no
// keypoint-descriptor library exists in this project's dependency tree, and P84 already argued —
// without benchmarking — that classical keypoint descriptors are typically LESS blur/glare-robust
// than a global CNN embedding, which is the exact failure regime this project cares about. NCC/
// histogram rerank below is the practical, dependency-free substitute this session COULD measure).
import sharp from 'sharp'

const RERANK_SIZE = 48

async function toGraySmall(buffer) {
  const { data } = await sharp(buffer)
    .resize(RERANK_SIZE, RERANK_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data
}

async function toColorHist(buffer, bins = 16) {
  const { data, info } = await sharp(buffer)
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const hist = new Float64Array(bins * 3)
  const n = 32 * 32
  const binSize = 256 / bins
  for (let p = 0; p < n; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const bin = Math.min(bins - 1, Math.floor(data[p * channels + c] / binSize))
      hist[c * bins + bin] += 1
    }
  }
  for (let i = 0; i < hist.length; i += 1) hist[i] /= n
  return hist
}

/** Normalized cross-correlation between two equal-length grayscale buffers, [-1, 1]. */
function ncc(a, b) {
  const n = a.length
  let meanA = 0,
    meanB = 0
  for (let i = 0; i < n; i += 1) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n
  let num = 0,
    denA = 0,
    denB = 0
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den > 0 ? num / den : 0
}

/** A simplified single-window SSIM (not the full multi-window SSIM standard, but the same core
 *  luminance/contrast/structure formula over the whole downsized image at once). */
function ssimLite(a, b) {
  const n = a.length
  let meanA = 0,
    meanB = 0
  for (let i = 0; i < n; i += 1) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n
  let varA = 0,
    varB = 0,
    cov = 0
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    varA += da * da
    varB += db * db
    cov += da * db
  }
  varA /= n
  varB /= n
  cov /= n
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  return (
    ((2 * meanA * meanB + C1) * (2 * cov + C2)) /
    ((meanA ** 2 + meanB ** 2 + C1) * (varA + varB + C2))
  )
}

function histIntersection(h1, h2) {
  let s = 0
  for (let i = 0; i < h1.length; i += 1) s += Math.min(h1[i], h2[i])
  return s
}

/** Computes all three rerank signals between a query buffer and one candidate reference buffer. */
export async function rerankSignals(queryBuffer, referenceBuffer) {
  const [qGray, rGray, qHist, rHist] = await Promise.all([
    toGraySmall(queryBuffer),
    toGraySmall(referenceBuffer),
    toColorHist(queryBuffer),
    toColorHist(referenceBuffer),
  ])
  return {
    ncc: ncc(qGray, rGray),
    ssim: ssimLite(qGray, rGray),
    histIntersection: histIntersection(qHist, rHist),
  }
}

// P95 §5/§8: precompute-once variants so a large reference corpus's rerank features (gray patch +
// color histogram) are computed ONCE, not once per query x candidate pair — makes a K=100+
// two-stage experiment tractable over thousands of queries.
export async function computeRerankFeatures(buffer) {
  const [gray, hist] = await Promise.all([toGraySmall(buffer), toColorHist(buffer)])
  return { gray, hist }
}

export function compareRerankFeatures(queryFeatures, candidateFeatures) {
  return {
    ncc: ncc(queryFeatures.gray, candidateFeatures.gray),
    ssim: ssimLite(queryFeatures.gray, candidateFeatures.gray),
    histIntersection: histIntersection(queryFeatures.hist, candidateFeatures.hist),
  }
}

// P95 §8: a few additional dependency-free exact-image-identity signals beyond P91's three —
// edge-domain NCC/SSIM (Sobel magnitude maps instead of raw gray) and color moments (mean+stddev
// per channel, cheaper than a full histogram and complementary to it).
function sobelMagnitude(gray, size) {
  const out = new Float64Array(size * size)
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x
      const gx =
        -gray[i - size - 1] -
        2 * gray[i - 1] -
        gray[i + size - 1] +
        gray[i - size + 1] +
        2 * gray[i + 1] +
        gray[i + size + 1]
      const gy =
        -gray[i - size - 1] -
        2 * gray[i - size] -
        gray[i - size + 1] +
        gray[i + size - 1] +
        2 * gray[i + size] +
        gray[i + size + 1]
      out[i] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return out
}

async function toColorMoments(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const n = 32 * 32
  const moments = []
  for (let c = 0; c < 3; c += 1) {
    let mean = 0
    for (let p = 0; p < n; p += 1) mean += data[p * channels + c]
    mean /= n
    let variance = 0
    for (let p = 0; p < n; p += 1) variance += (data[p * channels + c] - mean) ** 2
    variance /= n
    moments.push(mean / 255, Math.sqrt(variance) / 255)
  }
  return moments // [meanR, stdR, meanG, stdG, meanB, stdB], each 0-1
}

function colorMomentsSimilarity(a, b) {
  let dist = 0
  for (let i = 0; i < a.length; i += 1) dist += (a[i] - b[i]) ** 2
  return 1 - Math.sqrt(dist / a.length) // 1 = identical, lower = more different
}

export async function computeExtendedRerankFeatures(buffer) {
  const base = await computeRerankFeatures(buffer)
  const edges = sobelMagnitude(base.gray, RERANK_SIZE)
  const moments = await toColorMoments(buffer)
  return { ...base, edges, moments }
}

export function compareExtendedRerankFeatures(queryFeatures, candidateFeatures) {
  const base = compareRerankFeatures(queryFeatures, candidateFeatures)
  return {
    ...base,
    edgeNcc: ncc(queryFeatures.edges, candidateFeatures.edges),
    edgeSsim: ssimLite(queryFeatures.edges, candidateFeatures.edges),
    colorMoments: colorMomentsSimilarity(queryFeatures.moments, candidateFeatures.moments),
  }
}
