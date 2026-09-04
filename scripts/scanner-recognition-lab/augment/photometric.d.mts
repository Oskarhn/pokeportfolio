export const AUGMENTATION_PROFILES: string[]

export interface AugmentedView {
  profile: string
  buffer: Buffer
}

export function augmentAll(
  imageBuffer: Buffer,
  cardId: string,
  profiles?: string[],
): Promise<AugmentedView[]>

export function applyNamedProfile(
  name: string,
  imageBuffer: Buffer,
  cardId: string,
): Promise<Buffer>
