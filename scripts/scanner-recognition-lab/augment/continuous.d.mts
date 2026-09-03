export declare const AXES: string[]
export declare const NUM_LEVELS: number
export declare const SCALES: Record<string, number[]>
export declare const BRIGHTNESS_NORMAL_LEVEL: number
export interface ContinuousLevels {
  blur?: number
  shadow?: number
  glare?: number
  noise?: number
  perspective?: number
  brightness?: number
}
export declare function composeContinuous(
  buffer: Buffer,
  cardId: string,
  levels?: ContinuousLevels,
): Promise<Buffer>
export declare const IPHONE_LIKE_LEVELS: Required<ContinuousLevels>
