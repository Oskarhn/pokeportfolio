/**
 * Shared query-preparation pipeline for the P85 OCR benchmarks (forensics grid search + the full
 * recognition benchmark) — builds realistic phone-like perturbed queries from one clean reference
 * card image, reusing the EXISTING P76/P79 augmentation modules rather than a third
 * reimplementation:
 *
 *   - `augmentAll` (scanner-visual-benchmark/lib/augment.mjs): 6 profiles applied directly to the
 *     tight reference card (resize/perspective-rotate/brightness-contrast/blur-jpeg/glare-overlay/
 *     shadow-color-shift) — an "already well-cropped card, but degraded" query.
 *   - `hardAugmentAll` (scanner-visual-benchmark/lib/hard-augment.mjs): 3 profiles that COMPOSE a
 *     synthetic phone photo (tilt + off-center placement on a larger background, optionally with
 *     combined glare/shadow/blur/noise) — a query that genuinely needs the real
 *     `src/domain/scanner/rectify.ts` detect+warp pipeline before it resembles a tight card image,
 *     run here through that REAL pipeline (mirrors run-hard-benchmark.ts's own rectifyBuffer).
 *
 * Together these 9 profiles cover every perturbation class P85 §2 asks for: perspective, skew,
 * brightness, shadow, glare, blur, compression (jpeg quality), small text (clean-resize), modern
 * vs. vintage layout is a property of the REFERENCE corpus itself (see reference-sets.mjs), not
 * a perturbation.
 */
import sharp from 'sharp'
import {
  rectifyCard,
  type RectPixelRect,
  type RgbaImage,
} from '../../../src/domain/scanner/rectify'
import { hardAugmentAll } from '../../scanner-visual-benchmark/lib/hard-augment.mjs'
import { augmentAll } from '../../scanner-visual-benchmark/lib/augment.mjs'

export interface OcrQuery {
  readonly profile: string
  readonly kind: 'augment' | 'hard-augment'
  readonly rgba: RgbaImage
  /** True when the P79 rectifier could not find a real card boundary and fell back to the plain
   *  nominal rect — only meaningful for `kind === 'hard-augment'` queries. */
  readonly usedRectifyFallback: boolean
}

const RECTIFY_EXPAND_FRACTION = 0.18
export const RECTIFY_OUTPUT_WIDTH = 700
export const RECTIFY_OUTPUT_HEIGHT = 980

function clampRect(rect: RectPixelRect, boundsWidth: number, boundsHeight: number): RectPixelRect {
  const left = Math.max(0, Math.min(Math.round(rect.left), boundsWidth - 1))
  const top = Math.max(0, Math.min(Math.round(rect.top), boundsHeight - 1))
  const right = Math.max(left + 1, Math.min(Math.round(rect.left + rect.width), boundsWidth))
  const bottom = Math.max(top + 1, Math.min(Math.round(rect.top + rect.height), boundsHeight))
  return { left, top, width: right - left, height: bottom - top }
}

function expandRect(
  rect: RectPixelRect,
  fraction: number,
  boundsWidth: number,
  boundsHeight: number,
): RectPixelRect {
  const padX = rect.width * fraction
  const padY = rect.height * fraction
  const left = Math.max(0, rect.left - padX)
  const top = Math.max(0, rect.top - padY)
  const right = Math.min(boundsWidth, rect.left + rect.width + padX)
  const bottom = Math.min(boundsHeight, rect.top + rect.height + padY)
  return { left, top, width: right - left, height: bottom - top }
}

async function rgbaFromBuffer(buffer: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  }
}

/** Runs the REAL rectify.ts detect+warp pipeline over a region of `buffer` — identical shape to
 *  run-hard-benchmark.ts's own rectifyBuffer, returning the raw RGBA (no JPEG re-encode) since
 *  OCR crops need the exact pixels, not a lossy round trip. */
async function rectifyHardQuery(
  buffer: Buffer,
  nominalRect: RectPixelRect,
  canvasW: number,
  canvasH: number,
): Promise<{ rgba: RgbaImage; usedFallback: boolean }> {
  const expanded = clampRect(
    expandRect(nominalRect, RECTIFY_EXPAND_FRACTION, canvasW, canvasH),
    canvasW,
    canvasH,
  )
  const { data, info } = await sharp(buffer)
    .extract({
      left: expanded.left,
      top: expanded.top,
      width: expanded.width,
      height: expanded.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgba: RgbaImage = {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  }
  const nominalLocal: RectPixelRect = {
    left: nominalRect.left - expanded.left,
    top: nominalRect.top - expanded.top,
    width: nominalRect.width,
    height: nominalRect.height,
  }
  const margin = Math.max(
    12,
    Math.round(
      Math.min(expanded.width - nominalRect.width, expanded.height - nominalRect.height) / 2,
    ),
  )
  const rectified = rectifyCard(
    rgba,
    nominalLocal,
    RECTIFY_OUTPUT_WIDTH,
    RECTIFY_OUTPUT_HEIGHT,
    margin,
  )
  return { rgba: rectified.image, usedFallback: rectified.usedFallback }
}

/** Builds all 9 realistic perturbed queries for one reference card image (P85 §2). Deterministic
 *  per `cardId` (both underlying augmentation modules seed from it). */
export async function buildOcrQueries(
  referenceBuffer: Buffer,
  cardId: string,
): Promise<OcrQuery[]> {
  const queries: OcrQuery[] = []
  const augmented = await augmentAll(referenceBuffer, cardId)
  for (const { profile, buffer } of augmented as { profile: string; buffer: Buffer }[]) {
    queries.push({
      profile,
      kind: 'augment',
      rgba: await rgbaFromBuffer(buffer),
      usedRectifyFallback: false,
    })
  }
  const hard = await hardAugmentAll(referenceBuffer, cardId)
  for (const { profile, buffer, nominalRect, canvasWidth, canvasHeight } of hard as {
    profile: string
    buffer: Buffer
    nominalRect: RectPixelRect
    canvasWidth: number
    canvasHeight: number
  }[]) {
    const { rgba, usedFallback } = await rectifyHardQuery(
      buffer,
      nominalRect,
      canvasWidth,
      canvasHeight,
    )
    queries.push({ profile, kind: 'hard-augment', rgba, usedRectifyFallback: usedFallback })
  }
  return queries
}
