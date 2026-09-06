export const PSM: {
  AUTO: string
  SINGLE_BLOCK: string
  SINGLE_LINE: string
  SINGLE_WORD: string
  SPARSE_TEXT: string
  RAW_LINE: string
}
export function recognizeWithConfig(
  buffer: Buffer,
  options?: {
    psm?: string
    whitelist?: string
    preserveInterwordSpaces?: boolean
    dpi?: string
  },
): Promise<{ text: string; confidence: number }>
export function disposeOcr(): Promise<void>
