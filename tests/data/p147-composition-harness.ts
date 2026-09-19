import { createClient } from '@supabase/supabase-js'
import { IdentityAuthority, type IdentityLease } from '../../src/auth/identity-lease'
import type { Database } from '../../src/data/database.types'
import { createExactTransportFetch } from '../../src/data/exact-json-guard'
import { createLeasedDb, type LeasedDb } from '../../src/data/leased-client'

/**
 * P147 — the vocabulary shared by the composition tests and the cross-track mutation tests.
 *
 * A {@link World} is one browser tab plus a stub backend that plays PostgREST + PostgreSQL closely
 * enough for the two invariants that matter here to be OBSERVABLE FACTS instead of assumptions:
 *
 *   IDENTITY  every write is attributed to the account of the bearer token it arrived with (what
 *             `auth.uid()` does), so "which account did this land in" is read off the backend.
 *   MONEY     the backend parses money the way Postgres does — a decimal string is read digit by
 *             digit into a bigint, a JSON number is a double that was already rounded on the way
 *             out — and stores the result, so "which amount did this become" is a stored fact.
 *
 * The stub is deliberately dumb about everything else. The real-PostgREST equivalents of the same
 * scenarios live in tests/db/p147_auth_money_integration.test.ts.
 */

export interface Session {
  access_token: string
  user: { id: string }
}

export const sessionOf = (user: 'a' | 'b', generation = 1): Session => ({
  access_token: `token-${user}-${String(generation)}`,
  user: { id: `user-${user}` },
})

export const ownerOfToken = (authorization: string | null): string | null => {
  const match = /^Bearer token-([ab])-\d+$/.exec(authorization ?? '')
  return match?.[1] === undefined ? null : `user-${match[1]}`
}

export interface Recorded {
  method: string
  path: string
  owner: string | null
  authorization: string | null
  /** The request body exactly as it left the client (text, before any parsing). */
  bodyText: string
}

export interface StoredPurchase {
  owner: string
  key: string
  /** What the backend's bigint column holds after parsing the request. */
  unitPriceMinor: bigint
}

export interface World {
  authority: IdentityAuthority
  /** The session the shared browser storage holds right now. */
  session: Session | null
  /** Awaited inside `getSession` while set: models a slow lookup / token refresh in flight. */
  getSessionGate: Promise<void> | null
  getSessionCalls: number
  requests: Recorded[]
  stored: StoredPurchase[]
  fetch: typeof fetch
  getSession: () => Promise<{ data: { session: Session | null } }>
  /** The other tab signs in as `user`; `heard` says whether this tab has been told yet. */
  switchTo: (user: 'a' | 'b', options?: { heard?: boolean }) => void
  /** Same user, new access token (a real refresh: nothing about the identity changes). */
  refreshToken: (user: 'a' | 'b', generation: number) => void
  /** Park the next session lookup; the returned function lets it continue. */
  parkNextSessionLookup: () => () => void
}

export function makeWorld(
  makeAuthority: () => IdentityAuthority = () => new IdentityAuthority(),
): World {
  const authority = makeAuthority()
  authority.observe('user-a')
  const world: World = {
    authority,
    session: sessionOf('a'),
    getSessionGate: null,
    getSessionCalls: 0,
    requests: [],
    stored: [],
    fetch: () => Promise.resolve(new Response(null, { status: 500 })),
    getSession: async () => {
      world.getSessionCalls += 1
      if (world.getSessionGate) await world.getSessionGate
      return { data: { session: world.session } }
    },
    switchTo: (user, options = {}) => {
      world.session = sessionOf(user)
      if (options.heard ?? true) authority.observe(`user-${user}`)
    },
    refreshToken: (user, generation) => {
      world.session = sessionOf(user, generation)
      authority.observe(`user-${user}`) // the auth event for a same-user refresh
    },
    parkNextSessionLookup: () => {
      let release: () => void = () => undefined
      world.getSessionGate = new Promise<void>((resolve) => {
        release = () => {
          world.getSessionGate = null
          resolve()
        }
      })
      return release
    },
  }

  world.fetch = async (input, init) => {
    await Promise.resolve() // the network is asynchronous: never answer within the caller's own turn
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const headers = new Headers(init?.headers)
    const owner = ownerOfToken(headers.get('authorization'))
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    world.requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      owner,
      authorization: headers.get('authorization'),
      bodyText,
    })
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (owner === null) return json(401, { message: 'no bearer' })
    if (!url.pathname.endsWith('/rpc/create_purchase')) {
      return json(404, { message: `unexpected ${url.pathname}` })
    }

    // PostgREST hands the jsonb argument to PostgreSQL untouched; the RPC reads the money out of
    // it with `->> 'unit_price_minor'` cast to bigint. Here: BigInt of the decimal text.
    const args = JSON.parse(bodyText) as {
      p_idempotency_key: string
      p_lines: { unit_price_minor: string | number }[]
    }
    const raw = args.p_lines[0]?.unit_price_minor
    const unitPriceMinor = BigInt(raw ?? 0)
    // A double that was already rounded before it was sent: BigInt(9007199254740992) — the digits
    // the client meant are gone, and this is what the ledger would have stored.
    world.stored.push({ owner, key: args.p_idempotency_key, unitPriceMinor })
    const text = unitPriceMinor.toString()
    return json(200, {
      id: `purchase-${String(world.stored.length)}`,
      purchased_on: '2026-09-01',
      retailer_id: null,
      currency: 'NOK',
      subtotal_minor: text,
      shipping_minor: '0',
      customs_minor: '0',
      discount_minor: '0',
      total_minor: text,
      fx_rate_to_nok: '1',
      fx_rate_date: '2026-09-01',
      fx_source: 'manual',
      total_nok_minor: text,
      notes: null,
      voided_at: null,
    })
  }
  return world
}

/** How a scenario obtains its identity authority and its (leased) client. Production and mutants
 *  differ only here. */
export interface Env {
  makeAuthority: () => IdentityAuthority
  buildDb: (lease: IdentityLease, world: World) => LeasedDb
}

export const productionEnv: Env = {
  makeAuthority: () => new IdentityAuthority(),
  buildDb: (lease, world) =>
    createLeasedDb(lease, {
      url: 'http://stub.invalid',
      publishableKey: 'stub-key',
      fetch: world.fetch,
      getSession: world.getSession,
    }),
}

export interface MutantClientOptions {
  /** Install the exact-transport guard under the client (production: yes). */
  guard: boolean
  /** Check the lease and the live session's user before handing out a token (production: yes). */
  verifyIdentity: boolean
}

/**
 * A leased-shaped client built from the same primitives as production with ONE protection
 * switchable off — the mutants of docs/DECISIONS.md D-138. It exists so a test can prove that the
 * scenarios below would have caught each removal.
 */
export function buildMutantDb(
  lease: IdentityLease,
  world: World,
  options: MutantClientOptions,
): LeasedDb {
  let constructing = true
  const accessToken = async (): Promise<string | null> => {
    if (constructing) return 'stub-key'
    if (options.verifyIdentity) {
      lease.assertCurrent()
      const { data } = await world.getSession()
      if (data.session === null || data.session.user.id !== lease.userId) {
        lease.revoke()
        throw new Error('identity changed')
      }
      lease.assertCurrent()
      return data.session.access_token
    }
    // Mutant: "whoever holds the browser session right now".
    const { data } = await world.getSession()
    return data.session?.access_token ?? null
  }
  const client = createClient<Database>('http://stub.invalid', 'stub-key', {
    accessToken,
    global: { fetch: options.guard ? createExactTransportFetch(world.fetch) : world.fetch },
  })
  constructing = false
  Object.defineProperty(client, 'identityLease', { value: lease, enumerable: false })
  return client as LeasedDb
}

export const BIG = 2n ** 53n + 1n // 9007199254740993 — the first integer a double cannot hold
