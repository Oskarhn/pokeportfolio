/**
 * Tiny canvas-platform compatibility shim shared by analyze.ts and rectify-capture.ts (P79):
 * prefer OffscreenCanvas (works inside the worker-adjacent paths without a live DOM element),
 * fall back to a real `<canvas>` where OffscreenCanvas is unavailable. Previously duplicated
 * verbatim in both modules; factored out once a THIRD near-identical copy (rectify-capture.ts's
 * JPEG-encoding half) made the duplication worth naming.
 */

export type ScanCanvas = HTMLCanvasElement | OffscreenCanvas
export type ScanContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export function createCompatCanvas(
  width: number,
  height: number,
): { element: ScanCanvas; context: ScanContext } {
  if (typeof OffscreenCanvas === 'function') {
    const element = new OffscreenCanvas(
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
    )
    const context = element.getContext('2d')
    if (context !== null) return { element, context }
  }
  const element = document.createElement('canvas')
  element.width = Math.max(1, Math.round(width))
  element.height = Math.max(1, Math.round(height))
  const context = element.getContext('2d')
  if (context === null) throw new Error('Canvas 2D is unavailable in this browser.')
  return { element, context }
}

/** Encodes a compat canvas to a JPEG Blob, whichever canvas kind it is. Discriminates by DUCK
 *  TYPING (`'convertToBlob' in element`) rather than `instanceof OffscreenCanvas`: the global
 *  `OffscreenCanvas` constructor does not exist at all in Node (unit tests, this project's
 *  offline scripts), where a bare `instanceof OffscreenCanvas` would throw a ReferenceError
 *  before ever reaching the intended "unsupported here" path — the `in` check narrows cleanly
 *  for TypeScript AND never references that global at runtime. */
export function canvasToBlob(element: ScanCanvas, quality = 0.9): Promise<Blob> {
  if ('convertToBlob' in element) {
    return element.convertToBlob({ type: 'image/jpeg', quality })
  }
  return new Promise((resolve, reject) => {
    element.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('The canvas could not be encoded.'))
          return
        }
        resolve(blob)
      },
      'image/jpeg',
      quality,
    )
  })
}
