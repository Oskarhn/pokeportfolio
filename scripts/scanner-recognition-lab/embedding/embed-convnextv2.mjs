// P95 §12: ConvNeXtV2-tiny-22k-224 (Apache-2.0), the one alternative-model candidate with a
// ready-made ONNX/transformers.js conversion (Xenova/convnextv2-tiny-22k-224). MobileNetV3-small
// and EfficientFormer-L1 were probed against the Hugging Face API and have NO Xenova/onnx-community
// ONNX conversion available (401 on every plausible repo id tried) — converting either from its
// PyTorch weights would require standing up a separate Python/onnxruntime export+calibration
// pipeline, explicitly the "multi-hour rabbit hole" the P95 prompt says to stop rather than enter.
// Disclosed limitation, not silently skipped: this repo only exports the CLASSIFICATION-HEAD ONNX
// graph (`ConvNextV2ForImageClassification`, output "logits" over 1000 ImageNet classes) — there is
// no separate pooled-feature/last_hidden_state output available in this specific conversion. The
// benchmark below uses the L2-normalized 1000-d logit vector AS the embedding, a known-lossy
// stand-in (ImageNet-category-discriminative, not instance-discriminative) — a real production
// candidate would need a feature-extraction (no-head) export, not attempted here.
import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const MODEL_ID = 'Xenova/convnextv2-tiny-22k-224'
export const EMBEDDING_DIM = 1000 // logits, not a true pooled-feature embedding — see header

env.allowRemoteModels = true
env.cacheDir = join(here, '..', '.cache', 'hf-cache')

let modelPromise = null
let processorPromise = null
function loadModel() {
  if (!modelPromise) modelPromise = AutoModel.from_pretrained(MODEL_ID, { dtype: 'q8' })
  return modelPromise
}
function loadProcessor() {
  if (!processorPromise) processorPromise = AutoProcessor.from_pretrained(MODEL_ID)
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

export async function embedImageBuffer(buffer) {
  const model = await loadModel()
  const processor = await loadProcessor()
  const image = await RawImage.fromBlob(new Blob([buffer]))
  const inputs = await processor(image)
  const { logits } = await model(inputs)
  return l2normalize(Float32Array.from(logits.data))
}
