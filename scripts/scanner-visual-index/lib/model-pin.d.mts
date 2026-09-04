export const VISUAL_MODEL_REPO: string
export const VISUAL_MODEL_REVISION: string
export const VISUAL_MODEL_DTYPE: string
export const VISUAL_EMBEDDING_DIM: number
export const VISUAL_INDEX_VERSION: string
export interface VisualModelFile {
  upstreamPath: string
  stagedName: string
  sha256: string
  bytes: number | null
}
export const VISUAL_MODEL_FILES: VisualModelFile[]
export const PROTOTYPE_STRATEGY: string
export const PROTOTYPE_STRATEGY_VERSION: string
export const PROTOTYPES_PER_CARD: number
