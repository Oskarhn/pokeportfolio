/**
 * In-memory capture pipeline (prompt §10/§11/§28). A captured frame is a bounded JPEG blob plus
 * its pixel dimensions — it is never uploaded, persisted or put in localStorage anywhere in this
 * feature. {@link CaptureStore} is the single owner of the "current capture": at most one live
 * object URL exists at a time, and every replacement or clear revokes the previous one, so the
 * page component cannot leak blob URLs by forgetting.
 */

/** UI-owned upper bound on the long edge of a captured/decoded still. Chosen inside the
 *  suggested 1600–2000 px band: large enough that P68's OCR keeps detail to work with, small
 *  enough that a fast burst of captures stays cheap on an iPhone. Never upscales a smaller
 *  source — scaling only ever shrinks. */
export const CAPTURE_MAX_LONG_EDGE = 1800

export const CAPTURE_JPEG_QUALITY = 0.92

/** Refusal bound for files picked through the fallback input — generous for a phone photo,
 *  tight enough that a pathological pick cannot stall the flow before decode even starts. */
export const MAX_INPUT_FILE_BYTES = 25 * 1024 * 1024

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
}

function drawToBoundedCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): HTMLCanvasElement {
  const { width, height } = computeBoundedDimensions(sourceWidth, sourceHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Canvas 2D context is unavailable in this browser.')
  context.drawImage(source, 0, 0, width, height)
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

/** Grabs the current video frame as a bounded JPEG. Throws while the preview has no pixels yet
 *  (e.g. tapped before the first frame rendered) rather than producing a black card photo. */
export async function captureVideoFrame(video: HTMLVideoElement): Promise<CapturedFrame> {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error('The camera preview is not ready yet.')
  }
  const canvas = drawToBoundedCanvas(video, video.videoWidth, video.videoHeight)
  const blob = await canvasToJpeg(canvas)
  return { blob, width: canvas.width, height: canvas.height }
}

/**
 * Decodes a picked image file into the same bounded JPEG shape. Guards run before any decode:
 * obvious non-images are rejected by MIME type and unreasonable inputs by size. Decoding goes
 * through createImageBitmap where available (all iOS ≥15); the ImageBitmap is closed again
 * immediately after drawing so its full-size backing store is released right away.
 */
export async function decodeImageFile(file: File): Promise<CapturedFrame> {
  if (!file.type.startsWith('image/')) {
    throw scannerError('ScannerDecodeError', 'That file is not an image.')
  }
  if (file.size > MAX_INPUT_FILE_BYTES) {
    throw scannerError('ScannerFileTooLargeError', 'That image is too large.')
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
    const canvas = drawToBoundedCanvas(bitmap, bitmap.width, bitmap.height)
    const blob = await canvasToJpeg(canvas)
    return { blob, width: canvas.width, height: canvas.height }
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
