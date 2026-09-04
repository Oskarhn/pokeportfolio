export interface QualityMetrics {
  laplacianVariance: number
  tenengrad: number
  glareFraction: number
  clippedFraction: number
  shadowCv: number
  brightnessMean: number
  contrastStd: number
}

export function computeQualityMetrics(buffer: Buffer): Promise<QualityMetrics>
