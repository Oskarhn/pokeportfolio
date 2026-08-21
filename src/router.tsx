import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router'
import { AppShell } from './ui/AppShell'
import { RedirectIfSignedIn, RequireAdmin, RequireSession } from './auth/guards'
import { LoginPage } from './features/auth/LoginPage'
import { InvitePage } from './features/auth/InvitePage'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from './features/auth/ResetPasswordPage'
import { InvitationsPage } from './features/admin/InvitationsPage'
import { HomePage } from './features/home/HomePage'
import { CatalogPage } from './features/catalog/CatalogPage'
import { CardDetailPage } from './features/catalog/CardDetailPage'
import { CollectionPage } from './features/collection/CollectionPage'
import { HoldingDetailPage } from './features/collection/HoldingDetailPage'
import { AddToCollectionPage } from './features/collection/AddToCollectionPage'
import { ManualCardPage } from './features/collection/ManualCardPage'

/**
 * Three route classes (docs/UX_FLOWS.md):
 *
 *   public     /login, /invite/$token, /forgot-password, /reset-password
 *   protected  /, /catalog, /catalog/$cardId, /collection, /collection/$holdingId,
 *              /collection/manual/new, /add
 *   admin      /admin/invitations
 *
 * The guards wrap components rather than running in `beforeLoad` because the session is restored
 * asynchronously from storage: a loader-time check would have to either block first paint or race
 * the restore. A wrapper renders a skeleton until the answer is known, which is the honest
 * representation of "we do not know yet".
 */

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
    <RequireSession>
      <HomePage />
    </RequireSession>
  ),
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => (
    <RedirectIfSignedIn>
      <LoginPage />
    </RedirectIfSignedIn>
  ),
})

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InvitePage,
})

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: ForgotPasswordPage,
})

// Not wrapped in RedirectIfSignedIn: arriving here *with* a session is the success case, because
// the recovery link established one.
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  component: ResetPasswordPage,
})

const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/catalog',
  component: () => (
    <RequireSession>
      <CatalogPage />
    </RequireSession>
  ),
})

const catalogCardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/catalog/$cardId',
  component: () => (
    <RequireSession>
      <CardDetailPage />
    </RequireSession>
  ),
})

const collectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collection',
  component: () => (
    <RequireSession>
      <CollectionPage />
    </RequireSession>
  ),
})

const collectionHoldingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collection/$holdingId',
  component: () => (
    <RequireSession>
      <HoldingDetailPage />
    </RequireSession>
  ),
})

const manualCardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collection/manual/new',
  component: () => (
    <RequireSession>
      <ManualCardPage />
    </RequireSession>
  ),
})

interface AddSearch {
  variantId?: string
  manualCardId?: string
}

const addRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/add',
  validateSearch: (search: Record<string, unknown>): AddSearch => ({
    variantId: typeof search.variantId === 'string' ? search.variantId : undefined,
    manualCardId: typeof search.manualCardId === 'string' ? search.manualCardId : undefined,
  }),
  component: () => (
    <RequireSession>
      <AddToCollectionPage />
    </RequireSession>
  ),
})

const adminInvitationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/invitations',
  component: () => (
    <RequireAdmin>
      <InvitationsPage />
    </RequireAdmin>
  ),
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  inviteRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  catalogRoute,
  catalogCardRoute,
  collectionRoute,
  collectionHoldingRoute,
  manualCardRoute,
  addRoute,
  adminInvitationsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
