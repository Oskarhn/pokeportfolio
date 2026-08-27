/**
 * Canvas glue between one raw {@link CapturedFrame} and the pure rectification math in
 * `src/domain/scanner/rectify.ts` (P79). Produces a canonical, card-only image that BOTH the OCR
 * and visual channels then consume through their existing, unchanged code paths — this is the one
 * new step controller.ts inserts before either of them runs.
 *
 * Deliberately generous input, deliberately narrow output: the guide rectangle the user aligned
 * to may include a little background on one or more sides (imperfect alignment) or the card
 * itself may sit at a mild tilt within it — this module hands the pure detector an EXPANDED
 * region around the guide crop (never beyond the captured frame's own bounds, never upscaled
 * past the source resolution) so it has real pixels to search, then always emits a fixed-size,
 * axis-aligned, single-card image regardless of whether detection found a real boundary or fell
 * back to the plain guide rectangle.
 *
 * Never throws: any failure (decode, canvas, detection) returns the ORIGINAL capture untouched
 * with `usedFallback: true` — the scanner must keep working exactly as it did before this module
 * existed, never crash.
 */
import { rectifyCard, type Quadrilateral, type RgbaImage } from '../../domain/scanner/rectify'
import { canvasToBlob, createCompatCanvas } from './canvas-compat'
import type { PixelRect } from './guide-geometry'

export interface CapturedFrame {
  blob: Blob
  width: number
  height: number
  cardRect: PixelRect
}

/** How far beyond the guide rectangle the detector is allowed to look, as a fraction of the
 *  guide's own width/height on each side — covers realistic imperfect alignment without pulling
 *  in so much background that an unrelated edge (a table's own border, a second object) could be
 *  mistaken for the card. */
export const RECTIFY_EXPAND_FRACTION = 0.18
/** Working canvas bound for detection — generous enough to keep real card-edge detail, small
 *  enough that Sobel + line-fit stays cheap on a phone (prompt §13 performance discipline). Never
 *  upscales past the source (same discipline as capture.ts's CAPTURE_MAX_LONG_EDGE). */
export const RECTIFY_WORKING_LONG_EDGE = 1000
/** Canonical output size: 5:7 (the card's own aspect), tall enough that OCR's own downstream
 *  ROI fractions still land on legible text and DINO gets real detail, not a blown-up guess. */
export const RECTIFY_OUTPUT_WIDTH = 700
export const RECTIFY_OUTPUT_HEIGHT = 980
/** Detection margin floor (working-space px) — file uploads and any capture whose cardRect
 *  already fills the frame have zero room to expand into, so the detector still gets a small
 *  real search band rather than a degenerate zero-margin call. */
const MIN_DETECTION_MARGIN_PX = 12

export interface RectifyCaptureResult {
  frame: CapturedFrame
  usedFallback: boolean
  corners: Quadrilateral | null
  /** Present only when `debug` was requested (P79 §4): a plain, un-rectified crop-to-guide-rect
   *  preview at the same canonical size, for the debug panel's side-by-side comparison. Never
   *  produced otherwise — encoding it costs a real JPEG pass this module skips by default. */
  debugRawCropBlob: Blob | null
}

/** Expands `rect` by `fraction` on every side, clamped to [0, boundsWidth] x [0, boundsHeight].
 *  Pure — the single place this session's "how much background room does detection get" policy
 *  lives, independently testable from the canvas work around it. */
export function expandRectForDetection(
  rect: PixelRect,
  fraction: number,
  boundsWidth: number,
  boundsHeight: number,
): PixelRect {
  const padX = rect.width * fraction
  const padY = rect.height * fraction
  const left = Math.max(0, rect.left - padX)
  const top = Math.max(0, rect.top - padY)
  const right = Math.min(boundsWidth, rect.left + rect.width + padX)
  const bottom = Math.min(boundsHeight, rect.top + rect.height + padY)
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** Scale factor to bring `long edge of (width, height)` down to at most `maxLongEdge` — NEVER
 *  upscales (mirrors capture.ts's own bounding rule). Pure. */
export function detectionWorkingScale(width: number, height: number, maxLongEdge: number): number {
  const longEdge = Math.max(width, height)
  return longEdge <= maxLongEdge ? 1 : maxLongEdge / longEdge
}

/** Maps `cardRect` (in the ORIGINAL frame's pixel space) into the working canvas's local space,
 *  given the expanded region it was cropped from and the scale applied when drawing it. Pure. */
export function cardRectInWorkingSpace(
  cardRect: PixelRect,
  expandedRect: PixelRect,
  scale: number,
): PixelRect {
  return {
    left: (cardRect.left - expandedRect.left) * scale,
    top: (cardRect.top - expandedRect.top) * scale,
    width: cardRect.width * scale,
    height: cardRect.height * scale,
  }
}

/** The working-space detection margin: half the expansion actually available on the tighter
 *  dimension, floored so a zero-expansion input (file uploads whose cardRect already covers the
 *  whole frame) still searches a small real band instead of a degenerate zero-width one. Pure. */
export function detectionMarginPx(
  cardRect: PixelRect,
  expandedRect: PixelRect,
  scale: number,
): number {
  const horizontalRoom = (expandedRect.width - cardRect.width) / 2
  const verticalRoom = (expandedRect.height - cardRect.height) / 2
  const room = Math.max(0, Math.min(horizontalRoom, verticalRoom)) * scale
  return Math.max(MIN_DETECTION_MARGIN_PX, Math.round(room))
}

function fallbackResult(capture: CapturedFrame): RectifyCaptureResult {
  return { frame: capture, usedFallback: true, corners: null, debugRawCropBlob: null }
}

/**
 * Produces a canonical, rectified {@link CapturedFrame} from a raw capture. Always resolves
 * (never rejects) — any internal failure resolves to the ORIGINAL capture untouched, exactly as
 * if rectification had never run.
 */
export async function rectifyCapture(
  capture: CapturedFrame,
  options: { debug?: boolean } = {},
): Promise<RectifyCaptureResult> {
  if (typeof createImageBitmap !== 'function') return fallbackResult(capture)
  let fullBitmap: ImageBitmap
  try {
    fullBitmap = await createImageBitmap(capture.blob)
  } catch {
    return fallbackResult(capture)
  }
  try {
    const expandedRect = expandRectForDetection(
      capture.cardRect,
      RECTIFY_EXPAND_FRACTION,
      capture.width,
      capture.height,
    )
    const scale = detectionWorkingScale(
      expandedRect.width,
      expandedRect.height,
      RECTIFY_WORKING_LONG_EDGE,
    )
    const workingWidth = Math.max(1, Math.round(expandedRect.width * scale))
    const workingHeight = Math.max(1, Math.round(expandedRect.height * scale))
    const working = createCompatCanvas(workingWidth, workingHeight)
    working.context.drawImage(
      fullBitmap,
      expandedRect.left,
      expandedRect.top,
      expandedRect.width,
      expandedRect.height,
      0,
      0,
      workingWidth,
      workingHeight,
    )
    const nominalRect = cardRectInWorkingSpace(capture.cardRect, expandedRect, scale)
    const margin = detectionMarginPx(capture.cardRect, expandedRect, scale)
    const imageData = working.context.getImageData(0, 0, workingWidth, workingHeight)
    const rgba: RgbaImage = { data: imageData.data, width: workingWidth, height: workingHeight }

    const rectified = rectifyCard(
      rgba,
      nominalRect,
      RECTIFY_OUTPUT_WIDTH,
      RECTIFY_OUTPUT_HEIGHT,
      margin,
    )

    const output = createCompatCanvas(RECTIFY_OUTPUT_WIDTH, RECTIFY_OUTPUT_HEIGHT)
    const outputImageData = output.context.createImageData(
      RECTIFY_OUTPUT_WIDTH,
      RECTIFY_OUTPUT_HEIGHT,
    )
    outputImageData.data.set(rectified.image.data)
    output.context.putImageData(outputImageData, 0, 0)
    const blob = await canvasToBlob(output.element)

    let debugRawCropBlob: Blob | null = null
    if (options.debug === true) {
      const rawCrop = createCompatCanvas(RECTIFY_OUTPUT_WIDTH, RECTIFY_OUTPUT_HEIGHT)
      rawCrop.context.drawImage(
        fullBitmap,
        capture.cardRect.left,
        capture.cardRect.top,
        capture.cardRect.width,
        capture.cardRect.height,
        0,
        0,
        RECTIFY_OUTPUT_WIDTH,
        RECTIFY_OUTPUT_HEIGHT,
      )
      debugRawCropBlob = await canvasToBlob(rawCrop.element)
    }

    return {
      frame: {
        blob,
        width: RECTIFY_OUTPUT_WIDTH,
        height: RECTIFY_OUTPUT_HEIGHT,
        cardRect: { left: 0, top: 0, width: RECTIFY_OUTPUT_WIDTH, height: RECTIFY_OUTPUT_HEIGHT },
      },
      usedFallback: rectified.usedFallback,
      corners: rectified.corners,
      debugRawCropBlob,
    }
  } catch {
    return fallbackResult(capture)
  } finally {
    fullBitmap.close()
  }
}
