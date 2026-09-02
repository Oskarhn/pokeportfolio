/**
 * Node-side ROI crop + preprocess, byte-for-byte the SAME pure functions
 * `src/features/scanner/analyze.ts`'s `drawPreparedRegion` runs in the browser (roi.ts's
 * `toGrayscale`/`normalizeContrast`/`binarizeGrayscale` are plain TypeScript with no DOM
 * dependency) — only the canvas-drawing/cropping step is swapped for `sharp`, so this benchmark
 * measures the REAL preprocessing math, not a reimplementation of it.
 */
import sharp from 'sharp'
import type { RgbaImage } from '../../../src/domain/scanner/rectify'
import {
  toGrayscale,
  normalizeContrast,
  binarizeGrayscale,
  roiPixelRect,
  ROI_UPSCALE_MIN_HEIGHT_PX,
  ROI_UPSCALE_FACTOR,
  type RoiFractions,
  type GrayImage,
} from '../../../src/features/scanner/roi'
import type { PixelRect } from '../../../src/features/scanner/guide-geometry'

export type RoiPreprocess = 'contrast' | 'binarize'

function toNodeBuffer(data: Uint8ClampedArray): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

/** Crops one fractional ROI out of a working RGBA image, upscaling small strips exactly like
 *  analyze.ts does, then applies the requested preprocessing pass. Returns a PNG buffer ready for
 *  Tesseract plus the pixel rect actually used (diagnostics only). */
export async function extractPreparedRoiPng(
  working: RgbaImage,
  fractions: RoiFractions,
  preprocess: RoiPreprocess,
): Promise<{ png: Buffer; rect: PixelRect } | null> {
  const cardRect: PixelRect = { left: 0, top: 0, width: working.width, height: working.height }
  const rect = roiPixelRect(cardRect, fractions)
  if (rect.width < 8 || rect.height < 8) return null
  const upscale = rect.height < ROI_UPSCALE_MIN_HEIGHT_PX ? ROI_UPSCALE_FACTOR : 1

  const { data, info } = await sharp(toNodeBuffer(working.data), {
    raw: { width: working.width, height: working.height, channels: 4 },
  })
    .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    .resize(Math.max(1, rect.width * upscale), Math.max(1, rect.height * upscale))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const gray: GrayImage = toGrayscale({
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  })
  const prepared = preprocess === 'binarize' ? binarizeGrayscale(gray) : normalizeContrast(gray)
  const png = await sharp(toNodeBuffer(prepared.data), {
    raw: { width: prepared.width, height: prepared.height, channels: 1 },
  })
    .png()
    .toBuffer()
  return { png, rect }
}
