// Shared embedding function for the benchmark — the SAME model id/revision/dtype and the SAME
// AutoProcessor preprocessing the browser runtime will use (prompt §20: a reference index
// generated with incompatible preprocessing is invalid). See docs/DECISIONS.md D-097 for the
// pinned model identity.
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const VISUAL_MODEL_ID = 'Xenova/dinov2-small'
export const VISUAL_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'
export const VISUAL_EMBEDDING_DIM = 384

env.allowRemoteModels = true
env.cacheDir = join(here, '..', '.benchmark-cache', 'hf-cache')

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

/** Embeds one image buffer (any format sharp/RawImage can decode). Returns L2-normalized
 *  Float32Array of length VISUAL_EMBEDDING_DIM (the CLS token — DINOv2 has no pooler head). */
export async function embedImageBuffer(buffer) {
  const model = await loadModel()
  const processor = await loadProcessor()
  const image = await RawImage.fromBlob(new Blob([buffer]))
  const inputs = await processor(image)
  const { last_hidden_state } = await model(inputs)
  const data = Float32Array.from(last_hidden_state.data)
  const vector = data.slice(0, VISUAL_EMBEDDING_DIM)
  let norm = 0
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
  return vector
}

export async function warmUpModel() {
  await loadModel()
  await loadProcessor()
}
