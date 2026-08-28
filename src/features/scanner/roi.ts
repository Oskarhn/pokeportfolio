/**
 * ROI extraction + deterministic preprocessing (prompt §14/§15). Regions are fractions of the
 * CARD RECT — never of the whole camera frame — and the named constants here are the single
 * definition the tests pin. Preprocessing here is deliberately small browser-native canvas work
 * (grayscale, contrast normalisation, bounded upscale): no OpenCV, no rotation heuristics. Actual
 * perspective correction (P79) now runs earlier in the pipeline — `rectify-capture.ts` hands both
 * OCR and the visual channel an already-rectified card image before either of them sees a frame,
 * so the card rect these fractions apply to is normally already axis-aligned by the time it gets
 * here; a homegrown warp does not belong duplicated inside ROI extraction too.
 *
 * P80 ADAPTIVE ROI: a single fixed fraction per field was proven wrong on real captures — the
 * owner's `?scannerDebug=1` image preview showed the name ROI landing on artwork and the number
 * ROI landing on rules/credit text for a modern card (Mega Chandelure ex). Root cause: the
 * original single fractions encode ONE Pokémon-card layout family (vintage WOTC/e-series —
 * name in a narrow top-left band, collector number bottom-RIGHT e.g. "4/102") but modern
 * SM/SWSH/SV-era English cards print the name across most of the top edge and moved the
 * collector number bottom-LEFT beside the set symbol (e.g. "049/197") — a different layout,
 * not a defect in the original research. `analyze.ts` now tries every candidate below per field
 * and scores the OCR result of each (confidence + parseability), picking a winner per scan —
 * never a hard-coded "this photo is modern/vintage" guess.
 */

import type { PixelRect } from './guide-geometry'

/** Name strip: top ~20% of the card height, left ~62% of its width (name sits top-left) — the
 *  VINTAGE layout. Kept as its own constant (tests pin it) and as the first entry of
 *  {@link NAME_ROI_CANDIDATES}. */
export const NAME_ROI_FRACTIONS = { left: 0, top: 0, width: 0.62, height: 0.2 } as const
/** Collector-number strip: bottom ~13% of the card height, right ~55% of its width — the VINTAGE
 *  layout. Kept as its own constant (tests pin it) and as one entry of
 *  {@link NUMBER_ROI_CANDIDATES}. */
export const NUMBER_ROI_FRACTIONS = {
  left: 0.45,
  top: 0.87,
  width: 0.55,
  height: 0.13,
} as const

export interface RoiFractions {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** One named ROI layout hypothesis — `id` is diagnostics-only (P80 debug panel: "which ROI won"). */
export interface NamedRoiCandidate {
  readonly id: string
  readonly fractions: RoiFractions
}

/** Modern (SM/SWSH/SV-era) name plate: spans nearly the full width, starting a little in from
 *  the top-left corner (rounded card corner / holo header art otherwise contaminates the very
 *  first row). Both this and the vintage strip above are always tried; see the module doc. */
const MODERN_NAME_ROI_FRACTIONS: RoiFractions = {
  left: 0.03,
  top: 0.02,
  width: 0.88,
  height: 0.15,
}

/** Modern (SM/SWSH/SV-era) collector-number strip: small text bottom-LEFT beside the set symbol
 *  (e.g. "049/197"), not bottom-right. */
const MODERN_NUMBER_ROI_FRACTIONS: RoiFractions = {
  left: 0.03,
  top: 0.9,
  width: 0.32,
  height: 0.08,
}

/** Every name-strip layout hypothesis `analyze.ts` tries, in no particular priority order — the
 *  winner is chosen by OCR score, not by list position (P80). */
export const NAME_ROI_CANDIDATES: readonly NamedRoiCandidate[] = [
  { id: 'classic-top-left', fractions: NAME_ROI_FRACTIONS },
  { id: 'modern-full-width', fractions: MODERN_NAME_ROI_FRACTIONS },
]

/** Every collector-number layout hypothesis `analyze.ts` tries (P80). */
export const NUMBER_ROI_CANDIDATES: readonly NamedRoiCandidate[] = [
  { id: 'modern-bottom-left', fractions: MODERN_NUMBER_ROI_FRACTIONS },
  { id: 'classic-bottom-right', fractions: NUMBER_ROI_FRACTIONS },
]

/** A card-relative fraction rect mapped to integer pixels inside a concrete card rect. Pure;
 *  always fully inside the card bounds; at least 1 px tall/wide when the card itself is. */
export function roiPixelRect(cardRect: PixelRect, fractions: RoiFractions): PixelRect {
  const left = cardRect.left + Math.round(cardRect.width * fractions.left)
  const top = cardRect.top + Math.round(cardRect.height * fractions.top)
  const right = Math.min(
    cardRect.left + cardRect.width,
    cardRect.left + Math.round(cardRect.width * (fractions.left + fractions.width)),
  )
  const bottom = Math.min(
    cardRect.top + cardRect.height,
    cardRect.top + Math.round(cardRect.height * (fractions.top + fractions.height)),
  )
  return {
    left: Math.min(left, right),
    top: Math.min(top, bottom),
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

/**
 * Platform-independent grayscale image: a plain byte array plus dimensions, so every transform
 * below is a pure function testable outside a browser.
 */
export interface GrayImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** ITU-R BT.601 luma — the conventional canvas grayscale weighting. */
export function toGrayscale(source: GrayImage): GrayImage {
  const out = new Uint8ClampedArray(source.width * source.height)
  for (let i = 0; i < out.length; i += 1) {
    const r = source.data[i * 4] ?? 0
    const g = source.data[i * 4 + 1] ?? 0
    const b = source.data[i * 4 + 2] ?? 0
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  return { data: out, width: source.width, height: source.height }
}

/**
 * Contrast normalisation: stretches the luminance histogram between robust percentiles (5th–95th)
 * so glare/shadow across small ROIs does not crush text, while leaving already-full-range images
 * effectively unchanged. Deterministic: same input bytes → same output bytes.
 */
export function normalizeContrast(image: GrayImage): GrayImage {
  if (image.data.length === 0) return image
  const histogram = new Uint32Array(256)
  for (const value of image.data) histogram[value] = (histogram[value] ?? 0) + 1
  const total = image.data.length
  const lowCut = total * 0.05
  const highCut = total * 0.05
  let low = 0
  let seen = 0
  while (low < 255 && seen + (histogram[low] ?? 0) <= lowCut) {
    seen += histogram[low] ?? 0
    low += 1
  }
  let high = 255
  seen = 0
  while (high > low && seen + (histogram[high] ?? 0) <= highCut) {
    seen += histogram[high] ?? 0
    high -= 1
  }
  const out = new Uint8ClampedArray(total)
  if (high <= low) {
    out.fill(high)
    return { data: out, width: image.width, height: image.height }
  }
  const scale = 255 / (high - low)
  for (let i = 0; i < total; i += 1) {
    out[i] = Math.round(Math.min(255, Math.max(0, ((image.data[i] ?? 0) - low) * scale)))
  }
  return { data: out, width: image.width, height: image.height }
}

/** ROIs below this pixel height are upscaled 2× before recognition (thin small glyphs benefit;
 *  anything taller is already legible to the LSTM and upscaling just costs time). */
export const ROI_UPSCALE_MIN_HEIGHT_PX = 48

/** The upscale factor applied when an ROI lands under ROI_UPSCALE_MIN_HEIGHT_PX. */
export const ROI_UPSCALE_FACTOR = 2
