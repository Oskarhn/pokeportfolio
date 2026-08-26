import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_MAX_LONG_EDGE,
  CaptureStore,
  computeBoundedDimensions,
  captureVideoFrame,
  decodeImageFile,
  MAX_INPUT_FILE_BYTES,
} from '../../src/features/scanner/capture'

/**
 * Capture memory ownership (prompt §10/§11/§28) in a plain Node environment: the pure bounding
 * math, the single-owner object-URL lifecycle of CaptureStore, and the file-fallback guards that
 * run BEFORE any decode is attempted. The canvas-drawing internals themselves need a real
 * browser; everything decidable without one is pinned here.
 */

let createObjectURL: ReturnType<typeof vi.fn<() => string>>
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>

beforeEach(() => {
  let urlCounter = 0
  createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`)
  revokeObjectURL = vi.fn()
  // Node's URL has neither method; patch rather than replace so unrelated runner use keeps working.
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
})

afterEach(() => {
  const hadCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  if (hadCreate?.configurable) delete (URL as unknown as Record<string, unknown>).createObjectURL
  const hadRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  if (hadRevoke?.configurable) delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

function frame(width: number, height: number) {
  return {
    blob: new Blob(['synthetic'], { type: 'image/jpeg' }),
    width,
    height,
    cardRect: { left: 0, top: 0, width, height },
  }
}

describe('bounded capture dimensions', () => {
  it('shrinks a large landscape photo to the long-edge bound, preserving aspect', () => {
    expect(computeBoundedDimensions(4000, 3000)).toEqual({ width: 1800, height: 1350 })
  })

  it('shrinks a large portrait photo equally — iPhone main-camera shape', () => {
    expect(computeBoundedDimensions(3024, 4032)).toEqual({ width: 1350, height: 1800 })
  })

  it('NEVER upscales a small source and never changes an already-bounded one', () => {
    expect(computeBoundedDimensions(500, 400)).toEqual({ width: 500, height: 400 })
    expect(computeBoundedDimensions(1600, 1200)).toEqual({ width: 1600, height: 1200 })
    expect(CAPTURE_MAX_LONG_EDGE).toBeGreaterThanOrEqual(1600)
    expect(CAPTURE_MAX_LONG_EDGE).toBeLessThanOrEqual(2000)
  })

  it('a square source bounds by the shared long edge', () => {
    expect(computeBoundedDimensions(3600, 3600)).toEqual({ width: 1800, height: 1800 })
  })

  it('refuses dimension-less sources instead of producing a zero frame', () => {
    expect(() => computeBoundedDimensions(0, 100)).toThrow()
    expect(() => computeBoundedDimensions(Number.NaN, 100)).toThrow()
  })

  it('a custom bound is honoured (P65/P68 may refine the constant)', () => {
    expect(computeBoundedDimensions(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 })
  })
})

describe('CaptureStore — single owner of the captured image memory', () => {
  it('set() creates exactly one preview URL for the current frame', () => {
    const store = new CaptureStore()
    store.set(frame(100, 140))
    const stored = store.get()
    expect(stored?.width).toBe(100)
    expect(stored?.previewUrl).toBe('blob:mock-1')
    expect(createObjectURL).toHaveBeenCalledOnce()
    store.clear()
  })

  it('replacing the capture revokes the previous URL — no leak per retake', () => {
    const store = new CaptureStore()
    store.set(frame(100, 140))
    store.set(frame(120, 168))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(store.get()?.previewUrl).toBe('blob:mock-2')
    store.clear()
  })

  it('clear() revokes the live URL and leaves nothing behind; double-clear is safe', () => {
    const store = new CaptureStore()
    store.set(frame(100, 140))
    store.clear()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(store.get()).toBeNull()
    store.clear()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('clearing an empty store touches no URLs at all', () => {
    const store = new CaptureStore()
    store.clear()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })
})

describe('file fallback guards', () => {
  it('rejects obvious non-images by MIME type before any decode attempt', async () => {
    const notAnImage = new File(['%PDF-1.7'], 'card.pdf', { type: 'application/pdf' })
    await expect(decodeImageFile(notAnImage)).rejects.toMatchObject({
      name: 'ScannerDecodeError',
    })
  })

  it('rejects unreasonable input sizes before any decode attempt', async () => {
    const oversized = new File([new ArrayBuffer(MAX_INPUT_FILE_BYTES + 1)], 'huge.jpg', {
      type: 'image/jpeg',
    })
    await expect(decodeImageFile(oversized)).rejects.toMatchObject({
      name: 'ScannerFileTooLargeError',
    })
  })

  it('an acceptable image proceeds past the guards and fails honestly where decode does not exist', async () => {
    // Node has no createImageBitmap — which is exactly this environment's honest answer.
    const acceptable = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'card.jpg', {
      type: 'image/jpeg',
    })
    await expect(decodeImageFile(acceptable)).rejects.toMatchObject({
      name: 'ScannerDecodeError',
    })
  })
})

describe('video frame guard', () => {
  it('refuses to capture before the preview has pixels rather than producing a black card', async () => {
    const empty = { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement
    await expect(captureVideoFrame(empty)).rejects.toThrow(/not ready/)
  })
})
