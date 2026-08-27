/**
 * The OCR analysis pipeline (prompt §10–§17): one captured frame in, a raw textual observation
 * out. Canvas work only — the blob never leaves this module, nothing here performs network I/O,
 * and no OCR text is ever logged. One decoded source lives at a time; the ImageBitmap is closed
 * in a finally block; canvases are bounded and reused across analyses via a small pool
 * (prompt §12).
 *
 * Pipeline: decode → crop the card rect into a ≤1280-long-edge working canvas → extract the two
 * ROI strips relative to the CARD rect → grayscale + contrast-normalise (+2× upscale when tiny)
 * → sequential single-line recognition per strip → if BOTH strips come back unusable, exactly
 * ONE full-card auto-mode fallback pass with a conservative name/number split (prompt §17). No
 * repeated inference, no automatic recapture.
 */

import type { ScannerCapture } from './contract'
import {
  NAME_ROI_FRACTIONS,
  NUMBER_ROI_FRACTIONS,
  normalizeContrast,
  roiPixelRect,
  toGrayscale,
  ROI_UPSCALE_FACTOR,
  ROI_UPSCALE_MIN_HEIGHT_PX,
  type GrayImage,
} from './roi'
import {
  canvasToBlob,
  createCompatCanvas,
  type ScanCanvas,
  type ScanContext,
} from './canvas-compat'
import type { PixelRect } from './guide-geometry'

/** Long edge of the temporary OCR working bitmap (prompt §12). The stored review image is never
 *  mutated for OCR's benefit — recognition works on its own smaller copy. */
export const OCR_WORKING_LONG_EDGE = 1280

/** A raw, untrusted OCR observation of one physical card. Text only; feeds P67's matcher. */
export interface RawOcrObservation {
  rawNameText: string | null
  rawCollectorNumberText: string | null
  /** True when both ROIs failed and the single bounded full-card pass ran instead. */
  usedFullFrameFallback: boolean
  /** Present only when the caller asked for debug images (P79 §4/§12) — the exact ROI bitmaps
   *  OCR actually read, for the debug panel's "is the model seeing the card cleanly?" preview.
   *  Null values mean that particular ROI never ran (e.g. the full-frame fallback path). */
  debugImages?: { nameRoiBlob: Blob | null; numberRoiBlob: Blob | null }
}

export interface OcrEnginePort {
  prepare: () => Promise<void>
  recognize: (
    source: HTMLCanvasElement | OffscreenCanvas,
    segmentation?: 'single-line' | 'auto',
  ) => Promise<{ text: string; confidence: number }>
}

/** Minimum usable signal lengths — anything shorter is treated as "nothing read" rather than
 *  handed to the parser (P67's own parser fails closed anyway; this avoids pointless queries). */
export const MIN_NAME_TEXT_LENGTH = 3
export const MIN_NUMBER_TEXT_LENGTH = 2

interface BoundedCanvas {
  element: ScanCanvas
  context: ScanContext
}

const createBoundedCanvas = createCompatCanvas

/**
 * Tiny reusable bounded-canvas pool (prompt §12): at most three canvases alive for a session
 * (working image + two ROI strips), resized upward when a larger card arrives, whatever how many
 * cards get scanned. Injectable so tests can substitute recording fakes.
 */
export class CanvasPool {
  private working: BoundedCanvas | null = null
  private nameRoi: BoundedCanvas | null = null
  private numberRoi: BoundedCanvas | null = null

  take(slot: 'working' | 'nameRoi' | 'numberRoi', width: number, height: number): BoundedCanvas {
    const existing =
      slot === 'working' ? this.working : slot === 'nameRoi' ? this.nameRoi : this.numberRoi
    if (
      existing !== null &&
      existing.element.width >= Math.max(1, Math.round(width)) &&
      existing.element.height >= Math.max(1, Math.round(height))
    ) {
      return existing
    }
    const created = createBoundedCanvas(width, height)
    if (slot === 'working') this.working = created
    else if (slot === 'nameRoi') this.nameRoi = created
    else this.numberRoi = created
    return created
  }

  release(): void {
    this.working = null
    this.nameRoi = null
    this.numberRoi = null
  }
}

const sharedPool = new CanvasPool()

/** Drops every pooled canvas reference (session teardown alongside engine disposal). */
export function releaseOcrCanvases(): void {
  sharedPool.release()
}

function shrinkToLongEdge(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** Draws one source region at a chosen scale, then runs grayscale + contrast over exactly those
 *  pixels and writes them back. Deterministic by construction. */
function drawPreparedRegion(
  target: BoundedCanvas,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  scale: number,
): void {
  target.element.width = Math.max(1, Math.round(sw * scale))
  target.element.height = Math.max(1, Math.round(sh * scale))
  const context = target.context
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, target.element.width, target.element.height)
  context.drawImage(source, sx, sy, sw, sh, 0, 0, target.element.width, target.element.height)
  const imageData = context.getImageData(0, 0, target.element.width, target.element.height)
  const gray: GrayImage = toGrayscale({
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  })
  const normalized = normalizeContrast(gray)
  const output = context.createImageData(target.element.width, target.element.height)
  for (let i = 0; i < normalized.data.length; i += 1) {
    const value = normalized.data[i] ?? 0
    output.data[i * 4] = value
    output.data[i * 4 + 1] = value
    output.data[i * 4 + 2] = value
    output.data[i * 4 + 3] = 255
  }
  context.putImageData(output, 0, 0)
}

export function cleanSignal(text: string | null, minimumLength: number): string | null {
  if (text === null) return null
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length >= minimumLength ? cleaned : null
}

/**
 * Conservative split of ONE full-card fallback text into (name, collector-number) candidates:
 * scanning from the end, the first token that plausibly IS a printed id (short, contains a
 * digit, not prose) becomes the number candidate and everything before it the name candidate.
 * Pure; exported for tests. Best-effort by design — the matcher still fails closed downstream.
 */
export function splitFullFrameCardText(text: string): {
  name: string | null
  number: string | null
} {
  const tokens = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index] ?? ''
    const letters = token.replace(/[^a-zA-Z]/g, '')
    if (/\d/.test(token) && letters.length <= 3 && token.length <= 10) {
      const nameTokens = tokens.slice(0, index)
      const name = nameTokens.join(' ')
      return {
        name: name.length >= MIN_NAME_TEXT_LENGTH ? name : null,
        number: token.length >= MIN_NUMBER_TEXT_LENGTH ? token : null,
      }
    }
  }
  const joined = tokens.join(' ')
  return { name: joined.length >= MIN_NAME_TEXT_LENGTH ? joined : null, number: null }
}

/**
 * Runs the full OCR pipeline against one capture using the provided engine port. Throws on
 * engine/decode failure (mapped upstream to friendly copy); returns an honest observation even
 * when nothing was read (both fields null).
 */
export async function runOcrAnalysis(
  capture: ScannerCapture,
  engine: OcrEnginePort,
  pool: CanvasPool = sharedPool,
  debug = false,
): Promise<RawOcrObservation> {
  await engine.prepare()
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot analyse images here.')
  }
  const bitmap = await createImageBitmap(capture.blob)
  try {
    const workingSize = shrinkToLongEdge(
      capture.cardRect.width,
      capture.cardRect.height,
      OCR_WORKING_LONG_EDGE,
    )
    const working = pool.take('working', workingSize.width, workingSize.height)
    drawPreparedRegion(
      working,
      bitmap,
      capture.cardRect.left,
      capture.cardRect.top,
      capture.cardRect.width,
      capture.cardRect.height,
      workingSize.width / capture.cardRect.width,
    )

    const cardOnWorking: PixelRect = {
      left: 0,
      top: 0,
      width: working.element.width,
      height: working.element.height,
    }
    const nameRect = roiPixelRect(cardOnWorking, NAME_ROI_FRACTIONS)
    const numberRect = roiPixelRect(cardOnWorking, NUMBER_ROI_FRACTIONS)

    const debugRoiBlobs: { nameRoiBlob: Blob | null; numberRoiBlob: Blob | null } = {
      nameRoiBlob: null,
      numberRoiBlob: null,
    }

    async function readRoi(rect: PixelRect, slot: 'nameRoi' | 'numberRoi'): Promise<string> {
      if (rect.width < 8 || rect.height < 8) return ''
      const upscale = rect.height < ROI_UPSCALE_MIN_HEIGHT_PX ? ROI_UPSCALE_FACTOR : 1
      const roi = pool.take(slot, rect.width * upscale, rect.height * upscale)
      drawPreparedRegion(
        roi,
        working.element,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        upscale,
      )
      const result = await engine.recognize(roi.element, 'single-line')
      // Captured BEFORE the next scan can reuse/resize this pooled canvas (prompt §4/§12
      // debug-only image preview) — never persisted, never sent anywhere but this call's return.
      if (debug) {
        const blob = await canvasToBlob(roi.element).catch(() => null)
        if (slot === 'nameRoi') debugRoiBlobs.nameRoiBlob = blob
        else debugRoiBlobs.numberRoiBlob = blob
      }
      return cleanSignal(result.text, 1) ?? ''
    }

    const nameText = await readRoi(nameRect, 'nameRoi')
    const numberText = await readRoi(numberRect, 'numberRoi')

    const usableName = cleanSignal(nameText, MIN_NAME_TEXT_LENGTH)
    const usableNumber = cleanSignal(numberText, MIN_NUMBER_TEXT_LENGTH)

    if (usableName !== null || usableNumber !== null) {
      return {
        rawNameText: usableName,
        rawCollectorNumberText: usableNumber,
        usedFullFrameFallback: false,
        ...(debug ? { debugImages: debugRoiBlobs } : {}),
      }
    }

    // Both ROIs unusable: exactly ONE bounded full-card pass (prompt §17), auto layout mode.
    const fullResult = await engine.recognize(working.element, 'auto')
    const split = splitFullFrameCardText(fullResult.text)
    return {
      rawNameText: split.name,
      rawCollectorNumberText: split.number,
      usedFullFrameFallback: true,
      ...(debug ? { debugImages: debugRoiBlobs } : {}),
    }
  } finally {
    bitmap.close()
  }
}
