/**
 * Immutable build identity (P83, D-100).
 *
 * A real-iPhone P82 test returned an OLD diagnostics schema and OLD capture dimensions with no
 * way to tell whether the phone was running stale JavaScript or the current build had regressed —
 * it turned out to be a stale deployment. `APP_BUILD_SHA` lets any debug session prove which
 * commit produced the code actually running BEFORE trusting a scanner result (P83 §15/§21).
 *
 * Values come from `vite.config.ts`'s `define` (same pattern as the existing `__APP_VERSION__`);
 * see src/vite-env.d.ts for the ambient declarations.
 */
export const APP_BUILD_SHA: string =
  typeof __APP_BUILD_SHA__ === 'string' ? __APP_BUILD_SHA__ : 'unknown'

export const APP_BUILD_TIME: string =
  typeof __APP_BUILD_TIME__ === 'string' ? __APP_BUILD_TIME__ : 'unknown'

/**
 * Bumped whenever the SHAPE of `ScannerDiagnostics`/its plain-text rendering changes in a way
 * that would make an old paste incomparable to a new one — an integer, not tied to the app
 * version or commit, so a reviewer can tell "this diagnostics dump used a schema I don't
 * recognize" without cross-referencing a commit history.
 */
export const SCANNER_SCHEMA_VERSION = 1
