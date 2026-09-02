import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { AuthProvider } from './auth/AuthProvider'
import { router } from './router'
import { checkForNewDeployment, initBuildFreshnessWatch } from './platform/build-freshness-runtime'
import './styles/index.css'

// P83/D-100: subscribes to the zero-cost signals that a newer deployment than this bundle is
// already live (a new Service Worker taking control, or a lazy-chunk import failing because this
// deployment's file no longer exists) — see StaleDeploymentBanner.tsx for the resulting UI.
// Started before the first render so a chunk-load failure during the VERY FIRST route transition
// is still caught.
initBuildFreshnessWatch()

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
