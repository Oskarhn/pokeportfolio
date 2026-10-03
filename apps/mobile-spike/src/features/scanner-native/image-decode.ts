import type { RgbaImage } from '@shared/domain/scanner/rectify'
import {
  orientationSwapsDimensions,
  readJpegExifOrientation,
  type ExifOrientation,
} from './exif-orientation'

/**
 * Native, canvas-free-to-the-DOMAIN-layer image decode: raw file bytes -> oriented, bounded,
 * plain-typed-array `RgbaImage` (the exact type `preprocessRgbaForDino`/`rectify.ts` already
 * consume, unchanged from the web scanner). Skia is the ONLY thing in this file that touches a
 * native decoder or a canvas; everything past `decodeToRgba`'s return value is the same pure
 * domain code the web scanner already proved correct.
 *
 * Deep, headless-only imports (not the package root): `@shopify/react-native-skia`'s own root
 * barrel (src/index.ts) re-exports `<Canvas>` and its Reanimated integration, which crashed real
 * app startup on-device with "react-native-reanimated is not installed!" (a lazily-thrown error
 * from an eager module-scope proxy access — see docs/mobile/P182_PORTABILITY_AUDIT.md). This
 * module only ever needs the headless `Skia` global (raw decode/surface/paint), never a React
 * component, so it `require()`s the specific files that provide it directly — none of which
 * reference Reanimated or Canvas (confirmed by reading their own import lists). `require()`
 * rather than `import` is deliberate here too: those files' own `.ts` sources assume DOM lib
 * types (`OffscreenCanvas`, `GPUDevice`, ...) this project's tsconfig does not include, and a
 * static `import` would pull them into this project's own typecheck graph. The small surface this
 * file actually uses is hand-typed below instead.
 */

// Side-effect only: installs the native JSI bindings and sets the `global.SkiaApi` that
// `skia/Skia.ts` (required below) reads from. Normally pulled in transitively by the package's own
// root barrel; required explicitly here since this module deliberately bypasses that barrel.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@shopify/react-native-skia/src/skia/NativeSetup')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see module doc: avoids tsc following Skia's own DOM-typed source graph.
const { Skia } = require('@shopify/react-native-skia/src/skia/Skia') as { Skia: MinimalSkiaApi }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AlphaType } = require('@shopify/react-native-skia/src/skia/types/Image/ImageFactory') as {
  AlphaType: { Unpremul: number }
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ColorType } = require('@shopify/react-native-skia/src/skia/types/Image/ColorType') as {
  ColorType: { RGBA_8888: number }
}

interface MinimalSkImage {
  width(): number
  height(): number
  dispose(): void
}

interface MinimalSkCanvas {
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(degrees: number, px: number, py: number): void
  scale(x: number, y: number): void
  drawImageRect(
    image: MinimalSkImage,
    src: { x: number; y: number; width: number; height: number },
    dest: { x: number; y: number; width: number; height: number },
    paint: unknown,
  ): void
}

interface MinimalSkSurface {
  getCanvas(): MinimalSkCanvas
  flush(): void
  makeImageSnapshot(): {
    readPixels(
      x: number,
      y: number,
      info: { width: number; height: number; colorType: number; alphaType: number },
    ): Uint8Array | Float32Array | null
  }
}

interface MinimalSkiaApi {
  Data: { fromBytes(bytes: Uint8Array): unknown }
  Image: { MakeImageFromEncoded(data: unknown): MinimalSkImage | null }
  Surface: { MakeOffscreen(width: number, height: number): MinimalSkSurface | null }
  Paint(): unknown
}

export interface DecodedImage extends RgbaImage {
  readonly originalWidth: number
  readonly originalHeight: number
  /** Size of the image AFTER EXIF orientation and BEFORE the downscale: the pixel space the text
   *  recogniser (which opens the file itself) reports its line frames in. */
  readonly orientedWidth: number
  readonly orientedHeight: number
}

export class ImageDecodeError extends Error {
  constructor(
    message: string,
    readonly code: 'corrupt' | 'zero-dimension' | 'unsupported',
  ) {
    super(message)
    this.name = 'ImageDecodeError'
  }
}

/** Per-EXIF-orientation canvas transform, applied BEFORE drawing the source image at its own
 *  natural (unrotated) size at the origin — so the draw call itself is always the same axis-
 *  aligned `drawImageRect(image, srcRect, {x:0,y:0,width:srcW,height:srcH})`, only the transform
 *  stack differs. Standard EXIF orientation semantics (tag 0x0112), matching the same
 *  rotate/flip table every image library uses. `outW`/`outH` are the CORRECTED (possibly
 *  swapped) canvas dimensions the caller already sized the offscreen surface to. */
export function applyOrientationTransform(
  canvas: Pick<MinimalSkCanvas, 'translate' | 'rotate' | 'scale'>,
  orientation: ExifOrientation,
  outW: number,
  outH: number,
): void {
  switch (orientation) {
    case 1:
      return
    case 2: // flip horizontal
      canvas.translate(outW, 0)
      canvas.scale(-1, 1)
      return
    case 3: // rotate 180
      canvas.translate(outW, outH)
      canvas.rotate(180, 0, 0)
      return
    case 4: // flip vertical
      canvas.translate(0, outH)
      canvas.scale(1, -1)
      return
    case 5: // transpose: flip horizontal then rotate 90 CW
      canvas.rotate(90, 0, 0)
      canvas.scale(1, -1)
      return
    case 6: // rotate 90 CW
      canvas.translate(outW, 0)
      canvas.rotate(90, 0, 0)
      return
    case 7: // transverse: flip horizontal then rotate 270 CW
      canvas.translate(outW, outH)
      canvas.rotate(270, 0, 0)
      canvas.scale(-1, 1)
      return
    case 8: // rotate 270 CW (90 CCW)
      canvas.translate(0, outH)
      canvas.rotate(270, 0, 0)
      return
  }
}

/**
 * Decodes `fileBytes`, corrects EXIF orientation, and downscales so the longest edge is at most
 * `maxLongEdge` (mirrors the web scanner's `CAPTURE_MAX_LONG_EDGE` policy — see image-safety.ts
 * for the full pre/post-decode bound set). Never upscales. Draws through an offscreen Skia
 * surface (decode + orient + resize in one pass, one allocation) and reads back plain RGBA bytes —
 * nothing downstream of this function ever touches Skia again.
 */
export function decodeToRgba(fileBytes: Uint8Array, maxLongEdge: number): DecodedImage {
  const data = Skia.Data.fromBytes(fileBytes)
  const decoded = Skia.Image.MakeImageFromEncoded(data)
  if (!decoded) throw new ImageDecodeError('Could not decode this image.', 'corrupt')
  const srcWidth = decoded.width()
  const srcHeight = decoded.height()
  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new ImageDecodeError('Decoded image has zero dimensions.', 'zero-dimension')
  }

  const orientation = readJpegExifOrientation(fileBytes)
  const swapped = orientationSwapsDimensions(orientation)
  const orientedWidth = swapped ? srcHeight : srcWidth
  const orientedHeight = swapped ? srcWidth : srcHeight

  const longEdge = Math.max(orientedWidth, orientedHeight)
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
  const outWidth = Math.max(1, Math.round(orientedWidth * scale))
  const outHeight = Math.max(1, Math.round(orientedHeight * scale))

  const surface = Skia.Surface.MakeOffscreen(outWidth, outHeight)
  if (!surface) throw new ImageDecodeError('Could not allocate a decode surface.', 'unsupported')
  try {
    const canvas = surface.getCanvas()
    canvas.save()
    applyOrientationTransform(canvas, orientation, outWidth, outHeight)
    // Draw the DECODED (pre-orientation) image scaled directly to the oriented+scaled canvas
    // extent, so orientation and downscale happen in the one transform+draw pass.
    const drawWidth = swapped ? outHeight : outWidth
    const drawHeight = swapped ? outWidth : outHeight
    canvas.drawImageRect(
      decoded,
      { x: 0, y: 0, width: srcWidth, height: srcHeight },
      { x: 0, y: 0, width: drawWidth, height: drawHeight },
      Skia.Paint(),
    )
    canvas.restore()
    surface.flush()
    const snapshot = surface.makeImageSnapshot()
    // Explicit colorType/alphaType (not the platform's native pixel layout, which can be BGRA on
    // some Android devices) so the byte order this function hands to `preprocessRgbaForDino` is
    // always R,G,B,A regardless of device — never inferred from whatever the platform happens to
    // default to.
    const pixels = snapshot.readPixels(0, 0, {
      width: outWidth,
      height: outHeight,
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Unpremul,
    })
    if (pixels === null) throw new ImageDecodeError('Could not read decoded pixels.', 'unsupported')
    return {
      data: new Uint8ClampedArray(
        pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer),
      ),
      width: outWidth,
      height: outHeight,
      originalWidth: srcWidth,
      originalHeight: srcHeight,
      orientedWidth,
      orientedHeight,
    }
  } finally {
    decoded.dispose()
  }
}
