// DINOv2-small embedding, pinned to the SAME model id/revision/dtype as the shipped production
// pipeline (docs/DECISIONS.md D-097) so every P91 result is comparable to the real system, not a
// different model in disguise. Unlike the P76 benchmark's embed.mjs (which only ever returns the
// CLS-token slice), this module exposes the FULL last_hidden_state so §7's pooling sweep can be
// run without re-embedding images per pooling variant.
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const VISUAL_MODEL_ID = 'Xenova/dinov2-small'
export const VISUAL_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'
export const VISUAL_EMBEDDING_DIM = 384
export const NUM_PATCH_TOKENS = 256 // 16x16 patches at 224px input, 14px patch size

env.allowRemoteModels = true
env.cacheDir = join(here, '..', '.cache', 'hf-cache')

let modelPromise = null
let processorPromise = null

function loadModel() {
  if (!modelPromise) modelPromise = AutoModel.from_pretrained(VISUAL_MODEL_ID, { dtype: 'q8' })
  return modelPromise
}
function loadProcessor() {
  if (!processorPromise) processorPromise = AutoProcessor.from_pretrained(VISUAL_MODEL_ID)
  return processorPromise
}

export async function warmUpModel() {
  await loadModel()
  await loadProcessor()
}

function l2normalize(vector) {
  let norm = 0
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  const out = new Float32Array(vector.length)
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm
  else out.set(vector)
  return out
}

/**
 * Runs the model on one image buffer and returns the RAW (un-normalized) last_hidden_state as a
 * { cls: Float32Array(384), patches: Float32Array(256*384) } pair — patches is row-major
 * [patchIndex * 384 + dim]. Callers normalize whatever pooled vector they derive from this.
 */
export async function embedImageRaw(buffer) {
  const model = await loadModel()
  const processor = await loadProcessor()
  const image = await RawImage.fromBlob(new Blob([buffer]))
  const inputs = await processor(image)
  const { last_hidden_state } = await model(inputs)
  const data = Float32Array.from(last_hidden_state.data)
  const cls = data.slice(0, VISUAL_EMBEDDING_DIM)
  const patches = data.slice(VISUAL_EMBEDDING_DIM)
  return { cls, patches }
}

/** Production-equivalent: L2-normalized CLS token only (matches the shipped visual-worker.ts). */
export async function embedImageBuffer(buffer) {
  const { cls } = await embedImageRaw(buffer)
  return l2normalize(cls)
}

/**
 * Pooling variants over one raw embedding output (§7). Every variant is returned L2-normalized so
 * cosine similarity == dot product uniformly across variants.
 */
export function poolVariants(raw) {
  const { cls, patches } = raw
  const dim = VISUAL_EMBEDDING_DIM
  const numPatches = patches.length / dim

  const meanPatch = new Float32Array(dim)
  for (let p = 0; p < numPatches; p += 1) {
    for (let d = 0; d < dim; d += 1) meanPatch[d] += patches[p * dim + d]
  }
  for (let d = 0; d < dim; d += 1) meanPatch[d] /= numPatches

  const maxPatch = new Float32Array(dim).fill(-Infinity)
  for (let p = 0; p < numPatches; p += 1) {
    for (let d = 0; d < dim; d += 1) {
      const v = patches[p * dim + d]
      if (v > maxPatch[d]) maxPatch[d] = v
    }
  }

  // CLS + mean-patch blend (equal-weight average of the two normalized vectors, then re-normalized
  // — a cheap, parameter-free fusion, not a learned weight).
  const clsNorm = l2normalize(cls)
  const meanNorm = l2normalize(meanPatch)
  const blend = new Float32Array(dim)
  for (let d = 0; d < dim; d += 1) blend[d] = (clsNorm[d] + meanNorm[d]) / 2

  // Center-patch pooling: the single patch token nearest the image center (index for a 16x16 grid
  // is row 7-8, col 7-8 — pick the exact center index 7*16+7=119).
  const centerIndex = 119
  const centerPatch = patches.slice(centerIndex * dim, (centerIndex + 1) * dim)

  // GeM-like pooling (generalized mean, p=3) over patch tokens — softly emphasizes strong
  // activations more than plain mean, less harshly than max.
  const gemP = 3
  const gem = new Float32Array(dim)
  for (let p = 0; p < numPatches; p += 1) {
    for (let d = 0; d < dim; d += 1) {
      const v = patches[p * dim + d]
      const sign = v < 0 ? -1 : 1
      gem[d] += sign * Math.pow(Math.abs(v), gemP)
    }
  }
  for (let d = 0; d < dim; d += 1) {
    const mean = gem[d] / numPatches
    const sign = mean < 0 ? -1 : 1
    gem[d] = sign * Math.pow(Math.abs(mean), 1 / gemP)
  }

  return {
    cls: clsNorm,
    meanPatch: l2normalize(meanPatch),
    maxPatch: l2normalize(maxPatch),
    clsMeanBlend: l2normalize(blend),
    centerPatch: l2normalize(centerPatch),
    gem: l2normalize(gem),
  }
}

export const POOLING_VARIANTS = [
  'cls',
  'meanPatch',
  'maxPatch',
  'clsMeanBlend',
  'centerPatch',
  'gem',
]
