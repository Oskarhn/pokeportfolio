/**
 * The single definition of the debug-mode query param (P77 prompt §13, P79): explicit,
 * preview-only, reachable only by deliberately typing `?scannerDebug=1` into the URL — never
 * shown by default, never gated behind anything a real user could stumble into. `ScannerPage`
 * (which panel to render) and `controller.ts` (whether to pay the extra cost of collecting
 * debug-only image previews and a wider raw visual shortlist) both read this SAME function so the
 * two can never drift out of agreement about whether a session is a debug session.
 */
export function isScannerDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('scannerDebug') === '1'
}
