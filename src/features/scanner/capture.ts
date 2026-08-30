/**
 * In-memory capture pipeline (prompt §10/§11/§28). A captured frame is a bounded JPEG blob plus
 * its pixel dimensions and the pixel rectangle of the physical card inside it — it is never
 * uploaded, persisted or put in localStorage anywhere in this feature. {@link CaptureStore} is
 * the single owner of the "current capture": at most one live object URL exists at a time, and
 * every replacement or clear revokes the previous one, so the page component cannot leak blob
 * URLs by forgetting.
 *
 * Card geometry (prompt §10): every frame carries a trustworthy source `cardRect` so OCR reads
 * the physical card, never the whole camera frame. Camera captures keep the full shot for user
 * review and carry the mapped guide rectangle; picked files are cropped AT DECODE to the
 * deterministic policy rect (guide-geometry.decideFileCardRect), so the reviewed preview is
 * exactly the pixels recognition sees.
 */

import {
  cardRectFromVideo,
  decideFileCardRect,
  scaleCardRect,
  type PixelRect,
} from './guide-geometry'

/** UI-owned upper bound on the long edge of a captured/decoded still. Chosen inside the
 *  suggested 1600–2000 px band: large enough that OCR keeps detail to work with, small enough
 *  that a fast burst of captures stays cheap on an iPhone. Never upscales a smaller source —
 *  scaling only ever shrinks. */
export const CAPTURE_MAX_LONG_EDGE = 1800

export const CAPTURE_JPEG_QUALITY = 0.92

/** Refusal bound for files picked through the fallback input (prompt §13): 10 MB before decode —
 *  conservative against decompression-bomb inputs while accepting any realistic phone photo.
 *  Camera-generated scanner JPEGs are bounded by construction (CAPTURE_MAX_LONG_EDGE). */
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024

/** Hard ceiling on any decoded image's total pixels entering the pipeline (prompt §13) — the
 *  decompression-bomb guard. Generous enough for any realistic phone photo (a 12 MP shot is
 *  ~12 M px); a pathological file beyond it is refused before any canvas draw. Edge length is
 *  separately bounded by the capture path itself: everything drawn lands at ≤
 *  CAPTURE_MAX_LONG_EDGE. */
export const MAX_DECODED_PIXELS = 40 * 1024 * 1024

/** Proportionally shrink (width, height) so the long edge is at most maxLongEdge; never upscale;
 *  never return zero. Pure so the bounding rule stays pinned by test independent of canvas code. */
export function computeBoundedDimensions(
  width: number,
  height: number,
  maxLongEdge = CAPTURE_MAX_LONG_EDGE,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Capture source has no usable dimensions.')
  }
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) return { width: Math.round(width), height: Math.round(height) }
  const scale = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface CapturedFrame {
  blob: Blob
  width: number
  height: number
  /** Physical-card rectangle in this frame's pixel space. Always present — recognition must
   *  never guess geometry. For decoded files the whole stored frame IS the card crop, so the
   *  rect covers everything. */
  cardRect: PixelRect
}

function drawToBoundedCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  crop?: PixelRect,
): HTMLCanvasElement {
  const region = crop ?? { left: 0, top: 0, width: sourceWidth, height: sourceHeight }
  const { width, height } = computeBoundedDimensions(region.width, region.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Canvas 2D context is unavailable in this browser.')
  context.drawImage(
    source,
    region.left,
    region.top,
    region.width,
    region.height,
    0,
    0,
    width,
    height,
  )
  return canvas
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('The captured frame could not be encoded.'))
          return
        }
        resolve(blob)
      },
      'image/jpeg',
      CAPTURE_JPEG_QUALITY,
    )
  })
}

/** Grabs the current video frame as a bounded JPEG together with the guide-derived card
 *  rectangle. Throws while the preview has no pixels yet (e.g. tapped before the first frame
 *  rendered) rather than producing a black card photo. */
export async function captureVideoFrame(video: HTMLVideoElement): Promise<CapturedFrame> {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error('The camera preview is not ready yet.')
  }
  const elementWidth = video.clientWidth
  const elementHeight = video.clientHeight
  if (elementWidth === 0 || elementHeight === 0) {
    throw new Error('The camera preview has no layout yet.')
  }
  // The shared geometry model maps the rendered 5:7 guide through object-fit: cover into
  // intrinsic video pixels — the same rectangle the user aligned on screen.
  const sourceCardRect = cardRectFromVideo(
    video.videoWidth,
    video.videoHeight,
    elementWidth,
    elementHeight,
  )
  const canvas = drawToBoundedCanvas(video, video.videoWidth, video.videoHeight)
  const cardRect = scaleCardRect(
    sourceCardRect,
    canvas.width / video.videoWidth,
    canvas.height / video.videoHeight,
  )
  const blob = await canvasToJpeg(canvas)
  return { blob, width: canvas.width, height: canvas.height, cardRect }
}

/**
 * Decodes a picked image file into a bounded JPEG cropped to the deterministic card rect.
 * Guards run before any decode: obvious non-images are rejected by MIME type and unreasonable
 * inputs by size. Decoding goes through createImageBitmap where available (all iOS ≥15); the
 * ImageBitmap is closed again immediately after drawing so its full-size backing store is
 * released right away, and oversized decodes are refused before any draw.
 */
export async function decodeImageFile(file: File): Promise<CapturedFrame> {
  if (!file.type.startsWith('image/')) {
    throw scannerError('ScannerDecodeError', 'That file is not an image.')
  }
  if (file.size > MAX_INPUT_FILE_BYTES) {
    throw scannerError('ScannerFileTooLargeError', 'That image is larger than 10 MB.')
  }
  if (typeof createImageBitmap !== 'function') {
    // Same friendly class as a decode failure: the file is fine, this browser just cannot read it.
    throw scannerError('ScannerDecodeError', 'This browser cannot decode images here.')
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw scannerError('ScannerDecodeError', 'That image could not be decoded.')
  }
  try {
    if (
      bitmap.width === 0 ||
      bitmap.height === 0 ||
      bitmap.width * bitmap.height > MAX_DECODED_PIXELS
    ) {
      throw scannerError('ScannerFileTooLargeError', 'That image is too large to process here.')
    }
    // Deterministic file policy: whole image when it already has the card's shape, otherwise a
    // conservative centred card crop. The stored frame IS the crop, so review shows exactly what
    // recognition will read and no background pixels ever reach OCR.
    const cardRect = decideFileCardRect(bitmap.width, bitmap.height)
    const canvas = drawToBoundedCanvas(bitmap, bitmap.width, bitmap.height, cardRect)
    const blob = await canvasToJpeg(canvas)
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      cardRect: { left: 0, top: 0, width: canvas.width, height: canvas.height },
    }
  } finally {
    bitmap.close()
  }
}

function scannerError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

interface StoredCapture extends CapturedFrame {
  previewUrl: string
}

/**
 * Single owner of the current capture's memory (prompt §28). Exactly one object URL is alive at
 * a time; `set` releases the previous capture, `clear` releases the current one, and both are
 * safe to call when nothing is held. Batch items never receive any part of a stored capture —
 * confirmation clears the store before anything else happens.
 */
export class CaptureStore {
  private current: StoredCapture | null = null

  /** Stores the frame (revoking any previous capture) and returns what is now held, so callers
   *  can render its previewUrl from state instead of reading the store during render. */
  set(frame: CapturedFrame): StoredCapture {
    this.releaseCurrent()
    const previewUrl = URL.createObjectURL(frame.blob)
    this.current = { ...frame, previewUrl }
    return this.current
  }

  get(): StoredCapture | null {
    return this.current
  }

  clear(): void {
    this.releaseCurrent()
  }

  private releaseCurrent(): void {
    if (this.current === null) return
    URL.revokeObjectURL(this.current.previewUrl)
    this.current = null
  }
}
