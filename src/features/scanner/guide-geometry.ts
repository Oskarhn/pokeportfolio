/**
 * Shared geometry model for the scanner (prompt §10): ONE source of truth mapping the visual
 * 5:7 framing guide drawn over the live preview onto the pixel rectangle of the physical card
 * inside the captured frame. The CSS guide and the OCR crop must never drift apart — the guide's
 * size/position constants here are the same numbers ScannerPage renders, exported so a test can
 * pin CSS and math together.
 *
 * Two coordinate spaces are involved:
 *   - ELEMENT space: CSS pixels of the <video> element as laid out (clientWidth × clientHeight).
 *     The guide rect is defined in this space (centred, height GUIDE_HEIGHT_FRACTION of the
 *     element, capped at GUIDE_MAX_WIDTH_FRACTION of its width).
 *   - SOURCE space: intrinsic video pixels (videoWidth × videoHeight). `object-fit: cover`
 *     scales the source uniformly and centres it, cropping overflow — so element coordinates map
 *     back through the cover transform: subtract centring offset, divide by cover scale.
 *
 * All functions are pure and integer-stable: the same inputs always produce the same clamped,
 * rounded rectangle inside the source bounds.
 */

/** The guide's rendered geometry, mirroring ScannerPage's `aspect-[5/7] h-[58%] max-w-[86%]`. */
export const GUIDE_ASPECT_WIDTH = 5
export const GUIDE_ASPECT_HEIGHT = 7
export const GUIDE_HEIGHT_FRACTION = 0.58
export const GUIDE_MAX_WIDTH_FRACTION = 0.86

export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The guide rectangle in element space for a given rendered video element size. Centred; keeps
 * the 5:7 ratio; never exceeds the width cap (shrinking height to preserve the ratio instead).
 */
export function computeGuideRect(elementWidth: number, elementHeight: number): PixelRect {
  let height = elementHeight * GUIDE_HEIGHT_FRACTION
  let width = (height * GUIDE_ASPECT_WIDTH) / GUIDE_ASPECT_HEIGHT
  const maxWidth = elementWidth * GUIDE_MAX_WIDTH_FRACTION
  if (width > maxWidth) {
    width = maxWidth
    height = (width * GUIDE_ASPECT_HEIGHT) / GUIDE_ASPECT_WIDTH
  }
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  }
}

/**
 * The `object-fit: cover` transform from element space to source space: the uniform scale factor
 * and the top-left offset of the rendered source content within the element.
 */
function coverTransform(
  sourceWidth: number,
  sourceHeight: number,
  elementWidth: number,
  elementHeight: number,
): { scale: number; offsetX: number; offsetY: number } {
  const scale = Math.max(elementWidth / sourceWidth, elementHeight / sourceHeight)
  return {
    scale,
    offsetX: (elementWidth - sourceWidth * scale) / 2,
    offsetY: (elementHeight - sourceHeight * scale) / 2,
  }
}

/** Clamps a rect into [0,maxWidth]×[0,maxHeight] and rounds to stable integers (round-half-up on
 *  already-positive values; Math.round is deterministic across engines for these magnitudes). */
export function clampRectToBounds(rect: PixelRect, maxWidth: number, maxHeight: number): PixelRect {
  const left = Math.min(Math.max(Math.round(rect.left), 0), maxWidth)
  const top = Math.min(Math.max(Math.round(rect.top), 0), maxHeight)
  const right = Math.min(Math.max(Math.round(rect.left + rect.width), left), maxWidth)
  const bottom = Math.min(Math.max(Math.round(rect.top + rect.height), top), maxHeight)
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * Maps the rendered guide rectangle into the video's intrinsic pixel space, honouring
 * object-fit: cover. Works for portrait and landscape sources in either viewport orientation;
 * the result never leaves the source bounds.
 */
export function cardRectFromVideo(
  videoSourceWidth: number,
  videoSourceHeight: number,
  elementWidth: number,
  elementHeight: number,
): PixelRect {
  if (
    !Number.isFinite(videoSourceWidth) ||
    !Number.isFinite(videoSourceHeight) ||
    videoSourceWidth <= 0 ||
    videoSourceHeight <= 0 ||
    elementWidth <= 0 ||
    elementHeight <= 0
  ) {
    throw new Error('Guide geometry needs positive source and element dimensions.')
  }
  const guide = computeGuideRect(elementWidth, elementHeight)
  const { scale, offsetX, offsetY } = coverTransform(
    videoSourceWidth,
    videoSourceHeight,
    elementWidth,
    elementHeight,
  )
  return clampRectToBounds(
    {
      left: (guide.left - offsetX) / scale,
      top: (guide.top - offsetY) / scale,
      width: guide.width / scale,
      height: guide.height / scale,
    },
    videoSourceWidth,
    videoSourceHeight,
  )
}

/**
 * Rescales a source-space card rect into a captured image's pixel space (the capture may be
 * uniformly downscaled from the source before storage). Pure integer output.
 */
export function scaleCardRect(rect: PixelRect, scaleX: number, scaleY: number): PixelRect {
  return {
    left: Math.max(0, Math.round(rect.left * scaleX)),
    top: Math.max(0, Math.round(rect.top * scaleY)),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  }
}

/**
 * File-upload card-rect policy (prompt §11). A picked photo has no live guide, so V1 uses a
 * deterministic rule instead of edge detection:
 *
 *   - aspect within CARD_ASPECT_TOLERANCE of the card's 5:7 shape → the WHOLE image is treated
 *     as the card (the preferred input: a photo where the card fills the frame);
 *   - otherwise → a conservative centred 5:7 crop at FILE_CROP_INSET of the largest inscribed
 *     5:7 rectangle, keeping margin against edges and never reading random background.
 *
 * Pure and integer-stable; the caller crops to this rect before anything is shown or OCR'd, so
 * the reviewed preview is exactly the pixels recognition sees.
 */
export const CARD_ASPECT_TOLERANCE = 0.12
export const FILE_CROP_INSET = 0.9

export function decideFileCardRect(imageWidth: number, imageHeight: number): PixelRect {
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    throw new Error('File crop policy needs positive image dimensions.')
  }
  const aspect = imageWidth / imageHeight
  const cardAspect = GUIDE_ASPECT_WIDTH / GUIDE_ASPECT_HEIGHT
  if (Math.abs(aspect - cardAspect) <= CARD_ASPECT_TOLERANCE) {
    return clampRectToBounds(
      { left: 0, top: 0, width: imageWidth, height: imageHeight },
      imageWidth,
      imageHeight,
    )
  }
  // Largest centred 5:7 rect inside the image, then inset by FILE_CROP_INSET around its centre.
  let cropWidth = imageWidth
  let cropHeight = (cropWidth * GUIDE_ASPECT_HEIGHT) / GUIDE_ASPECT_WIDTH
  if (cropHeight > imageHeight) {
    cropHeight = imageHeight
    cropWidth = (cropHeight * GUIDE_ASPECT_WIDTH) / GUIDE_ASPECT_HEIGHT
  }
  cropWidth *= FILE_CROP_INSET
  cropHeight *= FILE_CROP_INSET
  return clampRectToBounds(
    {
      left: (imageWidth - cropWidth) / 2,
      top: (imageHeight - cropHeight) / 2,
      width: cropWidth,
      height: cropHeight,
    },
    imageWidth,
    imageHeight,
  )
}
