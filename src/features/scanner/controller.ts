import type { ScannerUiController } from './contract'

/**
 * The placeholder ScannerUiController P66 ships so the whole scanner flow — capture, review,
 * analysis states, confirmation, batch review, exit discipline — is exercisable without a
 * recognition engine behind it (prompt §3/§22: no OCR, no matcher, no acquisition mutation).
 *
 * Every answer is honest:
 *   - analyzeCapture resolves NO_MATCH, which renders "Couldn't identify this card." with the
 *     manual-search fallback — a real state the app already designs for, not a fake success.
 *   - searchFallback resolves empty for the same reason.
 *   - commitBatch REFUSES. Resolving with a count would claim cards entered the Portfolio when
 *     nothing was written anywhere; throwing keeps the batch intact on screen with a truthful
 *     error instead.
 *
 * P68 replaces this entire file in one move (the same seam replacement M13/M16 integrations
 * used) without touching any component above it.
 */

export class ScannerNotConnectedError extends Error {
  constructor() {
    super('Scanned cards are not connected to your portfolio yet.')
    this.name = 'ScannerNotConnectedError'
  }
}

export function getScannerUiController(): ScannerUiController {
  return {
    analyzeCapture() {
      return Promise.resolve({ confidence: 'NO_MATCH', candidates: [] })
    },
    searchFallback() {
      return Promise.resolve([])
    },
    // A REJECTED promise, deliberately — a synchronous throw would bypass the caller's
    // .catch() and crash the flow instead of showing the honest refusal on screen.
    commitBatch() {
      return Promise.reject(new ScannerNotConnectedError())
    },
  }
}
