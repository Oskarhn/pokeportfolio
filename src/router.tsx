import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router'
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
import { SetDetailPage } from './features/catalog/SetDetailPage'
import { PortfolioPage } from './features/portfolio/PortfolioPage'
import { HoldingDetailPage } from './features/collection/HoldingDetailPage'
import { AddToCollectionPage } from './features/collection/AddToCollectionPage'
import { ManualCardPage } from './features/collection/ManualCardPage'
import { ProfilePage } from './features/profile/ProfilePage'
import { MorePage } from './features/more/MorePage'
import type { CardCondition, Grader } from './data/collection'
import type { PortfolioSortOrder } from './data/portfolio'
import type { CollectionView } from './data/profile'

/**
 * Three route classes (docs/UX_FLOWS.md):
 *
 *   public     /login, /invite/$token, /forgot-password, /reset-password
 *   protected  /, /catalog, /catalog/$cardId, /catalog/sets/$setId, /portfolio,
 *              /portfolio/$holdingId, /portfolio/manual/new, /add, /profile, /more
 *   admin      /admin/invitations
 *
 * The guards wrap components rather than running in `beforeLoad` because the session is restored
 * asynchronously from storage: a loader-time check would have to either block first paint or race
 * the restore. A wrapper renders a skeleton until the answer is known, which is the honest
 * representation of "we do not know yet".
 *
 * `/portfolio` is the canonical user-facing route as of M7 (owner decision: user-facing naming is
 * "Portfolio", not "Collection" — PRODUCT_SPEC.md/UX_FLOWS.md). `/collection*` paths from M6
 * redirect rather than disappearing, so no deep link anyone already holds breaks (M7 prompt §8).
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

const catalogSetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/catalog/sets/$setId',
  component: () => (
    <RequireSession>
      <SetDetailPage />
    </RequireSession>
  ),
})

/** M7 Portfolio search params — sort/view/density/filters. Plain object validators, no schema
 *  library, following the same convention `/add`'s AddSearch already established. Undefined means
 *  "use the profile default" (density/view/sort) or "no filter" (everything else) — never a
 *  fabricated default baked into the URL itself, so a shared link stays meaningful even after the
 *  owner's own defaults change later. */
export interface PortfolioSearch {
  sort?: PortfolioSortOrder
  view?: CollectionView
  density?: number
  collectionId?: string
  q?: string
  setId?: string
  condition?: CardCondition
  graded?: boolean
  grader?: Grader
  favorite?: boolean
  language?: string
  manualOnly?: boolean
  storageLocationId?: string
  tagId?: string
  lowValue?: boolean
  missingValue?: boolean
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portfolio',
  validateSearch: (search: Record<string, unknown>): PortfolioSearch => ({
    sort: str(search.sort) as PortfolioSortOrder | undefined,
    view: str(search.view) as CollectionView | undefined,
    density: num(search.density),
    collectionId: str(search.collectionId),
    q: str(search.q),
    setId: str(search.setId),
    condition: str(search.condition) as CardCondition | undefined,
    graded: bool(search.graded),
    grader: str(search.grader) as Grader | undefined,
    favorite: bool(search.favorite),
    language: str(search.language),
    manualOnly: bool(search.manualOnly),
    storageLocationId: str(search.storageLocationId),
    tagId: str(search.tagId),
    lowValue: bool(search.lowValue),
    missingValue: bool(search.missingValue),
  }),
  component: () => (
    <RequireSession>
      <PortfolioPage />
    </RequireSession>
  ),
})

const portfolioHoldingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portfolio/$holdingId',
  component: () => (
    <RequireSession>
      <HoldingDetailPage />
    </RequireSession>
  ),
})

const manualCardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portfolio/manual/new',
  component: () => (
    <RequireSession>
      <ManualCardPage />
    </RequireSession>
  ),
})

// ── Legacy /collection* redirects (M6 → M7 rename) — no deep link breaks. ─────────────────────

const legacyCollectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collection',
  beforeLoad: () => redirect({ to: '/portfolio' }),
})

const legacyCollectionHoldingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collection/$holdingId',
  beforeLoad: ({ params }) =>
    redirect({ to: '/portfolio/$holdingId', params: { holdingId: params.holdingId } }),
})

const legacyManualCardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collection/manual/new',
  beforeLoad: () => redirect({ to: '/portfolio/manual/new' }),
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

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: () => (
    <RequireSession>
      <ProfilePage />
    </RequireSession>
  ),
})

const moreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/more',
  component: () => (
    <RequireSession>
      <MorePage />
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
  catalogSetRoute,
  portfolioRoute,
  portfolioHoldingRoute,
  manualCardRoute,
  legacyCollectionRoute,
  legacyCollectionHoldingRoute,
  legacyManualCardRoute,
  addRoute,
  profileRoute,
  moreRoute,
  adminInvitationsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
