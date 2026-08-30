/**
 * Stale-deployment detection and recovery policy (P83, D-100) — pure decision logic, kept
 * separate from the browser wiring (build-freshness-runtime.ts) so it is unit-testable without a
 * real Worker/ServiceWorker/window, following the same injected-non-pure-dependency shape as
 * domain/scanner/visual-backend-selection.ts.
 *
 * Two independent triggers feed the same policy:
 *  - `controllerchange`: a NEW Service Worker has taken control of this page (Workbox's
 *    `skipWaiting()`+`clientsClaim()`, vite.config.ts) — a real newer deployment exists, no
 *    network cost to learn it.
 *  - `chunk-load-failure`: a dynamic `import()` for a lazy route/module failed because the file no
 *    longer exists on the current deployment (Vite's own `vite:preloadError`, or an equivalent
 *    unhandled rejection) — reproduced directly against this project's live preview as a `200
 *    text/html` response for a missing hashed chunk (P83 §0/§2).
 *
 * Recovery is ONE controlled reload, never a silent one: a nonempty scanner batch blocks it
 * (P83 §7) — camera state and in-progress forms are the concrete examples the prompt names, and
 * this app's only real in-memory "unsaved work" today is the scanner batch (ScannerPage.tsx's
 * useBlocker already treats it as unsaved for SPA navigation; this extends the same treatment to
 * a hard reload). A reload already attempted recently is not repeated (P83 §7/§9 — no reload
 * loops) — the caller surfaces a manual prompt instead either way.
 */

const CHUNK_LOAD_FAILURE_PATTERNS = [
  /dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /is not a valid javascript mime type/i,
  /unable to preload css/i,
  /failed to fetch dynamically imported module/i,
] as const

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * True for the specific error shapes a stale client's lazy-chunk request produces — Vite's
 * `vite:preloadError` payload, a bare `TypeError` from `import()`, or the MIME-type message the
 * owner's real device actually showed. Never matches an unrelated application error, so a genuine
 * bug is not mislabelled as "you need to reload".
 */
export function isChunkLoadFailure(error: unknown): boolean {
  const message = errorMessage(error)
  if (message === '') return false
  return CHUNK_LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(message))
}

export type StaleDeploymentTrigger =
  'controllerchange' | 'chunk-load-failure' | 'newer-deployment-detected'

/** The one outcome the app takes for a detected trigger. */
export type StaleDeploymentAction = 'reload' | 'prompt'

/** How long a just-attempted reload suppresses another automatic one (P83 §9 — no reload loop). */
export const RELOAD_LOOP_GUARD_MS = 15_000

export interface BuildFreshnessDeps {
  hasUnsavedWork: () => boolean
  now: () => number
  readLastReloadAt: () => number | null
  writeLastReloadAt: (at: number) => void
  reload: () => void
}

/**
 * Decides — and, for the `'reload'` outcome, PERFORMS — the recovery action for one detected
 * stale-deployment trigger. Pure given its injected deps: real time/storage/`location.reload` are
 * wired in build-freshness-runtime.ts; tests pass fakes (P83 §16 S6/S7/S9).
 */
export function resolveStaleDeploymentAction(deps: BuildFreshnessDeps): StaleDeploymentAction {
  if (deps.hasUnsavedWork()) {
    return 'prompt'
  }
  const lastReloadAt = deps.readLastReloadAt()
  const now = deps.now()
  if (lastReloadAt !== null && now - lastReloadAt < RELOAD_LOOP_GUARD_MS) {
    // Already tried an automatic reload very recently and we are STILL seeing a stale-deployment
    // trigger — reloading again would loop. Surface the manual prompt instead.
    return 'prompt'
  }
  deps.writeLastReloadAt(now)
  deps.reload()
  return 'reload'
}
