/**
 * Minimal JPEG EXIF orientation reader (tag 0x0112, IFD0). Skia's `MakeImageFromEncoded` decodes
 * raw pixel bytes with NO EXIF auto-rotation (confirmed against its own C++ `SkCodec` layer, which
 * exposes orientation as metadata a caller must apply itself, not a decode-time transform) — a
 * portrait phone photo taken upright but stored with Orientation=6 ("rotate 90 CW to display
 * correctly") would otherwise decode sideways. Pure byte-parsing, no native calls, so it is cheap
 * to run before any decode and unit-testable without a device.
 *
 * Returns 1 (normal) for anything that is not a well-formed JPEG/EXIF segment — a missing or
 * malformed tag must never crash the scan, only leave the image un-rotated (a visibly-sideways
 * result the user can retake, not a thrown error).
 */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export function readJpegExifOrientation(bytes: Uint8Array): ExifOrientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]
    if (marker === undefined) break
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const segmentLength = view.getUint16(offset + 2, false)
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return 1
    if (marker === 0xe1) {
      const orientation = parseExifApp1(bytes, view, offset + 4, segmentLength - 2)
      if (orientation !== null) return orientation
    }
    if (marker === 0xda) break // start of scan: no more markers follow
    offset += 2 + segmentLength
  }
  return 1
}

function parseExifApp1(
  bytes: Uint8Array,
  view: DataView,
  start: number,
  length: number,
): ExifOrientation | null {
  if (length < 10) return null
  if (
    bytes[start] !== 0x45 || // 'E'
    bytes[start + 1] !== 0x78 || // 'x'
    bytes[start + 2] !== 0x69 || // 'i'
    bytes[start + 3] !== 0x66 || // 'f'
    bytes[start + 4] !== 0x00 ||
    bytes[start + 5] !== 0x00
  ) {
    return null
  }
  const tiffStart = start + 6
  const byte0 = bytes[tiffStart]
  const byte1 = bytes[tiffStart + 1]
  if (byte0 === undefined || byte1 === undefined) return null
  const littleEndian = byte0 === 0x49 && byte1 === 0x49 // 'II'
  const bigEndian = byte0 === 0x4d && byte1 === 0x4d // 'MM'
  if (!littleEndian && !bigEndian) return null
  const le = littleEndian
  const magic = view.getUint16(tiffStart + 2, le)
  if (magic !== 42) return null
  const ifd0Offset = view.getUint32(tiffStart + 4, le)
  const ifd0Start = tiffStart + ifd0Offset
  if (ifd0Start + 2 > bytes.length) return null
  const entryCount = view.getUint16(ifd0Start, le)
  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifd0Start + 2 + i * 12
    if (entryOffset + 12 > bytes.length) break
    const tag = view.getUint16(entryOffset, le)
    if (tag === 0x0112) {
      const value = view.getUint16(entryOffset + 8, le)
      return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1
    }
  }
  return null
}

/** Whether this orientation swaps width/height when displayed correctly (5,6,7,8 — a 90°/270°
 *  rotation), so callers sizing an output buffer know which dimension pairing to allocate. */
export function orientationSwapsDimensions(orientation: ExifOrientation): boolean {
  return orientation >= 5
}
