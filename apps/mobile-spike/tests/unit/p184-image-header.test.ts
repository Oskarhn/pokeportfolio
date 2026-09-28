import { sniffImageHeader } from '../../src/features/scanner-native/image-header'
import { shouldResumeRecognition } from '../../src/features/price-check/recognition-lifecycle'

const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]

function jpegWith(sof: number, width: number, height: number, precedingSegments: number[][] = []) {
  return new Uint8Array([
    0xff,
    0xd8,
    ...precedingSegments.flat(),
    0xff,
    sof,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])
}

describe('sniffImageHeader', () => {
  it('reads baseline and progressive JPEG frame headers', () => {
    expect(sniffImageHeader(jpegWith(0xc0, 1200, 1600))).toEqual({
      format: 'jpeg',
      width: 1200,
      height: 1600,
    })
    expect(sniffImageHeader(jpegWith(0xc2, 4000, 3000))).toEqual({
      format: 'jpeg',
      width: 4000,
      height: 3000,
    })
  })

  it('skips APP/DQT/DHT segments that precede the frame header (EXIF, thumbnails)', () => {
    const app1 = [0xff, 0xe1, ...be16(10), 0, 0, 0, 0, 0, 0, 0, 0]
    const dht = [0xff, 0xc4, ...be16(6), 0, 0, 0, 0]
    expect(sniffImageHeader(jpegWith(0xc0, 640, 480, [app1, dht]))).toEqual({
      format: 'jpeg',
      width: 640,
      height: 480,
    })
  })

  it('does not mistake DHT (C4), JPG (C8) or DAC (CC) markers for a frame header', () => {
    for (const marker of [0xc4, 0xc8, 0xcc]) {
      expect(sniffImageHeader(jpegWith(marker, 100, 100))).toBeNull()
    }
  })

  it('reads a PNG IHDR', () => {
    const png = new Uint8Array(33)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(png.buffer).setUint32(16, 3024)
    new DataView(png.buffer).setUint32(20, 4032)
    expect(sniffImageHeader(png)).toEqual({ format: 'png', width: 3024, height: 4032 })
  })

  it('reads WebP lossy (VP8), lossless (VP8L) and extended (VP8X) headers', () => {
    const riff = (chunk: string, payload: number[]) =>
      new Uint8Array([
        ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
        ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
        ...chunk.split('').map((c) => c.charCodeAt(0)),
        0,
        0,
        0,
        0,
        ...payload,
      ])
    const vp8 = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x03, 0xe0, 0x01, 0, 0, 0, 0])
    expect(sniffImageHeader(vp8)).toEqual({ format: 'webp', width: 832, height: 480 })
    const bits = (500 - 1) | ((700 - 1) << 14)
    const vp8l = riff('VP8L', [
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >>> 24) & 0xff,
      0,
      0,
      0,
      0,
    ])
    expect(sniffImageHeader(vp8l)).toEqual({ format: 'webp', width: 500, height: 700 })
    const w = 40000 - 1
    const h = 30000 - 1
    const vp8x = riff('VP8X', [
      0,
      0,
      0,
      0,
      w & 0xff,
      (w >> 8) & 0xff,
      (w >> 16) & 0xff,
      h & 0xff,
      (h >> 8) & 0xff,
      (h >> 16) & 0xff,
      0,
      0,
    ])
    expect(sniffImageHeader(vp8x)).toEqual({ format: 'webp', width: 40000, height: 30000 })
  })

  it('returns null for anything that is not a supported image container, and never throws', () => {
    const samples = [
      new Uint8Array(0),
      new Uint8Array([0xff]),
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xd8, 0x00, 0x00]),
      new Uint8Array(64).fill(0xff),
      new Uint8Array(64).fill(0x00),
      new TextEncoder().encode('GIF89a......................................'),
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"/>',
      ),
    ]
    for (const bytes of samples) expect(() => sniffImageHeader(bytes)).not.toThrow()
    for (const bytes of samples.slice(0, 1)) expect(sniffImageHeader(bytes)).toBeNull()
    expect(sniffImageHeader(samples[7] as Uint8Array)).toBeNull()
  })

  it('survives a fuzz of random bytes with an image signature without throwing or over-reading', () => {
    let seed = 1234567
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    for (let i = 0; i < 500; i += 1) {
      const bytes = new Uint8Array(20 + (next() % 60)).map(() => next() & 0xff)
      bytes.set(
        i % 3 === 0
          ? [0xff, 0xd8]
          : i % 3 === 1
            ? [0x89, 0x50, 0x4e, 0x47]
            : [0x52, 0x49, 0x46, 0x46],
      )
      expect(() => sniffImageHeader(bytes)).not.toThrow()
    }
  })
})

describe('shouldResumeRecognition', () => {
  const base = { photoReady: true, outcomeStatus: null, inFlight: false } as const
  it('resumes only for a ready photo with nothing running and no answer to keep', () => {
    expect(shouldResumeRecognition(base)).toBe(true)
    expect(shouldResumeRecognition({ ...base, outcomeStatus: 'cancelled' })).toBe(true)
    expect(shouldResumeRecognition({ ...base, photoReady: false })).toBe(false)
    expect(shouldResumeRecognition({ ...base, inFlight: true })).toBe(false)
    for (const kept of ['analysed', 'error', 'abstain_quality', 'not_available'] as const) {
      expect(shouldResumeRecognition({ ...base, outcomeStatus: kept })).toBe(false)
    }
  })
})
