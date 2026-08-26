// Pinned identity of the visual recognition model (D-097). ANY change to these values is a
// deliberate model/revision bump — verified by SHA-256, never trusted from a mutable "latest".
export const VISUAL_MODEL_REPO = 'Xenova/dinov2-small'
export const VISUAL_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'
export const VISUAL_MODEL_DTYPE = 'q8'
export const VISUAL_EMBEDDING_DIM = 384
export const VISUAL_INDEX_VERSION = 'visual-v1'

// Upstream file -> local staged name + expected SHA-256 (recorded 2026-08-26 from the pinned
// revision above; see docs/DECISIONS.md D-097 for how these were verified).
export const VISUAL_MODEL_FILES = [
  {
    // Staged path preserves the `onnx/` subdirectory: transformers.js's local-model resolution
    // requests `${localModelPath}${modelId}/onnx/model_quantized.onnx`, mirroring the upstream
    // Hugging Face repo layout exactly (verified against its resolution code before staging
    // flat broke silently at runtime).
    upstreamPath: 'onnx/model_quantized.onnx',
    stagedName: 'onnx/model_quantized.onnx',
    sha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    bytes: 24451943,
  },
  {
    upstreamPath: 'config.json',
    stagedName: 'config.json',
    sha256: '471007e1c59df520030a2690998f4e0ba5d810bc4f959d1984f630d198faa07e',
    bytes: null,
  },
  {
    upstreamPath: 'preprocessor_config.json',
    stagedName: 'preprocessor_config.json',
    sha256: '14e780d86fa1861f8751f868d7f45425b5feb55c38ca26f152ca5097ab30f828',
    bytes: null,
  },
]
