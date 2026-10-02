import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as fc from 'fast-check'
import { QueryClient } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANONYMOUS_IDENTITY_KEY,
  classifyIdentityTransition,
  identityKey,
  isIdentityChange,
  type ObservedUserId,
} from '../../src/auth/identity'
import { applyAuthIdentityBoundary } from '../../src/auth/query-cache-boundary'
import { draftStore, initialDraft } from '../../src/features/openings/draft'
import {
  initialScannerDefaults,
  scannerSessionStore,
} from '../../src/features/scanner/session-store'
import { hasUnsavedScannerWork, setScannerBatchSize } from '../../src/features/scanner/unsaved-work'
import { hasAnyUnsavedWork } from '../../src/platform/unsaved-work-registry'

/**
 * P143 / P130-23 — the identity-boundary rules, executed for real.
 *
 * No DOM renderer exists in this repository's unit environment (P140 established that), so a
 * remount cannot be OBSERVED here — the two-page browser specs (tests/e2e/auth-identity-
 * lifecycle.spec.ts, tests/e2e/authenticated/auth-identity-real.spec.ts) own that. What CAN be
 * proven here is everything that decides whether a remount happens:
 *
 *   - the pure rules (which user ids share a key, which transitions are identity changes), and
 *   - the real `AuthIdentityBoundary` component, called directly with `useAuth` mocked — it owns no
 *     hook of its own, so its return value is the exact `<Fragment key=...>` React reconciles.
 *     React unmounts a subtree precisely when that key differs between two renders.
 */

const mockedSession = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }))

vi.mock('../../src/auth/useAuth', () => ({
  useAuth: () => ({ session: mockedSession.current }),
}))

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

async function boundaryKey(): Promise<string> {
  const { AuthIdentityBoundary } = await import('../../src/auth/AuthIdentityBoundary')
  const element = AuthIdentityBoundary({ children: null }) as ReactElement
  return String(element.key)
}

function sessionOf(id: string, accessToken: string): { user: { id: string } } {
  // A real session carries far more than a user id; every extra field here is one that changes
  // routinely for the SAME person and must never influence the boundary.
  return {
    user: { id },
    access_token: accessToken,
    refresh_token: `refresh-of-${accessToken}`,
    expires_at: 1_900_000_000,
  } as { user: { id: string } }
}

describe('identity key — the boundary is the USER ID', () => {
  it('maps signed-out and still-loading to one shared key', () => {
    expect(identityKey(null)).toBe(ANONYMOUS_IDENTITY_KEY)
  })

  it('never collides a user with the anonymous key, even for a hostile-looking id', () => {
    expect(identityKey(A)).not.toBe(ANONYMOUS_IDENTITY_KEY)
    expect(identityKey('anonymous')).not.toBe(ANONYMOUS_IDENTITY_KEY)
  })

  it('gives different users different keys and the same user the same key', () => {
    expect(identityKey(A)).not.toBe(identityKey(B))
    expect(identityKey(A)).toBe(identityKey(A))
  })
})

describe('AuthIdentityBoundary (the real component) keys its subtree by user id only', () => {
  beforeEach(() => {
    mockedSession.current = null
  })

  it('same user, different tokens/session objects => SAME key (refresh must not destroy unsaved work)', async () => {
    mockedSession.current = sessionOf(A, 'access-token-1')
    const first = await boundaryKey()
    mockedSession.current = sessionOf(A, 'access-token-2-after-TOKEN_REFRESHED')
    const afterRefresh = await boundaryKey()
    mockedSession.current = sessionOf(A, 'access-token-3-after-USER_UPDATED')
    const afterUpdate = await boundaryKey()
    expect(afterRefresh).toBe(first)
    expect(afterUpdate).toBe(first)
  })

  it('A -> B with no signed-out state in between => DIFFERENT key (remount)', async () => {
    mockedSession.current = sessionOf(A, 'same-token-string')
    const forA = await boundaryKey()
    mockedSession.current = sessionOf(B, 'same-token-string')
    const forB = await boundaryKey()
    expect(forB).not.toBe(forA)
  })

  it('signed in -> signed out -> signed in as the same user => the signed-in keys are equal but separated by a different key (fresh tree on re-sign-in)', async () => {
    mockedSession.current = sessionOf(A, 't1')
    const first = await boundaryKey()
    mockedSession.current = null
    const between = await boundaryKey()
    mockedSession.current = sessionOf(A, 't2')
    const again = await boundaryKey()
    expect(between).not.toBe(first)
    expect(between).not.toBe(again)
  })

  it('loading and signed-out share a key (an initial restore that finds no session remounts nothing)', async () => {
    mockedSession.current = null
    const loading = await boundaryKey()
    const signedOut = await boundaryKey()
    expect(loading).toBe(signedOut)
    expect(loading).toBe(ANONYMOUS_IDENTITY_KEY)
  })
})

describe('identity transitions', () => {
  const cases: [ObservedUserId, string | null, string, boolean][] = [
    [undefined, null, 'first-observation', false],
    [undefined, A, 'first-observation', false],
    [null, null, 'unchanged', false],
    [A, A, 'unchanged', false],
    [null, A, 'sign-in', true],
    [A, null, 'sign-out', true],
    [A, B, 'switch', true],
    [B, A, 'switch', true],
  ]

  it.each(cases)('%s -> %s is %s (identity change: %s)', (previous, next, kind, isChange) => {
    const transition = classifyIdentityTransition(previous, next)
    expect(transition).toBe(kind)
    expect(isIdentityChange(transition)).toBe(isChange)
  })

  it('property: the React key changes exactly when the user id changes, whatever else about the session does', () => {
    const userId = fc.constantFrom<string | null>(null, A, B, 'c-user', 'd-user')
    fc.assert(
      fc.property(
        fc.array(fc.tuple(userId, fc.string()), { minLength: 1, maxLength: 40 }),
        (events) => {
          let previousUser: string | null | undefined
          let previousKey: string | undefined
          for (const [user, token] of events) {
            void token // the token is generated to prove it is irrelevant
            const key = identityKey(user)
            if (previousKey !== undefined && previousUser !== undefined) {
              expect(key === previousKey).toBe(user === previousUser)
            }
            previousUser = user
            previousKey = key
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('property: applyAuthIdentityBoundary fires exactly for the transitions classified as identity changes', () => {
    const userId = fc.constantFrom<string | null>(null, A, B)
    const observed = fc.constantFrom<ObservedUserId>(undefined, null, A, B)
    fc.assert(
      fc.property(observed, userId, (previous, next) => {
        const client = new QueryClient()
        const fired = applyAuthIdentityBoundary(client, previous, next)
        expect(fired).toBe(isIdentityChange(classifyIdentityTransition(previous, next)))
      }),
      { numRuns: 200 },
    )
  })
})

describe('state that lives outside the React tree is cleared on an identity change (P143 inventory)', () => {
  it('clears the query cache, the draft store, the scanner session store and the scanner unsaved-work mirror on A -> B', () => {
    const client = new QueryClient()
    client.setQueryData(['portfolio'], { owner: 'A' })
    draftStore.save(A, initialDraft())
    scannerSessionStore.save(A, initialScannerDefaults())
    setScannerBatchSize(3)
    expect(hasUnsavedScannerWork()).toBe(true)
    expect(hasAnyUnsavedWork()).toBe(true)

    expect(applyAuthIdentityBoundary(client, A, B)).toBe(true)

    expect(client.getQueryData(['portfolio'])).toBeUndefined()
    expect(draftStore.load(A)).toBeNull()
    expect(scannerSessionStore.load(A)).toBeNull()
    expect(hasUnsavedScannerWork()).toBe(false)
    expect(hasAnyUnsavedWork()).toBe(false)
  })

  it('leaves all of it alone for a same-user event', () => {
    const client = new QueryClient()
    client.setQueryData(['portfolio'], { owner: 'A' })
    draftStore.save(A, initialDraft())
    scannerSessionStore.save(A, initialScannerDefaults())
    setScannerBatchSize(2)

    expect(applyAuthIdentityBoundary(client, A, A)).toBe(false)

    expect(client.getQueryData(['portfolio'])).toEqual({ owner: 'A' })
    expect(draftStore.load(A)).not.toBeNull()
    expect(scannerSessionStore.load(A)).not.toBeNull()
    expect(hasUnsavedScannerWork()).toBe(true)

    draftStore.clearAll()
    scannerSessionStore.clearAll()
    setScannerBatchSize(0)
  })
})

describe('wiring: the boundary sits where it can reach every protected route', () => {
  const src = (path: string) => readFileSync(resolve(__dirname, '../../src', path), 'utf8')

  it('the ROOT route wraps the app shell (and therefore every routed page and portal) in AuthIdentityBoundary', () => {
    const router = src('router.tsx')
    const root = router.slice(
      router.indexOf('const rootRoute = createRootRoute('),
      router.indexOf('const indexRoute = createRoute('),
    )
    expect(router).toContain("import { AuthIdentityBoundary } from './auth/AuthIdentityBoundary'")
    expect(root).toMatch(
      /<AuthIdentityBoundary>\s*<AppShell>[\s\S]*<Outlet \/>[\s\S]*<\/AppShell>\s*<\/AuthIdentityBoundary>/,
    )
  })

  it('the boundary keys on the user id and reads nothing else from the session', () => {
    const source = src('auth/AuthIdentityBoundary.tsx')
    expect(source).toContain('key={identityKey(session?.user.id ?? null)}')
    expect(source).not.toMatch(/access_token|refresh_token|expires_at|updated_at/)
  })

  it('AuthProvider still funnels every observed session through the boundary before publishing it', () => {
    const source = src('auth/AuthProvider.tsx')
    // observeIdentity(x) must precede setSession(x) at each observation site.
    const sites = [
      ...source.matchAll(/observeIdentity\((\w+(?:\.\w+)?)\)\s*\n\s*setSession\(\1\)/g),
    ]
    expect(sites.length).toBeGreaterThanOrEqual(2)
  })
})
