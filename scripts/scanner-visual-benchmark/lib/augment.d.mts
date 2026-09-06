export const AUGMENTATION_PROFILES: string[]
export function augmentAll(
  imageBuffer: Buffer,
  cardId: string,
): Promise<{ profile: string; buffer: Buffer }[]>
