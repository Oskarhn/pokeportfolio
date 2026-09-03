// Pinned identity of the visual recognition model (D-097). ANY change to these values is a
// deliberate model/revision bump — verified by SHA-256, never trusted from a mutable "latest".
export const VISUAL_MODEL_REPO = 'Xenova/dinov2-small'
export const VISUAL_MODEL_REVISION = 'c2bb04a51fab207c420665f1946016107bffc701'
export const VISUAL_MODEL_DTYPE = 'q8'
export const VISUAL_EMBEDDING_DIM = 384
export const VISUAL_INDEX_VERSION = 'visual-v1'

// P97 (D-106): dual-prototype reference augmentation — the production strategy P91/P95's
// recognition R&D chose (`pristinePlus1Aux`), NOT image rerank, a general quality gate, a new
// model, or local-feature rerank (all explicitly rejected by that research — see docs/DECISIONS.md
// D-106 and ai_outputs/Claude_outputs/output_95.txt). Prototype 0 is the plain pristine reference
// embedding (unchanged from visual-v1); prototype 1 is the L2-normalized mean of 6 deterministic
// photometric/geometric augmentations of the SAME reference image, embedded and averaged — the
// exact recipe verified against P91's scripts/scanner-recognition-lab/experiments/
// 03-robust-reference.mjs and P95's scripts/scanner-recognition-lab/experiments/
// 16-cost-and-search-benchmark.mjs (both independently confirmed to use this identical
// augment-embed-mean-normalize sequence). ANY change to the augmentation recipe (profile list,
// seeding, parameters) is a deliberate strategy version bump — see prototype-augmentation.mjs.
export const PROTOTYPE_STRATEGY = 'pristinePlus1Aux'
export const PROTOTYPE_STRATEGY_VERSION = '1'
export const PROTOTYPE_COUNT = 2

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
