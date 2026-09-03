// Small shared vector-math helpers used by the reference-augmentation / robust-centroid
// experiments (§8-10). Every aggregation returns an L2-normalized Float32Array so cosine
// similarity stays a plain dot product throughout the lab.

export function l2normalize(vector) {
  let norm = 0
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  const out = new Float32Array(vector.length)
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm
  else out.set(vector)
  return out
}

export function dot(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

export function mean(vectors) {
  const dim = vectors[0].length
  const out = new Float32Array(dim)
  for (const v of vectors) for (let i = 0; i < dim; i += 1) out[i] += v[i]
  for (let i = 0; i < dim; i += 1) out[i] /= vectors.length
  return l2normalize(out)
}

/** Trimmed mean: drops the `trimEach` most extreme vectors on each side by distance-to-mean before
 *  averaging the rest — a crude but real robust estimator (no library added). */
export function trimmedMean(vectors, trimEach = 1) {
  if (vectors.length <= trimEach * 2) return mean(vectors)
  const centroid = mean(vectors)
  const withDist = vectors.map((v) => ({ v, d: 1 - dot(l2normalize(v), centroid) }))
  withDist.sort((a, b) => a.d - b.d)
  const kept = withDist.slice(0, withDist.length - trimEach).map((x) => x.v)
  return mean(kept)
}

/** Medoid: the input vector with the highest total similarity to every other input vector
 *  (the "most representative real sample", not a synthetic average). */
export function medoid(vectors) {
  const normed = vectors.map(l2normalize)
  let bestIndex = 0
  let bestScore = -Infinity
  for (let i = 0; i < normed.length; i += 1) {
    let score = 0
    for (let j = 0; j < normed.length; j += 1) {
      if (i === j) continue
      score += dot(normed[i], normed[j])
    }
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }
  return normed[bestIndex]
}

/** Multi-prototype search: for each candidate card with N prototype vectors, similarity is the
 *  MAX over its own prototypes (§8 strategy I). `prototypesByCard` is Map<cardId, Float32Array[]>. */
export function searchMultiProto(
  queryVec,
  prototypesByCard,
  { excludeCardId = null, aggregate = 'max' } = {},
) {
  const hits = []
  for (const [cardId, protos] of prototypesByCard) {
    if (cardId === excludeCardId) continue
    const sims = protos.map((p) => dot(p, queryVec))
    let score
    if (aggregate === 'max') score = Math.max(...sims)
    else if (aggregate === 'avgTop2' && sims.length >= 2) {
      sims.sort((a, b) => b - a)
      score = (sims[0] + sims[1]) / 2
    } else {
      score = sims.reduce((a, b) => a + b, 0) / sims.length
    }
    hits.push({ cardId, similarity: score })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits
}
