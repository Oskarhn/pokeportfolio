import { lazy, Suspense } from 'react'
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
import { HomePage } from './features/home/HomePage'
import { ProfilePage } from './features/profile/ProfilePage'
import type { CardCondition, Grader } from './data/collection'
import type { PortfolioSortOrder } from './data/portfolio'
import type { CollectionView } from './data/profile'

// Route-level code splitting (M7.1 prompt §83 — bundle size, "if appropriate, not a separate
// milestone"): Home/Profile/auth screens are on every session's critical path and stay eager;
// everything reached by navigating further in — Search, Portfolio (which pulls in TanStack
// Virtual), holding detail/add flows, admin — loads on demand instead of inflating the bundle
// every signed-in user downloads just to see Home.
const CatalogPage = lazy(() =>
  import('./features/catalog/CatalogPage').then((m) => ({ default: m.CatalogPage })),
)
const CardDetailPage = lazy(() =>
  import('./features/catalog/CardDetailPage').then((m) => ({ default: m.CardDetailPage })),
)
const SetDetailPage = lazy(() =>
  import('./features/catalog/SetDetailPage').then((m) => ({ default: m.SetDetailPage })),
)
const PortfolioPage = lazy(() =>
  import('./features/portfolio/PortfolioPage').then((m) => ({ default: m.PortfolioPage })),
)
const HoldingDetailPage = lazy(() =>
  import('./features/collection/HoldingDetailPage').then((m) => ({
    default: m.HoldingDetailPage,
  })),
)
const AddToCollectionPage = lazy(() =>
  import('./features/collection/AddToCollectionPage').then((m) => ({
    default: m.AddToCollectionPage,
  })),
)
const ManualCardPage = lazy(() =>
  import('./features/collection/ManualCardPage').then((m) => ({ default: m.ManualCardPage })),
)
const InvitationsPage = lazy(() =>
  import('./features/admin/InvitationsPage').then((m) => ({ default: m.InvitationsPage })),
)
const PurchasesListPage = lazy(() =>
  import('./features/purchases/PurchasesListPage').then((m) => ({ default: m.PurchasesListPage })),
)
const PurchaseFormPage = lazy(() =>
  import('./features/purchases/PurchaseFormPage').then((m) => ({ default: m.PurchaseFormPage })),
)
const PurchaseDetailPage = lazy(() =>
  import('./features/purchases/PurchaseDetailPage').then((m) => ({
    default: m.PurchaseDetailPage,
  })),
)
const PurchaseEditPage = lazy(() =>
  import('./features/purchases/PurchaseEditPage').then((m) => ({ default: m.PurchaseEditPage })),
)

/** Matches the layout these pages render into (AppShell's `<main>`) closely enough that arriving
 *  content doesn't jump — a skeleton rather than a spinner-over-blank-region, per
 *  DESIGN_SYSTEM.md §7's loading-state rule. */
function RouteFallback() {
  return (
    <div className="mx-auto w-full max-w-2xl animate-pulse space-y-4 py-2">
      <div className="h-9 w-2/3 rounded-full bg-slate-800/60" />
      <div className="h-40 rounded-2xl bg-slate-800/60" />
    </div>
  )
}

/**
 * Three route classes (docs/UX_FLOWS.md):
 *
 *   public     /login, /invite/$token, /forgot-password, /reset-password
 *   protected  /, /catalog, /catalog/$cardId, /catalog/sets/$setId, /portfolio,
 *              /portfolio/$holdingId, /portfolio/manual/new, /add, /profile
 *   admin      /admin/invitations
 *
 * `/more` (M7) is gone as of M7.1 (owner decision: no More destination remains — its only real
 * content, admin invitations, moved into Profile). `/more` redirects to `/profile` rather than
 * disappearing, matching the established `/collection*` redirect pattern below.
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
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
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

// ── M8: the purchase ledger. Not a primary-nav destination (reached via the central + menu and a
// Home shortcut, UX_FLOWS.md F3/M8 prompt §15) — same "protected" route class as everything else
// behind RequireSession.

const purchasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/purchases',
  component: () => (
    <RequireSession>
      <PurchasesListPage />
    </RequireSession>
  ),
})

const purchaseNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/purchases/new',
  component: () => (
    <RequireSession>
      <PurchaseFormPage />
    </RequireSession>
  ),
})

const purchaseDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/purchases/$purchaseId',
  component: () => (
    <RequireSession>
      <PurchaseDetailPage />
    </RequireSession>
  ),
})

const purchaseEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/purchases/$purchaseId/edit',
  component: () => (
    <RequireSession>
      <PurchaseEditPage />
    </RequireSession>
  ),
})

const legacyMoreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/more',
  beforeLoad: () => redirect({ to: '/profile' }),
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
  purchasesRoute,
  purchaseNewRoute,
  purchaseDetailRoute,
  purchaseEditRoute,
  profileRoute,
  legacyMoreRoute,
  adminInvitationsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
