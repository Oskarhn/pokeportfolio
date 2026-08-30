/**
 * Module-level mirror of "does the scanner currently hold a nonempty in-memory batch" (P83 §6/§7,
 * D-100) — read by build-freshness-runtime.ts, which lives entirely outside React and cannot read
 * ScannerPage's `useReducer` state directly. ScannerPage already treats a nonempty batch as
 * unsaved work for SPA navigation (its `useBlocker` call); this lets the SAME fact gate an
 * automatic reload triggered by a stale-deployment/chunk-load-failure signal, which a router
 * blocker cannot intercept.
 *
 * Deliberately a bare module-level counter, not a store/observable: nothing outside this file ever
 * needs to react to it changing, only to read its current value at the moment a reload is being
 * considered.
 */
let batchSize = 0

/** Called from ScannerPage whenever `state.batch.length` changes (and on unmount, with 0). */
export function setScannerBatchSize(size: number): void {
  batchSize = size
}

export function hasUnsavedScannerWork(): boolean {
  return batchSize > 0
}
