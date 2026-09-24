/**
 * Cooperative-cancellation primitives shared by the scanner's analysis pipeline (controller.ts) and
 * the OCR stage it drives (analyze.ts). Kept in its own module so analyze.ts can observe an abort
 * without importing controller.ts (which imports analyze.ts).
 *
 * Cancellation here is COOPERATIVE and checked between stages: the underlying browser APIs
 * (`createImageBitmap`, a single Tesseract `recognize`, a worker embed, a catalog round trip) cannot
 * be interrupted mid-call, so an abort takes effect at the next checkpoint. That is exactly enough
 * to keep a cancelled or superseded scan from starting any further expensive stage.
 */

/** Thrown when a scan's caller aborted it (cancel, retake, route exit, account switch), when a
 *  newer scan superseded it, or when its controller was disposed. Distinguishable from a real
 *  analysis failure so callers can tell "cancelled" apart from "genuinely failed" — ScannerPage
 *  never surfaces either once the analysis is stale, but the distinct name keeps that intent legible
 *  and testable. */
export class ScannerAnalysisAbortedError extends Error {
  constructor() {
    super('Scan analysis was cancelled.')
    this.name = 'ScannerAnalysisAbortedError'
  }
}

export function throwIfAnalysisAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScannerAnalysisAbortedError()
}

/** Same check as `signal.aborted`, as a function: after an `await`, TypeScript keeps the narrowing
 *  from an earlier `if (signal.aborted) return` and flags a second read as impossible, although the
 *  signal can change at any suspension point. */
export function isAnalysisAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}
