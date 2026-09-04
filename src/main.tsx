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

// P101/D-111: no-ops unless the owner has configured VITE_CF_ANALYTICS_TOKEN — see
// src/analytics/cloudflareWebAnalytics.ts.
initCloudflareWebAnalytics()

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
