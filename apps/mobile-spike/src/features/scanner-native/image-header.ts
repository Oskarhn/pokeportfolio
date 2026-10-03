/**
 * Container-header dimension sniffing, run on the raw file bytes BEFORE any native decoder or OCR
 * engine touches the file (P184). A compressed pixel bomb — a few kilobytes of JPEG/PNG that
 * declares tens of thousands of pixels per edge — passes the file-size bound and would otherwise
 * be handed to Skia and ML Kit, both of which allocate from the DECLARED dimensions. Reading the
 * declared size from the header costs a few byte reads, so the pixel bounds in `image-safety.ts`
 * can reject the file first.
 *
 * Only JPEG, PNG and WebP are recognised: the system photo picker and camera hand this app JPEG
 * (re-encoded by the picker, see photo/expo-photo-port.ts) or PNG. Anything else — including
 * non-image bytes with an image extension — yields `null`, which the pipeline treats as
 * "not a supported image" and refuses. Pure byte parsing, no native calls: unit-testable without a
 * device.
 */

export type SniffedImageFormat = 'jpeg' | 'png' | 'webp'

export interface SniffedImageHeader {
  readonly format: SniffedImageFormat
  readonly width: number
  readonly height: number
}

export function sniffImageHeader(bytes: Uint8Array): SniffedImageHeader | null {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return sniffJpeg(bytes)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return sniffPng(bytes)
  }
  if (bytes.length >= 25 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return sniffWebp(bytes)
  }
  return null
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

function sniffPng(bytes: Uint8Array): SniffedImageHeader | null {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { format: 'png', width: view.getUint32(16, false), height: view.getUint32(20, false) }
}

// Every JPEG start-of-frame marker except DHT (C4), JPG (C8) and DAC (CC).
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function sniffJpeg(bytes: Uint8Array): SniffedImageHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    if (marker === undefined) return null
    if (marker === 0xff) {
      offset += 1 // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end / scan start before any frame header
    const segmentLength = view.getUint16(offset + 2, false)
    if (segmentLength < 2) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return null
      return {
        format: 'jpeg',
        height: view.getUint16(offset + 5, false),
        width: view.getUint16(offset + 7, false),
      }
    }
    offset += 2 + segmentLength
  }
  return null
}

function sniffWebp(bytes: Uint8Array): SniffedImageHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null
    // 24-bit little-endian (canvas width - 1) at 24, (canvas height - 1) at 27.
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
    return { format: 'webp', width, height }
  }
  if (chunk === 'VP8 ') {
    if (bytes.length < 30) return null
    return {
      format: 'webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null
    const bits = view.getUint32(21, true)
    return { format: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  return null
}
