import { registerUnsavedWorkSource } from '../../platform/unsaved-work-registry'

/**
 * Module-level mirror of "does the scanner currently hold a nonempty in-memory batch" (P83 §6/§7,
 * D-100) — read by build-freshness-runtime.ts, which lives entirely outside React and cannot read
 * ScannerPage's `useReducer` state directly. ScannerPage already treats a nonempty batch as
 * unsaved work for SPA navigation (its `useBlocker` call); this lets the SAME fact gate an
 * automatic reload triggered by a stale-deployment/chunk-load-failure signal, which a router
 * blocker cannot intercept.
 *
 * F-40 (P89): this is now ONE registered source among several in the shared app-wide
 * unsaved-work-registry.ts, not the sole fact the reload decision consults — see that module's
 * header for the regression this closes (typed purchase/sale input on other routes used to be
 * silently discarded by the same automatic reload this file alone used to gate). The module-level
 * counter and its two exports are kept exactly as they were so ScannerPage's existing call sites
 * and this module's own dedicated test need no changes; only the REGISTRATION is new.
 *
 * Deliberately a bare module-level counter, not a store/observable: nothing outside this file ever
 * needs to react to it changing, only to read its current value at the moment a reload is being
 * considered.
 */
let batchSize = 0

registerUnsavedWorkSource('scanner-batch', () => batchSize > 0)

/** Called from ScannerPage whenever `state.batch.length` changes (and on unmount, with 0). */
export function setScannerBatchSize(size: number): void {
  batchSize = size
}

export function hasUnsavedScannerWork(): boolean {
  return batchSize > 0
}
