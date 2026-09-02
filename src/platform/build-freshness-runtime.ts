/**
 * Browser wiring for build-freshness.ts's pure policy (P83, D-100) — real
 * ServiceWorker/window/sessionStorage/fetch, and the tiny external-store shape
 * StaleDeploymentBanner.tsx reads via `useSyncExternalStore`. Kept out of build-freshness.ts so
 * that module stays a pure, dependency-injected decision function (tests/platform/
 * build-freshness.test.ts exercises it directly, no DOM required).
 */
import { APP_BUILD_SHA } from './build-info'
import {
  isChunkLoadFailure,
  resolveStaleDeploymentAction,
  type BuildFreshnessDeps,
  type StaleDeploymentAction,
  type StaleDeploymentTrigger,
} from './build-freshness'
import { hasAnyUnsavedWork } from './unsaved-work-registry'

const LAST_RELOAD_STORAGE_KEY = 'pp-stale-reload-last-at'
const BUILD_META_CHECK_COOLDOWN_MS = 60_000

export interface StaleDeploymentState {
  trigger: StaleDeploymentTrigger | null
  action: StaleDeploymentAction | null
}

let state: StaleDeploymentState = { trigger: null, action: null }
const listeners = new Set<() => void>()

function setState(next: StaleDeploymentState): void {
  state = next
  listeners.forEach((listener) => {
    listener()
  })
}

/** Subscribe/snapshot pair matching React's `useSyncExternalStore` contract. */
export function subscribeStaleDeployment(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStaleDeploymentSnapshot(): StaleDeploymentState {
  return state
}

/** Test-only reset — production code never needs to un-detect a stale deployment mid-session. */
export function resetStaleDeploymentStateForTests(): void {
  state = { trigger: null, action: null }
}

/**
 * Re-runs the recovery decision for the already-detected trigger — StaleDeploymentBanner.tsx's
 * "Reload now" button calls this after the owner has saved/cancelled a scanner batch, so the
 * SAME unsaved-work check runs again rather than the button unconditionally forcing a reload.
 * A no-op if nothing has been detected yet.
 */
export function retryStaleDeploymentAction(): void {
  if (state.trigger === null) return
  handleTrigger(state.trigger)
}

function realDeps(): BuildFreshnessDeps {
  return {
    // F-40 (P89): the union of every registered source, not the scanner alone (see
    // unsaved-work-registry.ts's header for the regression this closes).
    hasUnsavedWork: hasAnyUnsavedWork,
    now: () => Date.now(),
    readLastReloadAt: () => {
      try {
        const raw = sessionStorage.getItem(LAST_RELOAD_STORAGE_KEY)
        return raw === null ? null : Number(raw)
      } catch {
        return null
      }
    },
    writeLastReloadAt: (at) => {
      try {
        sessionStorage.setItem(LAST_RELOAD_STORAGE_KEY, String(at))
      } catch {
        // Private-mode/quota storage denial must never block the reload itself.
      }
    },
    reload: () => {
      window.location.reload()
    },
  }
}

function handleTrigger(trigger: StaleDeploymentTrigger): void {
  const action = resolveStaleDeploymentAction(realDeps())
  setState({ trigger, action })
}

let lastBuildMetaCheckAt = 0

/**
 * Fetches `/build-meta.json` (network-only — `_headers` marks it `no-store`, and we bypass the
 * HTTP cache explicitly here too) and compares its `sha` against this bundle's own
 * `APP_BUILD_SHA`. Rate-limited to once per `BUILD_META_CHECK_COOLDOWN_MS` regardless of how often
 * the caller invokes it — P83 §6's "no polling every few seconds" requirement — so callers can
 * wire it to cheap, frequent checkpoints (route change, tab-visible) without producing traffic
 * beyond that floor.
 */
export async function checkForNewDeployment(): Promise<void> {
  const now = Date.now()
  if (now - lastBuildMetaCheckAt < BUILD_META_CHECK_COOLDOWN_MS) return
  lastBuildMetaCheckAt = now
  try {
    const response = await fetch('/build-meta.json', { cache: 'no-store' })
    if (!response.ok) return
    const meta: unknown = await response.json()
    const latestSha = typeof meta === 'object' && meta !== null && 'sha' in meta ? meta.sha : null
    if (typeof latestSha === 'string' && latestSha !== APP_BUILD_SHA) {
      handleTrigger('newer-deployment-detected')
    }
  } catch {
    // Offline, or the request was blocked — the controllerchange/chunk-failure signals below
    // still catch a genuinely stale client; this check is defense in depth, not the only signal.
  }
}

/**
 * Subscribes to the two zero/near-zero-cost real signals a newer deployment exists. Call once
 * from main.tsx; returns an unsubscribe (tests use it, production never needs to call it).
 */
export function initBuildFreshnessWatch(): () => void {
  const cleanups: Array<() => void> = []

  if ('serviceWorker' in navigator) {
    // `controllerchange` fires the FIRST time a page ever becomes controlled by a Service
    // Worker too (Workbox's `clientsClaim()` claims every open client the instant it activates,
    // including a page that had NO controller at all a moment earlier) — every fresh browser
    // context (every real first install, every Playwright test) would otherwise trigger an
    // unwanted automatic reload that has nothing to do with a stale deployment. Reproduced
    // directly: adding this listener unguarded broke two unrelated auth E2E specs by reloading
    // the page mid-test. Only a controllerchange AFTER this page already had a controller — a
    // DIFFERENT, newer Service Worker taking over from one that was already active — is a real
    // "a newer deployment exists" signal; the very first transition (no controller → a
    // controller) is normal first-activation and is deliberately ignored exactly once.
    let hadController = navigator.serviceWorker.controller !== null
    const onControllerChange = () => {
      if (!hadController) {
        hadController = true
        return
      }
      handleTrigger('controllerchange')
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    cleanups.push(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    })
  }

  // Vite's own event for a dynamic import() that failed to load (vite.dev/guide/build.html) —
  // fires for exactly the "old page, chunk the new deployment no longer serves" failure P83 §0
  // reproduced on the owner's real iPhone. preventDefault() suppresses Vite's own rethrow; our
  // recovery action (reload, or the manual prompt) replaces it.
  const onPreloadError = (event: Event) => {
    event.preventDefault()
    handleTrigger('chunk-load-failure')
  }
  window.addEventListener('vite:preloadError', onPreloadError)
  cleanups.push(() => {
    window.removeEventListener('vite:preloadError', onPreloadError)
  })

  // Defense in depth: an engine/code path that rejects the same failure without going through
  // Vite's own preload wrapper still gets classified and recovered instead of surfacing as a raw
  // uncaught-rejection console error with no user-facing recovery at all.
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isChunkLoadFailure(event.reason)) {
      handleTrigger('chunk-load-failure')
    }
  }
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  cleanups.push(() => {
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  })

  // F-41 (P89): checkForNewDeployment() (the build-meta.json polling path) previously existed
  // fully built and tested but was never actually CALLED from any production code path — so a
  // long-lived tab that never triggers controllerchange/vite:preloadError (navigates only via
  // already-cached in-app links) got no freshness signal at all. Wired here to the cheapest real
  // checkpoint: the tab becoming visible again (tab-switch back, app foregrounded on mobile) —
  // its own ≤1/60s internal rate limit already bounds the cost regardless of how often this
  // fires. `typeof document` guards the same Node-test-environment shape every other browser-only
  // check in this codebase uses (this file's own header already runs under `environment: 'node'`
  // with only window/navigator/sessionStorage/fetch normally stubbed).
  if (typeof document !== 'undefined') {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkForNewDeployment()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    cleanups.push(() => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    })
  }

  return () => {
    cleanups.forEach((cleanup) => {
      cleanup()
    })
  }
}
