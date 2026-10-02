/**
 * Pixel dimensions read straight from an image file's HEADER bytes — no decoder involved.
 *
 * Why this exists (P151): `createImageBitmap(file)` allocates the whole decoded raster (width x
 * height x 4 bytes) before it returns, so a small compressed file that DECLARES a huge image (a
 * "pixel bomb": a few hundred bytes of PNG header claiming 60000 x 60000 px) used to be measured
 * only AFTER that allocation had already happened or the tab had already died. Reading the declared
 * dimensions from the first bytes lets the caller refuse such a file before any decoder runs.
 *
 * Deliberately minimal: PNG, JPEG, GIF, WebP and BMP — the formats browsers actually hand a file
 * input. Anything else (HEIC/AVIF, whose `ispe` box needs a full ISO-BMFF walk; a JPEG whose
 * dimensions sit beyond the sniffed prefix behind unusually large metadata; truncated or unknown
 * data) returns `null`, meaning "could not pre-check" — the caller falls back to checking the
 * decoded bitmap, which is the pre-P151 behaviour. Pure and synchronous over a byte array so it is
 * unit-testable with tiny hand-built fixtures (no binary bombs are ever committed).
 */

export type SniffedImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'

export interface SniffedImageHeader {
  readonly format: SniffedImageFormat
  readonly width: number
  readonly height: number
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
}
function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
}
function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)
}
function u32be(b: Uint8Array, i: number): number {
  return (u16be(b, i) * 0x10000 + u16be(b, i + 2)) >>> 0
}
function u32le(b: Uint8Array, i: number): number {
  return (u16le(b, i) + u16le(b, i + 2) * 0x10000) >>> 0
}
function i32le(b: Uint8Array, i: number): number {
  return u32le(b, i) | 0
}
function ascii(b: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let i = start; i < start + length; i += 1) out += String.fromCharCode(b[i] ?? 0)
  return out
}

function sniffPng(b: Uint8Array): SniffedImageHeader | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || !signature.every((byte, i) => b[i] === byte)) return null
  if (ascii(b, 12, 4) !== 'IHDR') return null
  return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) }
}

/** Baseline/progressive/lossless SOF markers, i.e. every SOFn except DHT (C4), JPG (C8), DAC (CC). */
function isJpegSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function sniffJpeg(b: Uint8Array): SniffedImageHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null // lost sync: not a well-formed segment stream
    let marker = b[i + 1] ?? 0
    // Any number of 0xFF fill bytes may precede a marker.
    while (marker === 0xff && i + 2 < b.length) {
      i += 1
      marker = b[i + 1] ?? 0
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2 // standalone markers carry no length
      continue
    }
    // EOI or start-of-scan without a preceding frame header: dimensions are not declared.
    if (marker === 0xd9 || marker === 0xda) return null
    const length = u16be(b, i + 2)
    if (isJpegSof(marker)) {
      if (i + 9 > b.length) return null
      return { format: 'jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    if (length < 2) return null
    i += 2 + length
  }
  return null
}

function sniffGif(b: Uint8Array): SniffedImageHeader | null {
  if (b.length < 10) return null
  const magic = ascii(b, 0, 6)
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null
  return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8) }
}

function sniffWebp(b: Uint8Array): SniffedImageHeader | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag at 20, start code 9D 01 2A at 23, then 14-bit dimensions.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const b0 = b[21] ?? 0
    const b1 = b[22] ?? 0
    const b2 = b[23] ?? 0
    const b3 = b[24] ?? 0
    return {
      format: 'webp',
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    }
  }
  if (chunk === 'VP8X') {
    return { format: 'webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) }
  }
  return null
}

function sniffBmp(b: Uint8Array): SniffedImageHeader | null {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null
  const headerSize = u32le(b, 14)
  if (headerSize === 12) return { format: 'bmp', width: u16le(b, 18), height: u16le(b, 20) }
  if (headerSize < 40) return null
  return { format: 'bmp', width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) }
}

/** Declared dimensions of the image in `bytes` (the file's leading bytes), or `null` when the
 *  format is not one of the five recognised above or the header is truncated/malformed. A returned
 *  dimension can be 0 — that is a real (malformed) declaration and the caller must reject it. */
export function sniffImageHeader(bytes: Uint8Array): SniffedImageHeader | null {
  return (
    sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes) ?? sniffBmp(bytes)
  )
}
