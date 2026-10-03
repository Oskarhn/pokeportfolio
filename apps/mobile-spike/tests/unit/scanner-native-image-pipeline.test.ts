import {
  readJpegExifOrientation,
  orientationSwapsDimensions,
} from '../../src/features/scanner-native/exif-orientation'

// image-decode.ts require()s these specific Skia source files (headless-only, see its own module
// doc) for its (untested-here) decode function; only the pure `applyOrientationTransform` export
// is exercised below, which never touches Skia at runtime. Mocked wholesale so Jest never tries to
// transform these raw-TypeScript third-party source files (outside this project's transform config).
jest.mock('@shopify/react-native-skia/src/skia/NativeSetup', () => ({}))
jest.mock('@shopify/react-native-skia/src/skia/Skia', () => ({ Skia: {} }))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ImageFactory', () => ({
  AlphaType: { Unpremul: 3 },
}))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ColorType', () => ({
  ColorType: { RGBA_8888: 4 },
}))
import { applyOrientationTransform } from '../../src/features/scanner-native/image-decode'
import {
  checkFileSize,
  checkDecodedDimensions,
  MAX_INPUT_FILE_BYTES,
  MAX_DECODED_PIXELS,
  MIN_INPUT_EDGE_PX,
  MAX_INPUT_LONG_EDGE_PX,
  MAX_ASPECT_RATIO,
} from '../../src/features/scanner-native/image-safety'

/** Builds a minimal JPEG with an APP1/Exif segment carrying the given orientation tag value, and
 *  nothing else meaningful — enough for `readJpegExifOrientation` to find tag 0x0112 in IFD0. */
function jpegWithExifOrientation(orientation: number): Uint8Array {
  const tiffHeader = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08] // big-endian, IFD0 @ offset 8
  const ifd0 = [
    0x00,
    0x01, // 1 entry
    0x01,
    0x12, // tag 0x0112 (Orientation)
    0x00,
    0x03, // type SHORT
    0x00,
    0x00,
    0x00,
    0x01, // count 1
    0x00,
    orientation, // value (SHORT, big-endian, first 2 bytes used)
    0x00,
    0x00,
    0x00,
    0x00, // next IFD offset = 0
  ]
  const exifBlock = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiffHeader, ...ifd0] // "Exif\0\0" + TIFF
  const app1Length = exifBlock.length + 2
  const app1 = [0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff, ...exifBlock]
  return new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9])
}

describe('readJpegExifOrientation', () => {
  it('reads a real orientation tag out of a well-formed Exif segment', () => {
    expect(readJpegExifOrientation(jpegWithExifOrientation(6))).toBe(6)
    expect(readJpegExifOrientation(jpegWithExifOrientation(3))).toBe(3)
    expect(readJpegExifOrientation(jpegWithExifOrientation(1))).toBe(1)
  })

  it('returns 1 (normal) for a non-JPEG, a JPEG with no Exif segment, and truncated/garbage bytes', () => {
    expect(readJpegExifOrientation(new Uint8Array([0x00, 0x01, 0x02]))).toBe(1)
    expect(readJpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(1)
    for (let i = 0; i < 50; i += 1) {
      const junk = new Uint8Array(20)
      for (let b = 0; b < junk.length; b += 1) junk[b] = Math.floor(Math.random() * 256)
      expect(() => readJpegExifOrientation(junk)).not.toThrow()
    }
  })
})

describe('orientationSwapsDimensions', () => {
  it('is true only for the four 90/270-degree orientations (5,6,7,8)', () => {
    const noSwap: readonly (1 | 2 | 3 | 4)[] = [1, 2, 3, 4]
    const swap: readonly (5 | 6 | 7 | 8)[] = [5, 6, 7, 8]
    expect(noSwap.map(orientationSwapsDimensions)).toEqual([false, false, false, false])
    expect(swap.map(orientationSwapsDimensions)).toEqual([true, true, true, true])
  })
})

describe('applyOrientationTransform', () => {
  function fakeCanvas() {
    const calls: string[] = []
    return {
      calls,
      canvas: {
        translate: (x: number, y: number) => calls.push(`translate(${x},${y})`),
        rotate: (deg: number, x: number, y: number) => calls.push(`rotate(${deg},${x},${y})`),
        scale: (x: number, y: number) => calls.push(`scale(${x},${y})`),
      },
    }
  }

  it('issues no transform for orientation 1 (normal)', () => {
    const { canvas, calls } = fakeCanvas()
    applyOrientationTransform(canvas, 1, 100, 200)
    expect(calls).toEqual([])
  })

  it('rotates 90 CW into a swapped canvas for orientation 6 (the common phone-camera case)', () => {
    const { canvas, calls } = fakeCanvas()
    applyOrientationTransform(canvas, 6, 100, 200)
    expect(calls).toEqual(['translate(100,0)', 'rotate(90,0,0)'])
  })

  it('every orientation from 1 to 8 produces SOME deterministic, non-throwing transform', () => {
    for (let o = 1; o <= 8; o += 1) {
      const { canvas, calls } = fakeCanvas()
      expect(() =>
        applyOrientationTransform(canvas, o as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, 100, 200),
      ).not.toThrow()
      // Re-applying the same orientation against a fresh canvas produces the identical call
      // sequence — the transform is a pure function of (orientation, outW, outH).
      const { canvas: canvas2, calls: calls2 } = fakeCanvas()
      applyOrientationTransform(canvas2, o as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, 100, 200)
      expect(calls2).toEqual(calls)
    }
  })
})

describe('image-safety bounds', () => {
  it('accepts a normal photo-sized file and rejects one over the byte ceiling', () => {
    expect(checkFileSize(1_000_000)).toEqual({ ok: true })
    expect(checkFileSize(MAX_INPUT_FILE_BYTES)).toEqual({ ok: true })
    expect(checkFileSize(MAX_INPUT_FILE_BYTES + 1)).toEqual({
      ok: false,
      reason: 'file-too-large',
      bytes: MAX_INPUT_FILE_BYTES + 1,
    })
  })

  it('accepts a normal photo resolution', () => {
    expect(checkDecodedDimensions(1200, 1600)).toEqual({ ok: true })
  })

  it('rejects zero, too-small, too-large-edge, pixel-bomb and extreme-aspect-ratio images', () => {
    expect(checkDecodedDimensions(0, 100)).toEqual({ ok: false, reason: 'zero-dimension' })
    expect(checkDecodedDimensions(MIN_INPUT_EDGE_PX - 1, 1000)).toMatchObject({
      ok: false,
      reason: 'too-small',
    })
    expect(checkDecodedDimensions(MAX_INPUT_LONG_EDGE_PX + 1, 1000)).toMatchObject({
      ok: false,
      reason: 'too-large',
    })
    // A tall/wide-but-within-edge-limits image whose PRODUCT still exceeds the pixel ceiling.
    const side = Math.ceil(Math.sqrt(MAX_DECODED_PIXELS)) + 1
    if (side <= MAX_INPUT_LONG_EDGE_PX) {
      expect(checkDecodedDimensions(side, side)).toMatchObject({
        ok: false,
        reason: 'decoded-pixels-exceeded',
      })
    }
    expect(checkDecodedDimensions(100, 100 * MAX_ASPECT_RATIO + 1)).toMatchObject({
      ok: false,
      reason: 'extreme-aspect-ratio',
    })
  })
})
