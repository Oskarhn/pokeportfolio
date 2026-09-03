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
