import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { AuthProvider } from './auth/AuthProvider'
import { router } from './router'
import { checkForNewDeployment, initBuildFreshnessWatch } from './platform/build-freshness-runtime'
import { cleanupObsoleteScannerCaches } from './platform/scanner-cache-cleanup'
import { initCloudflareWebAnalytics } from './analytics/cloudflareWebAnalytics'
import './styles/index.css'

// P101/D-118, route-gated since P110/D-119: no-ops unless the owner has configured
// VITE_CF_ANALYTICS_TOKEN AND the current location is on the public analytics allowlist — see
// src/analytics/cloudflareWebAnalytics.ts. Evaluated once now (covers a cold load landing directly
// on an eligible public page) and again after every completed navigation via the router
// subscription below (covers a session that starts on a private/public-but-ineligible route and
// later navigates to an eligible one — analytics initializes only once that is genuinely safe).
initCloudflareWebAnalytics(window.location)

// P83/D-100: subscribes to the zero-cost signals that a newer deployment than this bundle is
// already live (a new Service Worker taking control, or a lazy-chunk import failing because this
// deployment's file no longer exists) — see StaleDeploymentBanner.tsx for the resulting UI.
// Started before the first render so a chunk-load failure during the VERY FIRST route transition
// is still caught.
initBuildFreshnessWatch()

// P87 F-42: bounded, best-effort deletion of scanner Cache Storage entries left behind by a
// version bump the Workbox precache-cleanup mechanism does not reach (see
// scanner-cache-cleanup.ts's own header for why this runs here instead of a Service Worker
// `activate` handler). Fire-and-forget — never blocks first render, never throws.
void cleanupObsoleteScannerCaches()

// F-41 (P89): the OTHER real checkpoint for checkForNewDeployment() (visibilitychange lives
// inside initBuildFreshnessWatch itself) — every completed client-side navigation is a cheap,
// frequent moment to ask "is a newer build live" without adding a poll loop; the function's own
// ≤1/60s internal rate limit is what actually bounds request volume, not how often this fires.
router.subscribe('onResolved', () => {
  void checkForNewDeployment()
})

// P110/D-119: re-evaluates analytics eligibility after every completed client-side navigation —
// `initCloudflareWebAnalytics` itself is idempotent (injects at most once per session) and
// re-checks the CURRENT location, so this only ever has an effect the first time a session
// reaches an eligible public route (private -> public). It never fires anything for a private
// route, and never re-fires once the one-time injection has already happened.
router.subscribe('onResolved', () => {
  initCloudflareWebAnalytics(window.location)
})

const queryClient = new QueryClient()

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
)
