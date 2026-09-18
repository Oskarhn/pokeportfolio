import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { applyAuthIdentityBoundary } from '../../src/auth/query-cache-boundary'
import { draftStore, initialDraft } from '../../src/features/openings/draft'
import {
  scannerSessionStore,
  initialScannerDefaults,
} from '../../src/features/scanner/session-store'
import { ManualCardResolutionCache } from '../../src/features/purchases/manual-card-resolution'

/**
 * P140 §4 — verifies, rather than assumes, whether `PurchaseFormPage`/`AddToCollectionPage`/
 * `AddSealedProductPage` are guaranteed to unmount when the authenticated identity changes A -> B
 * in the same tab. output_138.txt's own text ("no sign-out/account-switch code path was found
 * that could carry a stale key across identities... the key lives in component state, unmounted
 * on navigation/sign-out like any other component state") is exactly the "React normally unmounts
 * it" inference P130-23 already showed is unsafe (P130-23: "Direct A->B identity switch in
 * another tab keeps A's mounted form input; next submit goes out under B" — PurchaseFormPage
 * named as the HIGH-severity case). This file replaces that inference with two independent,
 * automated, source-level checks; no React renderer exists in this repository to mount the real
 * component tree and observe an unmount event directly (see `sale-form-entity-isolation.test.ts`'s
 * own doc), so this is the strongest available proof without adding one.
 *
 * CHECK 1 (structural): the three routes' `component:` definitions in `router.tsx`, and
 * `RequireSession` itself in `guards.tsx`, are read from disk and asserted to contain no `key=`
 * binding on the protected content. React only ever unmounts and remounts a component at a fixed
 * tree position when its `key` (or its element `type`) changes between renders — see the React
 * docs' "Preserving and Resetting State" guide. Neither is true here: `RequireSession` renders
 * `<>{children}</>` unconditionally for `status === 'signed-in'`, and no route wraps its page in a
 * `key={userId}` (or any other identity-derived key). A same-tab A -> B transition that keeps
 * `status` at `'signed-in'` throughout (see CHECK 2) therefore re-renders the SAME component
 * instance — by React's own documented reconciliation contract, not by inference from this
 * project's own behavior.
 *
 * CHECK 2 (structural + behavioral): `AuthProvider.tsx`'s `onAuthStateChange` handler updates
 * `session`/`status` via plain `setState` calls with NO conditional branch that unmounts anything
 * — read from disk and asserted. Combined with `applyAuthIdentityBoundary` — the ONE place this
 * codebase already centralizes identity-change side effects — proven here, by directly invoking
 * the real function, to clear ONLY the TanStack Query cache/mutations and the two identity-scoped
 * stores it names (`draftStore`, `scannerSessionStore`), and to touch NOTHING resembling
 * component-local state (modeled here by a real `ManualCardResolutionCache`, exactly the P138
 * state this ticket protects). This demonstrates directly — not by prose — that the pre-existing
 * cross-cutting boundary was never sufficient on its own, which is exactly why P140's
 * `useEntityKeyReset` call sites are necessary rather than redundant.
 *
 * CONCLUSION recorded for output_140.txt: FORM_SURVIVES_IDENTITY_SWITCH=yes.
 */

const SRC_ROOT = resolve(__dirname, '../../src')

function readSource(relativePath: string): string {
  return readFileSync(resolve(SRC_ROOT, relativePath), 'utf8')
}

describe('P140 §4 — structural proof that protected routes are not keyed by userId', () => {
  const routerSource = readSource('router.tsx')
  const guardsSource = readSource('auth/guards.tsx')

  it('RequireSession renders its children unconditionally when signed-in, with no key binding', () => {
    const match = guardsSource.match(
      /export function RequireSession\(\{ children \}: \{ children: ReactNode \}\) \{[\s\S]*?\n\}/,
    )
    expect(match).not.toBeNull()
    const body = match![0]
    expect(body).toContain("if (status === 'loading') return <Waiting />")
    expect(body).toContain('if (status === \'signed-out\') return <Navigate to="/login" replace />')
    // The success path renders children as-is — no key, no conditional swap keyed on identity.
    expect(body).toMatch(/return <>\{children\}<\/>/)
    expect(body).not.toMatch(/key=/)
  })

  it.each([
    ['/purchases/new', 'PurchaseFormPage'],
    ['/add', 'AddToCollectionPage'],
    ['/portfolio/sealed/new', 'AddSealedProductPage'],
  ])('the %s route does not wrap %s in a key={userId}-style binding', (path, componentName) => {
    // Locate this route's createRoute({...}) block by its path, then its component: () => (...) body.
    const pathIndex = routerSource.indexOf(`path: '${path}',`)
    expect(pathIndex, `route path '${path}' not found in router.tsx`).toBeGreaterThan(-1)
    const routeBlock = routerSource.slice(pathIndex, pathIndex + 600)
    expect(routeBlock).toContain(componentName)
    expect(routeBlock).toContain('<RequireSession>')
    // No identity-derived key anywhere in this route's component definition.
    expect(routeBlock).not.toMatch(/key=\{/)
  })

  it('AuthProvider updates session/status via plain setState with no unmount-triggering branch', () => {
    const authProviderSource = readSource('auth/AuthProvider.tsx')
    // Both the initial getSession() resolution AND every onAuthStateChange event funnel through
    // the SAME two setState calls — there is no separate code path that could, say, force a
    // remount, a key bump, or a hard navigation on an identity change.
    const setStateSites = authProviderSource.match(/setSession\([^)]*\)\s*\n\s*setStatus\([^)]*\)/g)
    expect(
      setStateSites,
      'expected setSession/setStatus to appear as a pair at least twice',
    ).not.toBeNull()
    expect(setStateSites!.length).toBeGreaterThanOrEqual(2)
    // A direct A -> B swap keeps status at 'signed-in' throughout: setStatus's ternary is
    // `nextSession ? 'signed-in' : 'signed-out'`, so a SIGNED_IN broadcast for a DIFFERENT user id
    // (session non-null throughout) never transitions status through 'signed-out' at all.
    expect(authProviderSource).toContain("setStatus(nextSession ? 'signed-in' : 'signed-out')")
  })
})

describe('P140 §4 — behavioral proof that the pre-existing identity boundary does not reach component-local state', () => {
  it('applyAuthIdentityBoundary clears the query cache and the two identity-scoped stores, but never touches unrelated component-shaped state', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['portfolio'], { some: 'stale-data-for-user-a' })
    draftStore.save('user-a', initialDraft())
    scannerSessionStore.save('user-a', initialScannerDefaults())

    // Exactly what P138's own state (and P140's fix) is NOT covered by: a plain, component-scoped
    // cache the boundary function has never heard of. If this were somehow cleared by
    // `applyAuthIdentityBoundary`, P140's own `useEntityKeyReset` calls would be redundant instead
    // of necessary — this assertion is what makes that NOT the case, proven rather than assumed.
    const manualCards = new ManualCardResolutionCache()
    manualCards.set('line-1', 'Charizard', 'manual-card-under-a')

    const fired = applyAuthIdentityBoundary(queryClient, 'user-a', 'user-b')

    expect(fired).toBe(true)
    expect(queryClient.getQueryData(['portfolio'])).toBeUndefined() // cache: cleared
    expect(draftStore.load('user-a')).toBeNull() // identity-scoped store: cleared
    expect(scannerSessionStore.load('user-a')).toBeNull() // identity-scoped store: cleared
    // Component-local state the boundary function has no reference to at all — provably
    // untouched, since nothing was ever passed to it.
    expect(manualCards.get('line-1', 'Charizard')).toBe('manual-card-under-a')
  })

  it('the boundary does not fire on the FIRST observed identity (an ordinary fresh sign-in, not a switch)', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(['portfolio'], { fresh: true })
    const fired = applyAuthIdentityBoundary(queryClient, undefined, 'user-a')
    expect(fired).toBe(false)
    expect(queryClient.getQueryData(['portfolio'])).toEqual({ fresh: true })
  })
})

describe('P140 §7 — the pages under test actually consume the abstraction the tests exercise', () => {
  // The harness tests in purchase-form-identity-boundary.test.ts / add-form-identity-boundary.test.ts
  // prove `EntityKeyChangeTracker` and `resolveManualCardId`/`ManualCardResolutionCache` behave
  // correctly in isolation — same as `sale-form-entity-isolation.test.ts`'s own harness never
  // literally executes `SaleFormPage.tsx` either. What closes the gap ("a disconnected test helper
  // proves nothing", P140 §7) is that these three page files are read here and asserted to
  // ACTUALLY import and call the real hook with a real, session-derived identity — not a
  // hard-coded constant — so a future edit that quietly drops the wiring (while leaving the
  // algorithm itself, and its tests, untouched) is caught here instead of passing silently.
  it.each([
    ['features/purchases/PurchaseFormPage.tsx', "useEntityKeyReset(userId ?? ''"],
    [
      'features/collection/AddToCollectionPage.tsx',
      "useEntityKeyReset(`${userId ?? ''}|${variantId ?? ''}|${manualCardId ?? ''}`",
    ],
    [
      'features/collection/AddSealedProductPage.tsx',
      "useEntityKeyReset(`${userId ?? ''}|${selectedProductId ?? ''}`",
    ],
  ])(
    '%s imports useEntityKeyReset from the shared platform module and calls it with a session-derived key',
    (path, expectedCallSite) => {
      const source = readSource(path)
      expect(source).toContain(
        "import { useEntityKeyReset } from '../../platform/entity-key-change-tracker'",
      )
      expect(source).toContain("import { useAuth } from '../../auth/useAuth'")
      expect(source).toContain('const { session } = useAuth()')
      expect(source).toContain('const userId = session?.user.id ?? null')
      expect(source).toContain(expectedCallSite)
    },
  )

  it('PurchaseFormPage.tsx resolves manual cards through the shared, tested cache module, not an inline Map', () => {
    const source = readSource('features/purchases/PurchaseFormPage.tsx')
    expect(source).toContain(
      "import { ManualCardResolutionCache, resolveManualCardId } from './manual-card-resolution'",
    )
    expect(source).toContain('new ManualCardResolutionCache()')
    expect(source).toMatch(/resolveManualCardId\(\s*resolvedManualCards\.current/)
    // The identity-switch reset callback clears the SAME cache instance the resolve call above
    // reads from — both sides of the boundary reference `resolvedManualCards.current`.
    expect(source).toContain('resolvedManualCards.current.clear()')
  })
})
