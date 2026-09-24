import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assessImageDimensions,
  decodeImageFile,
  MAX_DECODED_PIXELS,
  MAX_IMAGE_ASPECT_RATIO,
  MAX_IMAGE_EDGE_PX,
  MIN_IMAGE_EDGE_PX,
} from '../../src/features/scanner/capture'
import { sniffImageHeader } from '../../src/features/scanner/image-header'

/**
 * P151 — image input safety. The pixel-bomb protection is only real if a small file that DECLARES a
 * huge image is refused BEFORE the decoder runs, so every bomb case below asserts that
 * `createImageBitmap` was never called. All fixtures are a few dozen bytes of hand-built header —
 * no binary bomb is committed.
 */

// ---------------------------------------------------------------------------------------------
// Tiny hand-built headers
// ---------------------------------------------------------------------------------------------

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
const be32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const be16 = (v: number): number[] => [(v >>> 8) & 255, v & 255]
const le16 = (v: number): number[] => [v & 255, (v >>> 8) & 255]
const le24 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255]
const le32 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]
const text = (s: string): number[] => s.split('').map((c) => c.charCodeAt(0))

function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    text('IHDR'),
    be32(width),
    be32(height),
    [8, 6, 0, 0, 0],
    be32(0),
  )
}

function jpeg(width: number, height: number, options: { exifBytes?: number; sof?: number } = {}) {
  const exif = options.exifBytes ?? 0
  return bytes(
    [0xff, 0xd8],
    exif > 0 ? bytes([0xff, 0xe1], be16(exif + 2), new Uint8Array(exif)) : [],
    [0xff, options.sof ?? 0xc0],
    be16(17),
    [8],
    be16(height),
    be16(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    [0xff, 0xd9],
  )
}

function gif(width: number, height: number): Uint8Array {
  return bytes(text('GIF89a'), le16(width), le16(height), [0, 0, 0], [0x3b])
}

function webpX(width: number, height: number): Uint8Array {
  return bytes(
    text('RIFF'),
    le32(22),
    text('WEBP'),
    text('VP8X'),
    le32(10),
    [0, 0, 0, 0],
    le24(width - 1),
    le24(height - 1),
  )
}

function webpLossless(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14)
  return bytes(
    text('RIFF'),
    le32(22),
    text('WEBP'),
    text('VP8L'),
    le32(5),
    [0x2f],
    [packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, (packed >>> 24) & 0x0f],
    [0, 0, 0, 0, 0],
  )
}

function webpLossy(width: number, height: number): Uint8Array {
  return bytes(
    text('RIFF'),
    le32(30),
    text('WEBP'),
    text('VP8 '),
    le32(10),
    [0, 0, 0],
    [0x9d, 0x01, 0x2a],
    le16(width),
    le16(height),
  )
}

function bmp(width: number, height: number): Uint8Array {
  return bytes(
    text('BM'),
    [0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0],
    le32(40),
    le32(width),
    le32(height >>> 0),
    [1, 0, 24, 0],
    new Uint8Array(24),
  )
}

function fileOf(data: Uint8Array | string, type: string, name = 'card'): File {
  return new File([data as BlobPart], name, { type })
}

// ---------------------------------------------------------------------------------------------
// Fake browser surface: createImageBitmap + canvas
// ---------------------------------------------------------------------------------------------

interface FakeCanvas {
  width: number
  height: number
  getContext: () => { drawImage: () => void }
  toBlob: (cb: (blob: Blob | null) => void) => void
}

let createImageBitmapStub: ReturnType<typeof vi.fn>
let canvases: FakeCanvas[]
let bitmapCloses: ReturnType<typeof vi.fn>[]
let decodedDimensions: { width: number; height: number }
let encodeReturnsNull = false

beforeEach(() => {
  canvases = []
  bitmapCloses = []
  decodedDimensions = { width: 500, height: 700 }
  encodeReturnsNull = false
  createImageBitmapStub = vi.fn(() => {
    const close = vi.fn()
    bitmapCloses.push(close)
    return Promise.resolve({ ...decodedDimensions, close })
  })
  Object.defineProperty(globalThis, 'createImageBitmap', {
    value: createImageBitmapStub,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'document', {
    value: {
      createElement: () => {
        const canvas: FakeCanvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toBlob: (cb) => {
            cb(encodeReturnsNull ? null : new Blob(['jpeg']))
          },
        }
        canvases.push(canvas)
        return canvas
      },
    },
    configurable: true,
  })
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).createImageBitmap
  delete (globalThis as Record<string, unknown>).document
})

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

// ---------------------------------------------------------------------------------------------

describe('P151 — header sniffing reads declared dimensions without a decoder', () => {
  it('reads PNG, JPEG (behind large EXIF, baseline and progressive), GIF, WebP (all 3 kinds) and BMP', () => {
    expect(sniffImageHeader(png(3024, 4032))).toEqual({ format: 'png', width: 3024, height: 4032 })
    expect(sniffImageHeader(jpeg(3024, 4032))).toEqual({
      format: 'jpeg',
      width: 3024,
      height: 4032,
    })
    expect(sniffImageHeader(jpeg(1234, 987, { exifBytes: 60_000 }))).toMatchObject({
      width: 1234,
      height: 987,
    })
    expect(sniffImageHeader(jpeg(800, 600, { sof: 0xc2 }))).toMatchObject({
      width: 800,
      height: 600,
    })
    expect(sniffImageHeader(gif(640, 480))).toEqual({ format: 'gif', width: 640, height: 480 })
    expect(sniffImageHeader(webpX(4000, 3000))).toEqual({
      format: 'webp',
      width: 4000,
      height: 3000,
    })
    expect(sniffImageHeader(webpLossless(1000, 1400))).toEqual({
      format: 'webp',
      width: 1000,
      height: 1400,
    })
    expect(sniffImageHeader(webpLossy(500, 700))).toEqual({
      format: 'webp',
      width: 500,
      height: 700,
    })
    expect(sniffImageHeader(bmp(320, 240))).toEqual({ format: 'bmp', width: 320, height: 240 })
  })

  it('returns null (cannot pre-check) for unknown, truncated or malformed data — never throws', () => {
    expect(sniffImageHeader(new Uint8Array())).toBeNull()
    expect(sniffImageHeader(png(10, 10).slice(0, 12))).toBeNull()
    expect(sniffImageHeader(jpeg(10, 10).slice(0, 6))).toBeNull()
    expect(sniffImageHeader(bytes([0xff, 0xd8, 0x00, 0x00, 0x00]))).toBeNull()
    expect(sniffImageHeader(bytes(text('ftypheic'), new Uint8Array(40)))).toBeNull()
    expect(sniffImageHeader(bytes(text('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBeNull()
  })

  it('20,000 random byte strings (and mutated valid headers) never throw and only ever yield finite non-negative integers', () => {
    let seed = 0x151
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const valid = [png(300, 400), jpeg(300, 400), gif(300, 400), webpX(300, 400), bmp(300, 400)]
    for (let i = 0; i < 20_000; i += 1) {
      const sample =
        i % 2 === 0
          ? Uint8Array.from({ length: Math.floor(random() * 96) }, () => Math.floor(random() * 256))
          : Uint8Array.from(valid[i % valid.length] ?? [], (byte) =>
              random() < 0.08 ? Math.floor(random() * 256) : byte,
            )
      const header = sniffImageHeader(sample)
      if (header !== null) {
        expect(Number.isInteger(header.width) && header.width >= 0).toBe(true)
        expect(Number.isInteger(header.height) && header.height >= 0).toBe(true)
      }
    }
  })
})

describe('P151 — dimension policy', () => {
  it('accepts ordinary photos and refuses each class of unreasonable dimensions', () => {
    expect(assessImageDimensions(3024, 4032)).toBe('ok') // 12 MP phone portrait
    expect(assessImageDimensions(8064, 6048)).toBe('too-large') // 48.8 MP > 40 MP ceiling
    expect(assessImageDimensions(6000, 6000)).toBe('ok') // 36 MP, within the ceiling
    expect(assessImageDimensions(MAX_IMAGE_EDGE_PX + 1, 100)).toBe('too-large')
    expect(assessImageDimensions(60_000, 60_000)).toBe('too-large')
    expect(assessImageDimensions(0, 500)).toBe('empty')
    expect(assessImageDimensions(500, 0)).toBe('empty')
    expect(assessImageDimensions(Number.NaN, 500)).toBe('empty')
    expect(assessImageDimensions(Number.POSITIVE_INFINITY, 500)).toBe('empty')
    expect(assessImageDimensions(MIN_IMAGE_EDGE_PX - 1, 500)).toBe('too-small')
    expect(assessImageDimensions(10_000, 100)).toBe('extreme-ratio')
    expect(assessImageDimensions(MAX_IMAGE_ASPECT_RATIO * 200, 200)).toBe('ok')
    expect(assessImageDimensions(MAX_IMAGE_ASPECT_RATIO * 200 + 1, 200)).toBe('extreme-ratio')
    expect(MAX_DECODED_PIXELS).toBe(40 * 1024 * 1024)
  })
})

describe('P151 — decodeImageFile refuses pixel bombs BEFORE decoding', () => {
  const bombs: [string, Uint8Array, string][] = [
    ['PNG 60000x60000', png(60_000, 60_000), 'image/png'],
    ['PNG 4294967295x4294967295', png(0xffffffff, 0xffffffff), 'image/png'],
    ['JPEG 65535x65535', jpeg(65_535, 65_535), 'image/jpeg'],
    [
      'JPEG 30000x2000 behind 300 KB of EXIF',
      jpeg(30_000, 2_000, { exifBytes: 60_000 }),
      'image/jpeg',
    ],
    ['GIF 65535x65535', gif(65_535, 65_535), 'image/gif'],
    ['WebP VP8X 16777216x16777216', webpX(16_777_216, 16_777_216), 'image/webp'],
    ['WebP lossless 16384x16384', webpLossless(16_384, 16_384), 'image/webp'],
    ['BMP 50000x50000', bmp(50_000, 50_000), 'image/bmp'],
  ]

  for (const [label, data, type] of bombs) {
    it(`${label}: rejected as too large with the decoder never invoked`, async () => {
      const error = await rejection(decodeImageFile(fileOf(data, type)))
      expect(error.name).toBe('ScannerFileTooLargeError')
      expect(createImageBitmapStub).not.toHaveBeenCalled()
      expect(canvases).toHaveLength(0)
    })
  }

  it('a 10000x100 strip (within the pixel ceiling, absurd shape) is refused pre-decode', async () => {
    const error = await rejection(decodeImageFile(fileOf(png(10_000, 100), 'image/png')))
    expect(error.name).toBe('ScannerDecodeError')
    expect(createImageBitmapStub).not.toHaveBeenCalled()
  })

  it('zero and tiny declared dimensions are refused pre-decode', async () => {
    for (const data of [png(0, 500), png(500, 0), png(8, 8), gif(0, 0)]) {
      const error = await rejection(decodeImageFile(fileOf(data, 'image/png')))
      expect(error.name).toBe('ScannerDecodeError')
    }
    expect(createImageBitmapStub).not.toHaveBeenCalled()
  })

  it('the bomb is judged on its BYTES, not its MIME type or file name', async () => {
    const error = await rejection(
      decodeImageFile(fileOf(png(60_000, 60_000), 'image/jpeg', 'x.jpg')),
    )
    expect(error.name).toBe('ScannerFileTooLargeError')
    expect(createImageBitmapStub).not.toHaveBeenCalled()
  })
})

describe('P151 — other hostile or degenerate inputs never yield a frame and never poison the next scan', () => {
  it('empty file, non-image MIME and SVG are refused without a decode', async () => {
    for (const file of [
      fileOf(new Uint8Array(), 'image/png'),
      fileOf('hello', 'text/plain'),
      fileOf(
        '<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"/>',
        'image/svg+xml',
      ),
    ]) {
      const error = await rejection(decodeImageFile(file))
      expect(error.name).toBe('ScannerDecodeError')
    }
    expect(createImageBitmapStub).not.toHaveBeenCalled()
  })

  it('misleading MIME (image/png over random bytes) reaches the decoder, whose failure is reported as a decode error', async () => {
    createImageBitmapStub.mockRejectedValueOnce(new Error('EncodingError'))
    const error = await rejection(
      decodeImageFile(
        fileOf(
          Uint8Array.from({ length: 200 }, (_, i) => (i * 37) & 255),
          'image/png',
        ),
      ),
    )
    expect(error.name).toBe('ScannerDecodeError')
    expect(bitmapCloses).toHaveLength(0)
  })

  it('a truncated header is not pre-checkable and falls through to the decoder', async () => {
    createImageBitmapStub.mockRejectedValueOnce(new Error('truncated'))
    const error = await rejection(decodeImageFile(fileOf(png(500, 700).slice(0, 14), 'image/png')))
    expect(error.name).toBe('ScannerDecodeError')
    expect(createImageBitmapStub).toHaveBeenCalledTimes(1)
  })

  it('a format the sniffer cannot read (HEIC) that DECODES to a bomb is caught post-decode and its bitmap closed exactly once', async () => {
    decodedDimensions = { width: 30_000, height: 30_000 }
    const heic = fileOf(bytes(text('\0\0\0\x18ftypheic'), new Uint8Array(64)), 'image/heic')
    const error = await rejection(decodeImageFile(heic))
    expect(error.name).toBe('ScannerFileTooLargeError')
    expect(bitmapCloses).toHaveLength(1)
    expect(bitmapCloses[0]).toHaveBeenCalledTimes(1)
    expect(canvases).toHaveLength(0)
  })

  it('a decode that reports zero dimensions is refused and its bitmap closed', async () => {
    decodedDimensions = { width: 0, height: 0 }
    const error = await rejection(decodeImageFile(fileOf(png(500, 700), 'image/png')))
    expect(error.name).toBe('ScannerDecodeError')
    expect(bitmapCloses[0]).toHaveBeenCalledTimes(1)
  })

  it('an encode failure closes the bitmap AND releases the canvas backing store', async () => {
    encodeReturnsNull = true
    await rejection(decodeImageFile(fileOf(png(500, 700), 'image/png')))
    expect(bitmapCloses[0]).toHaveBeenCalledTimes(1)
    expect(canvases).toHaveLength(1)
    expect(canvases[0]?.width).toBe(0)
    expect(canvases[0]?.height).toBe(0)
  })
})

describe('P151 — a valid file after any failure still scans', () => {
  it('returns a bounded frame, closes the bitmap once and zeroes the canvas', async () => {
    const frame = await decodeImageFile(fileOf(png(500, 700), 'image/png'))
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.height).toBeGreaterThan(0)
    expect(frame.cardRect).toEqual({ left: 0, top: 0, width: frame.width, height: frame.height })
    expect(bitmapCloses).toHaveLength(1)
    expect(bitmapCloses[0]).toHaveBeenCalledTimes(1)
    expect(canvases).toHaveLength(1)
    expect(canvases[0]?.width).toBe(0)
  })

  it('60 mixed hostile/valid files in a row: exactly the valid ones succeed, no bitmap or canvas is left open', async () => {
    const hostile = [
      () => fileOf(png(60_000, 60_000), 'image/png'),
      () => fileOf(new Uint8Array(), 'image/png'),
      () => fileOf(jpeg(30_000, 30_000), 'image/jpeg'),
      () => fileOf('x', 'text/plain'),
      () => fileOf(png(10_000, 100), 'image/png'),
    ]
    let valid = 0
    let refused = 0
    for (let i = 0; i < 60; i += 1) {
      const makeFile = hostile[i % hostile.length]
      if (i % 3 === 2) {
        await decodeImageFile(fileOf(png(500, 700), 'image/png'))
        valid += 1
      } else if (makeFile !== undefined) {
        await rejection(decodeImageFile(makeFile()))
        refused += 1
      }
    }
    expect(valid).toBe(20)
    expect(refused).toBe(40)
    // Decoder was invoked only for the valid files, each bitmap closed once, each canvas zeroed.
    expect(createImageBitmapStub).toHaveBeenCalledTimes(20)
    for (const close of bitmapCloses) expect(close).toHaveBeenCalledTimes(1)
    for (const canvas of canvases) expect(canvas.width).toBe(0)
  })
})
