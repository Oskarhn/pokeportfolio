export const HARD_AUGMENTATION_PROFILES: string[]

export interface HardAugmentedView {
  profile: string
  buffer: Buffer
  nominalRect: { left: number; top: number; width: number; height: number }
  canvasWidth: number
  canvasHeight: number
}

export function hardAugmentAll(
  imageBuffer: Buffer,
  cardId: string,
  profiles?: string[],
): Promise<HardAugmentedView[]>

export function cropToNominalRect(
  buffer: Buffer,
  nominalRect: { left: number; top: number; width: number; height: number },
  canvasW: number,
  canvasH: number,
): Promise<Buffer>
