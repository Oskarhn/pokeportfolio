export declare const VISUAL_MODEL_ID: string
export declare const VISUAL_MODEL_REVISION: string
export declare const VISUAL_EMBEDDING_DIM: number
export declare function warmUpModel(): Promise<void>
export declare function embedImageBuffer(buffer: Buffer): Promise<Float32Array>
