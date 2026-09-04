// P95 §7: a genuinely MEASURED lightweight local-feature rerank signal, closing the question P84/
// P91 both reasoned away without benchmarking (P91's own disclosed reasoning: "no keypoint-
// descriptor library exists in this project's dependency tree ... classical keypoint descriptors
// are, if anything, LESS robust to blur/glare than a global CNN embedding — the opposite of what
// this failure mode needs"). No OpenCV/ORB/AKAZE dependency added — this is a from-scratch, pure-JS
// ORB-INSPIRED substitute: Harris corner detection (structure-tensor response over Sobel
// gradients, with non-max suppression) + small-patch normalized-cross-correlation matching with a
// Lowe's-ratio-style best/second-best test. Small (~150 lines), no native binary, nothing committed
// to production dependencies — safe to keep as research tooling regardless of the result.
import sharp from 'sharp'

const DETECT_SIZE = 96
const PATCH_RADIUS = 5 // 11x11 patches
const MAX_CORNERS = 30
const NMS_RADIUS = 5
const HARRIS_K = 0.04

async function toGrayFloat(buffer, size = DETECT_SIZE) {
  const { data } = await sharp(buffer)
    .resize(size, size, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const out = new Float32Array(size * size)
  for (let i = 0; i < data.length; i += 1) out[i] = data[i]
  return out
}

function sobel(gray, size) {
  const gx = new Float32Array(size * size)
  const gy = new Float32Array(size * size)
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x
      gx[i] =
        -gray[i - size - 1] -
        2 * gray[i - 1] -
        gray[i + size - 1] +
        gray[i - size + 1] +
        2 * gray[i + 1] +
        gray[i + size + 1]
      gy[i] =
        -gray[i - size - 1] -
        2 * gray[i - size] -
        gray[i - size + 1] +
        gray[i + size - 1] +
        2 * gray[i + size] +
        gray[i + size + 1]
    }
  }
  return { gx, gy }
}

/** Harris corner response over a 3x3 box-summed structure tensor. Returns a Float32Array of the
 *  same size as the input, response value at each pixel (0 at borders). */
function harrisResponse(gray, size) {
  const { gx, gy } = sobel(gray, size)
  const ixx = new Float32Array(size * size)
  const iyy = new Float32Array(size * size)
  const ixy = new Float32Array(size * size)
  for (let i = 0; i < gx.length; i += 1) {
    ixx[i] = gx[i] * gx[i]
    iyy[i] = gy[i] * gy[i]
    ixy[i] = gx[i] * gy[i]
  }
  const response = new Float32Array(size * size)
  for (let y = 2; y < size - 2; y += 1) {
    for (let x = 2; x < size - 2; x += 1) {
      let sxx = 0,
        syy = 0,
        sxy = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = (y + dy) * size + (x + dx)
          sxx += ixx[j]
          syy += iyy[j]
          sxy += ixy[j]
        }
      }
      const det = sxx * syy - sxy * sxy
      const trace = sxx + syy
      response[y * size + x] = det - HARRIS_K * trace * trace
    }
  }
  return response
}

function nonMaxSuppressCorners(response, size, maxCorners, nmsRadius) {
  const candidates = []
  for (let y = PATCH_RADIUS + 1; y < size - PATCH_RADIUS - 1; y += 1) {
    for (let x = PATCH_RADIUS + 1; x < size - PATCH_RADIUS - 1; x += 1) {
      const v = response[y * size + x]
      if (v > 0) candidates.push({ x, y, v })
    }
  }
  candidates.sort((a, b) => b.v - a.v)
  const kept = []
  for (const c of candidates) {
    if (kept.length >= maxCorners) break
    let tooClose = false
    for (const k of kept) {
      if (Math.abs(k.x - c.x) < nmsRadius && Math.abs(k.y - c.y) < nmsRadius) {
        tooClose = true
        break
      }
    }
    if (!tooClose) kept.push(c)
  }
  return kept
}

function extractPatch(gray, size, cx, cy, radius = PATCH_RADIUS) {
  const side = radius * 2 + 1
  const patch = new Float32Array(side * side)
  let idx = 0
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      patch[idx] = gray[(cy + dy) * size + (cx + dx)]
      idx += 1
    }
  }
  return patch
}

/** Detects up to MAX_CORNERS keypoints and their patches for one image buffer. */
export async function detectKeypoints(buffer) {
  const gray = await toGrayFloat(buffer)
  const response = harrisResponse(gray, DETECT_SIZE)
  const corners = nonMaxSuppressCorners(response, DETECT_SIZE, MAX_CORNERS, NMS_RADIUS)
  return corners.map((c) => ({ x: c.x, y: c.y, patch: extractPatch(gray, DETECT_SIZE, c.x, c.y) }))
}

function patchNcc(a, b) {
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

/**
 * Matches query keypoints against candidate keypoints via patch NCC with a Lowe's-ratio-style
 * best/second-best test (ratio < RATIO_MAX = "good match", same spirit as SIFT matching, applied
 * to NCC scores instead of L2 descriptor distance). Returns { goodMatchCount, meanGoodMatchNcc } —
 * the rerank score this experiment tests is goodMatchCount (ties broken by meanGoodMatchNcc).
 */
export function matchKeypoints(
  queryKeypoints,
  candidateKeypoints,
  { minNcc = 0.55, ratioMax = 0.92 } = {},
) {
  if (queryKeypoints.length === 0 || candidateKeypoints.length === 0) {
    return { goodMatchCount: 0, meanGoodMatchNcc: 0 }
  }
  let goodMatchCount = 0
  let sumNcc = 0
  for (const qkp of queryKeypoints) {
    let best = -Infinity
    let second = -Infinity
    for (const ckp of candidateKeypoints) {
      const score = patchNcc(qkp.patch, ckp.patch)
      if (score > best) {
        second = best
        best = score
      } else if (score > second) {
        second = score
      }
    }
    const ratio = second > -Infinity ? (1 - best) / Math.max(1 - second, 1e-6) : 0
    if (best >= minNcc && ratio < ratioMax) {
      goodMatchCount += 1
      sumNcc += best
    }
  }
  return {
    goodMatchCount,
    meanGoodMatchNcc: goodMatchCount > 0 ? sumNcc / goodMatchCount : 0,
  }
}
