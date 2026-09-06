export const VISUAL_MODEL_ID: string
export const VISUAL_MODEL_REVISION: string
export const VISUAL_EMBEDDING_DIM: number
export function embedImageBuffer(buffer: Buffer): Promise<Float32Array>
export function warmUpModel(): Promise<void>
