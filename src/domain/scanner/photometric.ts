/**
 * Photometric normalization for the visual-embedding QUERY image (P80 §5). Investigated because
 * the owner's real-device Mega Chandelure ex miss showed the top visual neighbours were unrelated
 * foil/full-art cards — consistent with DINOv2's full-card embedding weighting a card's overall
 * color/foil/rainbow texture more than its structural identity for highly reflective modern
 * printings. Two independent, deliberately MILD corrections, applied in this order:
 *
 * 1. Contrast stretch — the SAME robust 5th/95th-percentile histogram stretch roi.ts's
 *    `normalizeContrast` already uses for OCR, but computed from LUMA and applied identically to
 *    R/G/B (preserves hue/color ratios, unlike stretching each channel independently) so glare or
 *    underexposure does not silently compress the embedding's usable dynamic range.
 * 2. Bounded desaturation — blends each pixel a small, fixed fraction toward its own greyscale
 *    value. A foil card's dominant visual signature is often its rainbow/holo COLOR pattern, not
 *    its illustration; pulling color influence down a little (never to zero — this is not a
 *    grayscale conversion) nudges the embedding toward structure/shape over color/finish without
 *    destroying genuinely useful color information for ordinary cards.
 *
 * Pure and platform-neutral (plain RGBA typed arrays, no canvas/DOM) — same discipline as
 * rectify.ts, so the identical code runs in the browser worker and the offline Node benchmark.
 * NOT wired into the shipped pipeline by default — see docs/SCANNER_RESEARCH.md §7c for why this
 * session could not gather scale-appropriate evidence to justify enabling it (the available
 * benchmark corpus cannot reproduce the near-duplicate-foil-card confusion the real 19,501-card
 * index can produce). Available as a tested, opt-in transform for a future session with the
 * evidence to decide.
 */

export interface PhotometricRgbaImage {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** Fraction each pixel blends toward its own luma (0 = no desaturation, 1 = full greyscale).
 *  Deliberately small — this is a nudge against foil/rainbow color dominance, not a grayscale
 *  conversion that would throw away genuinely useful color evidence for ordinary cards. */
export const PHOTOMETRIC_DESATURATION_FRACTION = 0.15

/** Percentile cut on each tail of the luma histogram before stretching (matches roi.ts's OCR
 *  contrast normalization exactly — one researched constant, not a second guess). */
const PERCENTILE_CUT = 0.05

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function clamp255(value: number): number {
  return Math.round(Math.min(255, Math.max(0, value)))
}

/**
 * Contrast-stretches an RGBA image by its LUMA distribution (one shared low/high cut applied to
 * all three color channels, so hue is preserved) then blends a bounded fraction of each pixel
 * toward greyscale. Deterministic: identical input bytes always produce identical output bytes.
 * A perfectly flat (zero-variance) image is returned unchanged — there is no contrast to stretch,
 * and stretching a flat image would only amplify quantization noise (same reasoning as roi.ts's
 * `normalizeContrast`).
 */
export function normalizePhotometricRgba(
  image: PhotometricRgbaImage,
  desaturationFraction: number = PHOTOMETRIC_DESATURATION_FRACTION,
): PhotometricRgbaImage {
  const { data, width, height } = image
  const pixelCount = width * height
  if (pixelCount === 0) return image

  const histogram = new Uint32Array(256)
  for (let i = 0; i < pixelCount; i += 1) {
    const r = data[i * 4] ?? 0
    const g = data[i * 4 + 1] ?? 0
    const b = data[i * 4 + 2] ?? 0
    const value = Math.round(luma(r, g, b))
    histogram[value] = (histogram[value] ?? 0) + 1
  }

  const lowCut = pixelCount * PERCENTILE_CUT
  const highCut = pixelCount * PERCENTILE_CUT
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

  const out = new Uint8ClampedArray(data.length)
  if (high <= low) {
    out.set(data)
    return { data: out, width, height }
  }

  const scale = 255 / (high - low)
  for (let i = 0; i < pixelCount; i += 1) {
    const r = data[i * 4] ?? 0
    const g = data[i * 4 + 1] ?? 0
    const b = data[i * 4 + 2] ?? 0
    const a = data[i * 4 + 3] ?? 255
    const sr = clamp255((r - low) * scale)
    const sg = clamp255((g - low) * scale)
    const sb = clamp255((b - low) * scale)
    const grey = luma(sr, sg, sb)
    out[i * 4] = clamp255(sr + (grey - sr) * desaturationFraction)
    out[i * 4 + 1] = clamp255(sg + (grey - sg) * desaturationFraction)
    out[i * 4 + 2] = clamp255(sb + (grey - sb) * desaturationFraction)
    out[i * 4 + 3] = a
  }
  return { data: out, width, height }
}
