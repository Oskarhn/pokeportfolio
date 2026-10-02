import { IdentityAuthority, runWithLease, type IdentityLease } from '../../src/auth/identity-lease'
import { createLeasedDb, type LeasedClientDeps } from '../../src/data/leased-client'
import { createPurchase } from '../../src/data/purchases'

/**
 * P149 - a tab whose credential lookup is a scripted stand-in, shared by the credential-provider
 * tests and the hook test. The data modules import the shared Supabase client (which reads
 * `import.meta.env`), so a test that imports them must mock '../../src/data/supabase-client' first;
 * every function used here takes the LEASED client, so the shared one is never touched.
 *
 * The backend attributes every request to the account of the bearer token it received (what
 * `auth.uid()` does), so "as whom did this go out" is an observable fact.
 */

export const KEY = '11111111-1111-4111-8111-111111111111'
export const SESSION_TEXT = 'Could not verify your session. Check your connection and try again.'

export interface Session {
  access_token: string
  user: { id: string }
}
export const sessionOf = (user: 'a' | 'b', n = 1): Session => ({
  access_token: `token-${user}-${String(n)}`,
  user: { id: `user-${user}` },
})
const ownerOfToken = (authorization: string | null): string | null => {
  const match = /^Bearer token-([ab])-\d+$/.exec(authorization ?? '')
  return match?.[1] === undefined ? null : `user-${match[1]}`
}

export type Lookup = Awaited<ReturnType<LeasedClientDeps['getSession']>>

function purchaseRow() {
  return {
    id: 'purchase-1',
    purchased_on: '2026-09-01',
    retailer_id: null,
    currency: 'NOK',
    subtotal_minor: '1200',
    shipping_minor: '0',
    customs_minor: '0',
    discount_minor: '0',
    total_minor: '1200',
    fx_rate_to_nok: 1,
    fx_rate_date: '2026-09-01',
    fx_source: 'manual',
    total_nok_minor: '1200',
    notes: null,
    voided_at: null,
  }
}

export interface Dispatched {
  owner: string | null
  authorization: string | null
  key: string | null
}

export function makeWorld() {
  const authority = new IdentityAuthority()
  authority.observe('user-a')
  const world = {
    authority,
    lookups: 0,
    dispatched: [] as Dispatched[],
    /** What the next lookup does. Replaced by tests; the default is a healthy session for A. */
    lookup: (() => Promise.resolve({ data: { session: sessionOf('a') } })) as () => Promise<Lookup>,
  }
  const fetchStub: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const headers = new Headers(init?.headers)
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    world.dispatched.push({
      owner: ownerOfToken(headers.get('authorization')),
      authorization: headers.get('authorization'),
      key: typeof body.p_idempotency_key === 'string' ? body.p_idempotency_key : null,
    })
    const ok = url.pathname.endsWith('/rpc/create_purchase')
    return Promise.resolve(
      new Response(JSON.stringify(ok ? purchaseRow() : { message: 'unexpected' }), {
        status: ok ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  const deps: LeasedClientDeps = {
    url: 'http://stub.invalid',
    publishableKey: 'stub-key',
    fetch: fetchStub,
    getSession: () => {
      world.lookups += 1
      return world.lookup()
    },
  }
  const submit = (lease: IdentityLease, key = KEY) =>
    runWithLease(lease, () =>
      createPurchase(
        { purchasedOn: '2026-09-01', currency: 'NOK', lines: [], notes: 'p149' },
        key,
        createLeasedDb(lease, deps),
      ),
    )
  return { world, deps, submit }
}

/** The shapes a failed refresh takes when auth-js reports it (tests/data/p149-auth-lookup-contract). */
export const retryableFetchError = Object.assign(new Error('Failed to fetch'), {
  name: 'AuthRetryableFetchError',
  status: 0,
})
export const serverError = Object.assign(new Error('Service Unavailable'), {
  name: 'AuthRetryableFetchError',
  status: 503,
})
