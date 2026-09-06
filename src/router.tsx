import { lazy, Suspense } from 'react'
import {
  createRootRoute,
  createRoute,
  createRouter,
  ErrorComponent,
  Outlet,
  redirect,
  type ErrorComponentProps,
} from '@tanstack/react-router'
import { AppShell } from './ui/AppShell'
import { Button } from './ui/form'
import { isChunkLoadFailure } from './platform/build-freshness'
import { hasAnyUnsavedWork } from './platform/unsaved-work-registry'
import { RedirectIfSignedIn, RequireAdmin, RequireSession } from './auth/guards'
import { LoginPage } from './features/auth/LoginPage'
import { InvitePage } from './features/auth/InvitePage'
import { ForgotPasswordPage } from './features/auth/ForgotPasswordPage'
import { ResetPasswordPage } from './features/auth/ResetPasswordPage'
import { HomePage } from './features/home/HomePage'
import { PrivacyPage } from './features/legal/PrivacyPage'
import { TermsPage } from './features/legal/TermsPage'
import { FaqPage } from './features/legal/FaqPage'
import { NotFoundPage } from './features/legal/NotFoundPage'
import { isDashboardRange, type DashboardRange } from './domain/dashboard'
import { ProfilePage } from './features/profile/ProfilePage'
import type { CardCondition, Grader, HoldingKind, SealedIntent } from './data/collection'
import type { PortfolioSortOrder, SealedProductType } from './data/portfolio'
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
const AddSealedProductPage = lazy(() =>
  import('./features/collection/AddSealedProductPage').then((m) => ({
    default: m.AddSealedProductPage,
  })),
)
const SealedProductDetailPage = lazy(() =>
  import('./features/catalog/SealedProductDetailPage').then((m) => ({
    default: m.SealedProductDetailPage,
  })),
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
const MarketMoversPage = lazy(() =>
  import('./features/portfolio/MarketMoversPage').then((m) => ({ default: m.MarketMoversPage })),
)
const SaleFormPage = lazy(() =>
  import('./features/sales/SaleFormPage').then((m) => ({ default: m.SaleFormPage })),
)
const SaleDetailPage = lazy(() =>
  import('./features/sales/SaleDetailPage').then((m) => ({ default: m.SaleDetailPage })),
)
const SaleEditPage = lazy(() =>
  import('./features/sales/SaleEditPage').then((m) => ({ default: m.SaleEditPage })),
)
const HistoryPage = lazy(() =>
  import('./features/history/HistoryPage').then((m) => ({ default: m.HistoryPage })),
)
const ExportPage = lazy(() =>
  import('./features/export/ExportPage').then((m) => ({ default: m.ExportPage })),
)
const OpeningsWizardPage = lazy(() =>
  import('./features/openings/OpeningsWizardPage').then((m) => ({
    default: m.OpeningsWizardPage,
  })),
)
const OpeningDetailPage = lazy(() =>
  import('./features/openings/OpeningDetailPage').then((m) => ({
    default: m.OpeningDetailPage,
  })),
)
// M15 scanner UI (P66). Route exists behind feature wiring so the flow is exercisable and E2E-
// guardable; NO navigation entry advertises it yet — recognition is still the placeholder
// controller until P68 integrates the real engine. P68 owns flipping Quick Add/Search entries
// and any final route move.
const ScannerPage = lazy(() =>
  import('./features/scanner/ScannerPage').then((m) => ({ default: m.ScannerPage })),
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
 * Root-level error fallback (P83 §3/§7, D-100). Before this session, ANY thrown render error —
 * including a lazy-route `import()` rejecting because this deployment no longer has that chunk —
 * fell through to TanStack Router's own generic default (the "Something went wrong!" screen the
 * owner saw pressing the scanner's X button, P83 §0). A chunk-load failure now gets a distinct,
 * honest message instead of a framework-generic one; every other render error still gets
 * TanStack's own `ErrorComponent` unchanged, so this is additive, not a general error-UX rewrite.
 *
 * `initBuildFreshnessWatch()` (main.tsx) already tries to recover a chunk-load failure caught via
 * `vite:preloadError`/`unhandledrejection` BEFORE it becomes a React render error at all; this is
 * the backstop for whichever failure shape reaches React first — a route already reset by
 * `main.tsx`'s reload will unmount this before it ever renders.
 *
 * P101 launch-readiness addendum: the non-chunk-load branch used TanStack's own `ErrorComponent`
 * unmodified (D-100's deliberate scope limit, kept as-is here). That component ships a "Show
 * Error" toggle that renders the raw error/stack on click **in every environment, including a
 * production build** — a real "raw exception text" leak, not a hypothetical one. Gating it to
 * `import.meta.env.DEV` closes that without touching D-100's chunk-load-vs-generic split or any
 * of the P89 unsaved-work logic below.
 */
function AppErrorComponent(props: ErrorComponentProps) {
  if (!isChunkLoadFailure(props.error)) {
    if (import.meta.env.DEV) {
      return <ErrorComponent {...props} />
    }
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 py-10 text-center">
        <p className="text-lg font-semibold text-slate-100">Something went wrong</p>
        <p className="text-sm text-slate-400">
          This page hit an unexpected error. Reloading usually fixes it — nothing in your Portfolio
          was affected.
        </p>
        <Button
          type="button"
          className="max-w-xs"
          onClick={() => {
            window.location.reload()
          }}
        >
          Reload
        </Button>
      </div>
    )
  }
  // F-40 (P89): the registry-wide check, not the scanner alone — any unsaved form on any route
  // must block the automatic reload button exactly like an unsaved scan does.
  const unsaved = hasAnyUnsavedWork()
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 py-10 text-center">
      <p className="text-lg font-semibold text-slate-100">A new version is available</p>
      <p className="text-sm text-slate-400">
        {unsaved
          ? 'This page belongs to an older version of the app. Save or cancel what you were doing, then reload.'
          : 'This page belongs to an older version of the app. Reload to get the current one.'}
      </p>
      {unsaved ? null : (
        <Button
          type="button"
          className="max-w-xs"
          onClick={() => {
            window.location.reload()
          }}
        >
          Reload now
        </Button>
      )}
    </div>
  )
}

/**
 * Three route classes (docs/UX_FLOWS.md):
 *
 *   public     /login, /invite/$token, /forgot-password, /reset-password, /privacy, /terms, /faq
 *              (only /privacy, /terms, /faq are crawlable — public/robots.txt disallows the rest;
 *              /invite/$token and /reset-password carry live tokens and must never be indexed)
 *   protected  /, /catalog, /catalog/$cardId, /catalog/sets/$setId,
 *              /catalog/sealed/$sealedProductId, /portfolio, /portfolio/$holdingId,
 *              /portfolio/manual/new, /portfolio/sealed/new, /add, /profile, /profile/export
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
  // P101: there was no custom 404 before this — an unmatched path fell through to TanStack
  // Router's own bare default. Renders inside AppShell like every other route (so a signed-in
  // person mistyping a path still sees their own nav chrome, not a bare page).
  notFoundComponent: NotFoundPage,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // M12a: the chart range lives in the URL like every other per-view control (the
  // /market-movers precedent), so a selected range survives reload/back-navigation instead of
  // silently snapping back to the default. Anything invalid means "use the default".
  validateSearch: (search: Record<string, unknown>): { range?: DashboardRange } => ({
    range: isDashboardRange(search.range) ? search.range : undefined,
  }),
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

// P101: the only three routes genuinely meant to be public — reachable signed-out or signed-in,
// listed in public/sitemap.xml and allowed in public/robots.txt. Not lazy: tiny, and above the
// fold for whatever crawls them.
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/privacy',
  component: PrivacyPage,
})

const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/terms',
  component: TermsPage,
})

const faqRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/faq',
  component: FaqPage,
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
  // M9.1 (prompt §16-17): the selected variant for valuation/history lives in the URL, not a
  // global store, so refresh/back-navigation/a shared link all land on the same variant.
  validateSearch: (search: Record<string, unknown>): { variantId?: string } => ({
    variantId: str(search.variantId),
  }),
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

const catalogSealedProductRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/catalog/sealed/$sealedProductId',
  component: () => (
    <RequireSession>
      <SealedProductDetailPage />
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
  /** M11's type filter (All/Raw/Graded/Sealed) and the two sealed-only refinements it reveals. */
  holdingKind?: HoldingKind
  sealedProductType?: SealedProductType
  sealedIntent?: SealedIntent
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
    holdingKind: str(search.holdingKind) as HoldingKind | undefined,
    sealedProductType: str(search.sealedProductType) as SealedProductType | undefined,
    sealedIntent: str(search.sealedIntent) as SealedIntent | undefined,
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

interface AddSealedSearch {
  sealedProductId?: string
}

const addSealedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portfolio/sealed/new',
  validateSearch: (search: Record<string, unknown>): AddSealedSearch => ({
    sealedProductId: str(search.sealedProductId),
  }),
  component: () => (
    <RequireSession>
      <AddSealedProductPage />
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

// ── M13: export/backup, reached from Profile's Data section (UX_FLOWS.md F11 — Settings ›
// Export), deliberately not a new primary-nav destination.

const profileExportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile/export',
  component: () => (
    <RequireSession>
      <ExportPage />
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
  validateSearch: (search: Record<string, unknown>): { created?: boolean } => ({
    created: bool(search.created),
  }),
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

const marketMoversRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/market-movers',
  // M9.1 (prompt §18-23): period/sort live in the URL, same pattern as Portfolio's filters.
  validateSearch: (
    search: Record<string, unknown>,
  ): { period?: '1' | '7' | '30'; sort?: string } => ({
    period: str(search.period) as '1' | '7' | '30' | undefined,
    sort: str(search.sort),
  }),
  component: () => (
    <RequireSession>
      <MarketMoversPage />
    </RequireSession>
  ),
})

// ── M10: the sale ledger and History. Not primary-nav destinations (prompt §15/§55) — reached via
// the central + menu, Portfolio's select mode ("Sell selected"), a Holding Detail's "Sell" button,
// and History's own "Record sale" entries.

const salesNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sales/new',
  validateSearch: (
    search: Record<string, unknown>,
  ): { holdingId?: string; holdingIds?: string } => ({
    holdingId: str(search.holdingId),
    holdingIds: str(search.holdingIds),
  }),
  component: () => (
    <RequireSession>
      <SaleFormPage />
    </RequireSession>
  ),
})

const saleDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sales/$saleId',
  validateSearch: (search: Record<string, unknown>): { created?: boolean } => ({
    created: bool(search.created),
  }),
  component: () => (
    <RequireSession>
      <SaleDetailPage />
    </RequireSession>
  ),
})

const saleEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sales/$saleId/edit',
  component: () => (
    <RequireSession>
      <SaleEditPage />
    </RequireSession>
  ),
})

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  // P43: the unified History feed. kind filters by event source, voided reveals
  // corrected/voided entries (presentation only — never an accounting change).
  // M16: 'opening' joins the kind union (20260902120020).
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    kind?: 'purchase' | 'sale' | 'opening' | 'acquisition' | 'valuation'
    voided?: boolean
  } => ({
    kind: str(search.kind) as
      'purchase' | 'sale' | 'opening' | 'acquisition' | 'valuation' | undefined,
    voided: bool(search.voided),
  }),
  component: () => (
    <RequireSession>
      <HistoryPage />
    </RequireSession>
  ),
})

const legacyMoreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/more',
  beforeLoad: () => redirect({ to: '/profile' }),
})

// ── M16 (openings): the wizard and its detail page. Not primary-nav destinations — reached via a
// sealed Holding Detail's "Open" action, the central + menu's "Open sealed product", and History's
// opening rows. `holdingId`/`lotId` preselect the source when arriving from Holding Detail
// (prompt §7); the wizard still asks when several lots could be meant.

interface OpeningsNewSearch {
  holdingId?: string
  lotId?: string
}

const openingsNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/openings/new',
  validateSearch: (search: Record<string, unknown>): OpeningsNewSearch => ({
    holdingId: str(search.holdingId),
    lotId: str(search.lotId),
  }),
  component: () => (
    <RequireSession>
      <OpeningsWizardPage />
    </RequireSession>
  ),
})

const openingDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/openings/$openingId',
  validateSearch: (search: Record<string, unknown>): { created?: boolean } => ({
    created: bool(search.created),
  }),
  component: () => (
    <RequireSession>
      <OpeningDetailPage />
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

const scannerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scan',
  component: () => (
    <RequireSession>
      <ScannerPage />
    </RequireSession>
  ),
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  inviteRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  privacyRoute,
  termsRoute,
  faqRoute,
  catalogRoute,
  catalogCardRoute,
  catalogSetRoute,
  catalogSealedProductRoute,
  portfolioRoute,
  portfolioHoldingRoute,
  manualCardRoute,
  addSealedRoute,
  legacyCollectionRoute,
  legacyCollectionHoldingRoute,
  legacyManualCardRoute,
  addRoute,
  purchasesRoute,
  purchaseNewRoute,
  purchaseDetailRoute,
  purchaseEditRoute,
  marketMoversRoute,
  salesNewRoute,
  saleDetailRoute,
  saleEditRoute,
  historyRoute,
  openingsNewRoute,
  openingDetailRoute,
  profileRoute,
  profileExportRoute,
  scannerRoute,
  legacyMoreRoute,
  adminInvitationsRoute,
])

export const router = createRouter({ routeTree, defaultErrorComponent: AppErrorComponent })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
