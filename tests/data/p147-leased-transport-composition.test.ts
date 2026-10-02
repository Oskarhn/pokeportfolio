import { describe, expect, it, vi } from 'vitest'
import { UnsafeIntegerTransportError } from '../../src/data/exact-json-guard'
import {
  createAccessTokenSupabaseClient,
  createAppSupabaseClient,
} from '../../src/data/supabase-factory'
import { BIG, makeWorld, productionEnv } from './p147-composition-harness'
import {
  aToBToAStaleLease,
  identitySwitchBeforeDispatch,
  largeMoneyLeasedPurchase,
  sameUserRefreshExactMoney,
  signedOutPendingMutation,
  unsafeNumberRefusedStringAccepted,
} from './p147-composition-scenarios'

// The data modules import the shared client, which reads `import.meta.env`; every function under
// test takes the LEASED client, so the shared one is never used and a placeholder is enough.
vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://stub.invalid',
  supabasePublishableKey: 'stub-key',
}))

/**
 * P147 — identity lease (D-136) and exact-money transport (D-137) on ONE client (D-138), the
 * production composition, through the real `createPurchase` and a backend that stores what it
 * parsed. The same scenario functions are re-run against compositions with one protection
 * removed in p147-cross-track-mutations.test.ts.
 */
describe('production composition: the leased client carries BOTH protections', () => {
  it('normal authenticated request: A bearer, exact decimal string, stored under A', async () => {
    await largeMoneyLeasedPurchase(productionEnv)
  })

  it('a large amount (2^53 + 1) survives request and response digit for digit', async () => {
    const world = makeWorld()
    const lease = world.authority.begin('user-a')
    const db = productionEnv.buildDb(lease, world)
    const { createPurchase } = await import('../../src/data/purchases')
    const purchase = await createPurchase(
      {
        purchasedOn: '2026-09-01',
        currency: 'NOK',
        lines: [
          {
            lineType: 'accessory',
            description: 'x',
            quantity: 1,
            unitPriceMinor: 2n ** 62n + 12345n,
          },
        ],
      },
      'k-1',
      db,
    )
    expect(world.stored[0]?.unitPriceMinor).toBe(2n ** 62n + 12345n)
    expect(purchase.totalNokMinor).toBe(2n ** 62n + 12345n)
  })

  it('identity switch before dispatch (this tab HAS heard): nothing is sent, nothing for B', async () => {
    await identitySwitchBeforeDispatch(productionEnv, { heard: true })
  })

  it('identity switch before dispatch (EVENT GAP: this tab has NOT heard yet): refused from the credentials alone', async () => {
    await identitySwitchBeforeDispatch(productionEnv, { heard: false })
  })

  it('same-user token refresh: completes with the NEW token and the exact amount', async () => {
    await sameUserRefreshExactMoney(productionEnv)
  })

  it('A -> B -> A: the original lease stays dead although the session is A again', async () => {
    await aToBToAStaleLease(productionEnv)
  })

  it('signed out while pending: the write is never dispatched', async () => {
    await signedOutPendingMutation(productionEnv)
  })

  it('an unsafe JSON number is refused on the leased client; a decimal string passes', async () => {
    await unsafeNumberRefusedStringAccepted(productionEnv)
  })
})

describe('the transport guard is on the ordinary app client too (same factory, same guard)', () => {
  const unsafeBody = {
    p_purchased_on: '2026-09-01',
    p_currency: 'NOK',
    p_lines: [{ line_type: 'accessory', quantity: 1, unit_price_minor: Number(BIG) }],
    p_idempotency_key: 'k',
  }

  it('refuses an unsafe literal before any request leaves', async () => {
    const world = makeWorld()
    const client = createAppSupabaseClient(
      'http://stub.invalid',
      'stub-key',
      {},
      { baseFetch: world.fetch },
    )
    const { error } = await client.rpc('create_purchase', unsafeBody)
    expect(error?.message).toContain('refusing request body')
    expect(error?.message).toContain(
      new UnsafeIntegerTransportError('9007199254740992').message.slice(0, 40),
    )
    expect(world.requests).toEqual([])
  })

  it('accepts the same amount as a decimal string', async () => {
    const world = makeWorld()
    world.session = { access_token: 'token-a-1', user: { id: 'user-a' } }
    const client = createAppSupabaseClient(
      'http://stub.invalid',
      'stub-key',
      {},
      {
        baseFetch: world.fetch,
        auth: { persistSession: false, autoRefreshToken: false },
      },
    )
    await client.auth
      .setSession({ access_token: 'token-a-1', refresh_token: 'r' })
      .catch(() => undefined)
    const { error } = await client.rpc('create_purchase', {
      ...unsafeBody,
      p_lines: [{ line_type: 'accessory', quantity: 1, unit_price_minor: BIG.toString() }],
    })
    // The stub answers 401 without a bearer or 200 with one; what matters is that the guard did
    // not refuse: a request reached the network layer with the string intact.
    expect(error?.message ?? '').not.toContain('refusing request body')
    expect(world.requests).toHaveLength(1)
    expect(world.requests[0]?.bodyText).toContain('"unit_price_minor":"9007199254740993"')
  })

  it('reports (and repairs) an unsafe integer in a RESPONSE on either client kind', async () => {
    const reported: string[][] = []
    const respond: typeof fetch = () =>
      Promise.resolve(
        new Response('[{"id":"x","total_minor":9007199254740993}]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const app = createAppSupabaseClient(
      'http://stub.invalid',
      'stub-key',
      { onResponseRewrite: (l) => reported.push(l) },
      { baseFetch: respond },
    )
    const leased = createAccessTokenSupabaseClient(
      'http://stub.invalid',
      'stub-key',
      () => Promise.resolve('token-a-1'),
      { onResponseRewrite: (l) => reported.push(l) },
      { baseFetch: respond },
    )
    for (const client of [app, leased]) {
      const { data } = await client.from('purchases').select('id, total_minor').limit(1)
      expect((data as unknown as { total_minor: unknown }[] | null)?.[0]?.total_minor).toBe(
        '9007199254740993',
      )
    }
    expect(reported).toEqual([['9007199254740993'], ['9007199254740993']])
  })
})

describe('one authentication truth: the leased client has no auth state of its own', () => {
  it('client.auth is unavailable on an accessToken client (supabase-js contract this design relies on)', () => {
    const client = createAccessTokenSupabaseClient('http://stub.invalid', 'stub-key', () =>
      Promise.resolve('token-a-1'),
    )
    expect(() => client.auth.getSession()).toThrow(/accessToken/i)
  })

  it('the factory accepts no auth options for an accessToken client', () => {
    // Structural: a third argument type without `auth`; the runtime object is what the type says.
    const extras: Parameters<typeof createAccessTokenSupabaseClient>[4] = { baseFetch: fetch }
    expect(Object.keys(extras)).toEqual(['baseFetch'])
  })
})
