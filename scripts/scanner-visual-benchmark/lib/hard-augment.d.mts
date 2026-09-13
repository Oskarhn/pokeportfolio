export const HARD_AUGMENTATION_PROFILES: string[]

export interface HardAugmentedQuery {
  profile: string
  buffer: Buffer
  nominalRect: { left: number; top: number; width: number; height: number }
  canvasWidth: number
  canvasHeight: number
}

export function hardAugmentAll(imageBuffer: Buffer, cardId: string): Promise<HardAugmentedQuery[]>
