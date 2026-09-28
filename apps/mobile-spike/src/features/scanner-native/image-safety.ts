/**
 * Pre-inference image bounds. Values 1-2 mirror the web scanner's own pinned constants
 * (`src/features/scanner/capture.ts`, `MAX_INPUT_FILE_BYTES`/`MAX_DECODED_PIXELS`) exactly, kept
 * as a re-export rather than a second literal so the two platforms cannot silently drift.
 *
 * The additional bounds (longest edge, minimum edge, aspect ratio) are NOT reused from the web
 * scanner: the P151 scanner-hardening phase that added an equivalent set (`image-header.ts`,
 * §12c) landed on a branch that was never merged into this native app's base (see
 * docs/mobile/P182_PORTABILITY_AUDIT.md) — this base's `capture.ts` only has the two constants
 * below. These three are therefore NEW, disclosed values for this phase, not reused ones.
 */
// Inlined rather than imported from `src/features/scanner/capture.ts`: that module's own top-level
// imports (`./guide-geometry`) are browser-feature-adjacent code not audited for native safety, so
// pulling the whole module in just for two constants would risk dragging in more than intended.
// Values copied verbatim (byte-identical to `capture.ts`'s own `MAX_INPUT_FILE_BYTES`/
// `MAX_DECODED_PIXELS`), not re-derived.
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024
export const MAX_DECODED_PIXELS = 40 * 1024 * 1024

/** Longest edge accepted post-decode, before any resize — bounds decode memory on a device with
 *  no browser-level pixel-bomb protection. A legitimate phone camera photo is nowhere near this. */
export const MAX_INPUT_LONG_EDGE_PX = 8000
/** Shorter edge floor — anything smaller cannot contain readable card text or a useful embedding. */
export const MIN_INPUT_EDGE_PX = 32
/** A card is roughly 2.5:1 at most even including background/table in frame; wider is not a card. */
export const MAX_ASPECT_RATIO = 6

export type ImageSafetyRejection =
  | { readonly ok: false; readonly reason: 'file-too-large'; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'zero-dimension' }
  | {
      readonly ok: false
      readonly reason: 'too-small'
      readonly width: number
      readonly height: number
    }
  | {
      readonly ok: false
      readonly reason: 'too-large'
      readonly width: number
      readonly height: number
    }
  | { readonly ok: false; readonly reason: 'decoded-pixels-exceeded'; readonly pixels: number }
  | { readonly ok: false; readonly reason: 'extreme-aspect-ratio'; readonly ratio: number }

export type ImageSafetyResult = { readonly ok: true } | ImageSafetyRejection

export function checkFileSize(bytes: number): ImageSafetyResult {
  if (bytes > MAX_INPUT_FILE_BYTES) return { ok: false, reason: 'file-too-large', bytes }
  return { ok: true }
}

/** Applied to the DECODED (post-orientation, pre-downscale) dimensions, before the expensive
 *  OCR/embedding stages run — the one bound a native decoder does not offer for free the way the
 *  web scanner's pre-decode header sniff does (see this module's own header note). */
export function checkDecodedDimensions(width: number, height: number): ImageSafetyResult {
  if (width <= 0 || height <= 0) return { ok: false, reason: 'zero-dimension' }
  if (width < MIN_INPUT_EDGE_PX || height < MIN_INPUT_EDGE_PX) {
    return { ok: false, reason: 'too-small', width, height }
  }
  if (width > MAX_INPUT_LONG_EDGE_PX || height > MAX_INPUT_LONG_EDGE_PX) {
    return { ok: false, reason: 'too-large', width, height }
  }
  const pixels = width * height
  if (pixels > MAX_DECODED_PIXELS) return { ok: false, reason: 'decoded-pixels-exceeded', pixels }
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (ratio > MAX_ASPECT_RATIO) return { ok: false, reason: 'extreme-aspect-ratio', ratio }
  return { ok: true }
}

export function imageSafetyRejectionMessage(rejection: ImageSafetyRejection): string {
  switch (rejection.reason) {
    case 'file-too-large':
      return 'This photo is too large. Try a smaller photo.'
    case 'zero-dimension':
      return 'This photo could not be read.'
    case 'too-small':
      return 'This photo is too small to scan.'
    case 'too-large':
    case 'decoded-pixels-exceeded':
      return 'This photo is too large. Try a smaller photo.'
    case 'extreme-aspect-ratio':
      return 'This does not look like a card photo.'
  }
}
