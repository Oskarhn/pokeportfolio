/**
 * Canvas-free reimplementation of the pinned DINOv2 processor's preprocessing (P96/D-107). Exists
 * because `@huggingface/transformers` (4.2.0)'s own `RawImage.resize`/`center_crop`/`toCanvas`
 * unconditionally construct an `OffscreenCanvas` in a web/worker environment (`src/utils/image.js`'s
 * `createCanvasFunction`) with no fallback — confirmed by reading the installed bundle directly,
 * not assumed. P90's main-thread RGBA fallback (`visual-client.ts`) solved the OTHER OffscreenCanvas
 * call site (converting the captured `ImageBitmap` to RGBA before it ever reaches the worker), but
 * P94 found that fix incomplete: even a worker that already HAS a plain RGBA buffer still crashes
 * the instant `processor(image)` runs, because the library's own `AutoProcessor.from_pretrained`-
 * produced `BitImageProcessor` calls `RawImage.resize`/`.center_crop` internally, which construct
 * their OWN throwaway canvas regardless of how the caller supplied the image. There is no
 * documented option to disable that — the only way to keep visual recognition working on a worker
 * without OffscreenCanvas is to skip `processor(image)` entirely and build the same numeric tensor
 * by hand from the RGBA bytes already sitting in memory.
 *
 * Every constant below is copied verbatim from the pinned model's own committed
 * `public/scanner-assets/visual-v1/model/preprocessor_config.json` (`BitImageProcessor`), not
 * remembered ImageNet defaults that happen to coincide:
 *   do_convert_rgb=true, do_resize=true (size.shortest_edge=256, resample=3/bicubic — see the
 *   RESAMPLE note below), do_center_crop=true (crop_size 224x224), do_rescale=true
 *   (rescale_factor=1/255), do_normalize=true (image_mean/image_std below), do_pad=false,
 *   do_flip_channel_order=false. `docs/DECISIONS.md` D-107 records the full derivation and the
 *   parity-benchmark evidence this module was accepted on.
 *
 * RESAMPLE NOTE: transformers.js's own web-environment `RawImage.resize` (the code path this
 * project's Chromium/desktop scans have always exercised, proven at 99.7% TOP1) does NOT actually
 * honor `resample` at all — its `IS_WEB_ENV` branch calls `ctx.drawImage(canvas, 0, 0, w, h)`
 * unconditionally, and the `resample` config value is only consulted on its Node/`sharp` branch
 * (confirmed by reading the bundle: `src/utils/image.js`'s `resize()`). So there is no existing
 * browser-path behavior for this reimplementation to bit-match against — the real target is
 * RETRIEVAL-OUTCOME parity with whatever a real browser's canvas downscale produces, verified by
 * `scripts/scanner-preprocess-parity/` rather than assumed from the config's `resample: 3` label.
 * This module uses bilinear resampling (half-pixel-center convention, the same convention most
 * browsers' canvas 2D downscale approximates) as a simple, well-understood, easy-to-verify choice —
 * see D-107 for why bicubic was not judged worth the added complexity given the measured parity.
 *
 * Pure and platform-neutral (plain typed arrays, no canvas/DOM/sharp/OffscreenCanvas anywhere in
 * this file) so the identical code runs in the browser worker AND the offline Node parity harness —
 * same discipline as `capture-quality.ts`/`rectify.ts`/`photometric.ts`.
 */
import type { RgbaImage } from './rectify'

/** `preprocessor_config.json`'s `size.shortest_edge` — the resized image's SHORTER edge lands
 *  exactly here before center-cropping; the longer edge scales proportionally. */
export const DINO_RESIZE_SHORTEST_EDGE = 256
/** `preprocessor_config.json`'s `crop_size` — both the model's expected spatial input and this
 *  module's fixed output size. */
export const DINO_CROP_SIZE = 224
/** `preprocessor_config.json`'s `rescale_factor` (`1/255`, i.e. byte range -> unit range). */
export const DINO_RESCALE_FACTOR = 1 / 255
/** `preprocessor_config.json`'s `image_mean` — ImageNet statistics, RGB order. */
export const DINO_IMAGE_MEAN: readonly [number, number, number] = [0.485, 0.456, 0.406]
/** `preprocessor_config.json`'s `image_std` — ImageNet statistics, RGB order. */
export const DINO_IMAGE_STD: readonly [number, number, number] = [0.229, 0.224, 0.225]

/** A preprocessed tensor ready to feed directly to the pinned model: CHW float32, always
 *  `[3, DINO_CROP_SIZE, DINO_CROP_SIZE]` — the caller adds the batch dimension (this module never
 *  assumes a batch size, matching how `RawImage`-based preprocessing works one image at a time
 *  too). */
export interface DinoPreprocessedTensor {
  readonly data: Float32Array
  readonly dims: readonly [3, number, number]
}

/** Mirrors `ImageFeatureExtractor.get_resize_output_image_size`'s `shortest_edge`-only branch
 *  exactly (no `longest_edge` in this model's config, so that half of the upstream function never
 *  applies): scale so the SHORTER source dimension becomes {@link DINO_RESIZE_SHORTEST_EDGE},
 *  floor-with-2-decimal-rounding on both output dimensions, matching the upstream
 *  `Math.floor(Number(newWidth.toFixed(2)))` exactly so this reimplementation resizes to the
 *  identical target dimensions the library's own AutoProcessor path would (before either one gets
 *  to the resampling algorithm itself, which the two paths do not — and are not required to —
 *  agree on; see this module's own top-of-file RESAMPLE NOTE). */
function resizeOutputDimensions(
  srcWidth: number,
  srcHeight: number,
): { width: number; height: number } {
  const scale = Math.max(
    DINO_RESIZE_SHORTEST_EDGE / srcWidth,
    DINO_RESIZE_SHORTEST_EDGE / srcHeight,
  )
  const rawWidth = srcWidth * scale
  const rawHeight = srcHeight * scale
  return {
    width: Math.floor(Number(rawWidth.toFixed(2))),
    height: Math.floor(Number(rawHeight.toFixed(2))),
  }
}

/** Bilinear-resamples one RGB plane (3 interleaved channels, no alpha) from `src` at
 *  `(srcWidth, srcHeight)` to `(dstWidth, dstHeight)`, half-pixel-center convention (the standard
 *  `(x + 0.5) * scale - 0.5` mapping most image libraries use, including browsers' own canvas
 *  downscale approximately). Every source coordinate is clamped into range, so this never reads
 *  out of bounds even at the image edges. */
function resizeRgbBilinear(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  const dst = new Float32Array(dstWidth * dstHeight * 3)
  const scaleX = srcWidth / dstWidth
  const scaleY = srcHeight / dstHeight
  const maxX = srcWidth - 1
  const maxY = srcHeight - 1
  for (let y = 0; y < dstHeight; y += 1) {
    const srcYf = Math.min(Math.max((y + 0.5) * scaleY - 0.5, 0), maxY)
    const y0 = Math.floor(srcYf)
    const y1 = Math.min(y0 + 1, maxY)
    const fy = srcYf - y0
    for (let x = 0; x < dstWidth; x += 1) {
      const srcXf = Math.min(Math.max((x + 0.5) * scaleX - 0.5, 0), maxX)
      const x0 = Math.floor(srcXf)
      const x1 = Math.min(x0 + 1, maxX)
      const fx = srcXf - x0
      const rowY0 = y0 * srcWidth
      const rowY1 = y1 * srcWidth
      const i00 = (rowY0 + x0) * 3
      const i10 = (rowY0 + x1) * 3
      const i01 = (rowY1 + x0) * 3
      const i11 = (rowY1 + x1) * 3
      const outBase = (y * dstWidth + x) * 3
      for (let c = 0; c < 3; c += 1) {
        const top = (src[i00 + c] ?? 0) * (1 - fx) + (src[i10 + c] ?? 0) * fx
        const bottom = (src[i01 + c] ?? 0) * (1 - fx) + (src[i11 + c] ?? 0) * fx
        dst[outBase + c] = top * (1 - fy) + bottom * fy
      }
    }
  }
  return dst
}

/** Mirrors `RawImage.center_crop`'s web-env geometry exactly for the case this module always hits:
 *  a resized image whose shorter edge is {@link DINO_RESIZE_SHORTEST_EDGE} (256), always >= the
 *  {@link DINO_CROP_SIZE} (224) crop — so the offset is always non-negative and no padding branch
 *  (only reachable when the source is SMALLER than the crop) can ever apply here. */
function centerCropRgb(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  cropSize: number,
): Float32Array {
  const offsetX = Math.floor((srcWidth - cropSize) / 2)
  const offsetY = Math.floor((srcHeight - cropSize) / 2)
  const dst = new Float32Array(cropSize * cropSize * 3)
  for (let y = 0; y < cropSize; y += 1) {
    const srcRow = (y + offsetY) * srcWidth
    const dstRow = y * cropSize
    for (let x = 0; x < cropSize; x += 1) {
      const srcI = (srcRow + x + offsetX) * 3
      const dstI = (dstRow + x) * 3
      dst[dstI] = src[srcI] ?? 0
      dst[dstI + 1] = src[srcI + 1] ?? 0
      dst[dstI + 2] = src[srcI + 2] ?? 0
    }
  }
  return dst
}

/**
 * Full canvas-free equivalent of `BitImageProcessor.preprocess()` for this project's pinned DINOv2
 * config: RGBA -> drop alpha -> bilinear-resize (shortest edge 256) -> center-crop 224x224 ->
 * rescale /255 -> normalize (ImageNet mean/std) -> permute HWC -> CHW. Every step mirrors the
 * upstream library's own operation ORDER exactly (`preprocess()`'s own sequence); only the resize
 * algorithm itself necessarily differs, since the upstream web-env implementation has no
 * canvas-free equivalent to mirror (see this file's own RESAMPLE NOTE).
 *
 * Never touches the network, never allocates more than a small constant multiple of the
 * already-resident RGBA buffer (one resized-but-not-yet-cropped RGB float buffer, released the
 * instant the crop below is taken; the tiny final 224x224x3 output) — no `OffscreenCanvas`, no
 * `document`, no DOM reference of any kind.
 */
export function preprocessRgbaForDino(image: RgbaImage): DinoPreprocessedTensor {
  const { data, width, height } = image
  // do_convert_rgb: drop alpha, upcast to float in the SAME step (avoids a separate Uint8 RGB
  // intermediate buffer — one allocation instead of two).
  const rgb = new Float32Array(width * height * 3)
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    rgb[o] = data[i] ?? 0
    rgb[o + 1] = data[i + 1] ?? 0
    rgb[o + 2] = data[i + 2] ?? 0
  }

  const { width: resizedWidth, height: resizedHeight } = resizeOutputDimensions(width, height)
  const resized =
    resizedWidth === width && resizedHeight === height
      ? rgb
      : resizeRgbBilinear(rgb, width, height, resizedWidth, resizedHeight)

  const cropped =
    resizedWidth === DINO_CROP_SIZE && resizedHeight === DINO_CROP_SIZE
      ? resized
      : centerCropRgb(resized, resizedWidth, resizedHeight, DINO_CROP_SIZE)

  // do_rescale + do_normalize, fused into one pass over the (small, already-cropped) buffer —
  // (v/255 - mean) / std, per channel.
  const size = DINO_CROP_SIZE
  for (let i = 0; i < cropped.length; i += 3) {
    cropped[i] = ((cropped[i] ?? 0) * DINO_RESCALE_FACTOR - DINO_IMAGE_MEAN[0]) / DINO_IMAGE_STD[0]
    cropped[i + 1] =
      ((cropped[i + 1] ?? 0) * DINO_RESCALE_FACTOR - DINO_IMAGE_MEAN[1]) / DINO_IMAGE_STD[1]
    cropped[i + 2] =
      ((cropped[i + 2] ?? 0) * DINO_RESCALE_FACTOR - DINO_IMAGE_MEAN[2]) / DINO_IMAGE_STD[2]
  }

  // Permute HWC -> CHW (upstream's own final step, `Tensor.permute(2, 0, 1)`).
  const chw = new Float32Array(3 * size * size)
  const plane = size * size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hwcI = (y * size + x) * 3
      const p = y * size + x
      chw[p] = cropped[hwcI] ?? 0
      chw[plane + p] = cropped[hwcI + 1] ?? 0
      chw[2 * plane + p] = cropped[hwcI + 2] ?? 0
    }
  }

  return { data: chw, dims: [3, size, size] }
}
