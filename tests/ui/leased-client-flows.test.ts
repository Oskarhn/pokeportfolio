import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthIdentityChangedError,
  IdentityAuthority,
  runWithLease,
} from '../../src/auth/identity-lease'
import { createLeasedDb, type LeasedClientDeps } from '../../src/data/leased-client'

// The data modules import the shared client, which reads `import.meta.env`; every function under
// test here takes the LEASED client, so the shared one is never used and a placeholder is enough.
vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://stub.invalid',
  supabasePublishableKey: 'stub-key',
}))

const { createManualCard } = await import('../../src/data/collection')
const { createPurchase } = await import('../../src/data/purchases')
const { createSale } = await import('../../src/data/sales')
const { fetchFxRate } = await import('../../src/data/fx')
const { updateMyProfile } = await import('../../src/data/profile')

/**
 * P145 — the request layer and the REAL data functions of the multi-step flows, against a stub
 * backend that plays PostgREST: it attributes every write to the bearer token it received (exactly
 * what `auth.uid()` does), so "which account did this land in" is an observable fact, not an
 * assumption. Nothing here asserts that a step "checked" anything: the tests move the identity
 * BETWEEN steps and look at what reached the backend.
 *
 * What the tests do not include, and why: the React pages themselves need a browser (this
 * repository has no DOM renderer); tests/e2e/authenticated/auth-inflight-real.spec.ts drives the
 * real pages against a real local stack.
 */

const MARKER = 'A-ONLY-p145-unit-marker'

interface Session {
  access_token: string
  user: { id: string }
}

const sessionOf = (user: 'a' | 'b', n = 1): Session => ({
  access_token: `token-${user}-${String(n)}`,
  user: { id: `user-${user}` },
})

const ownerOfToken = (authorization: string | null): string | null => {
  const match = /^Bearer token-([ab])-\d+$/.exec(authorization ?? '')
  return match?.[1] === undefined ? null : `user-${match[1]}`
}

interface Recorded {
  method: string
  path: string
  search: string
  owner: string | null
  authorization: string | null
  body: unknown
}

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

function saleRow() {
  return {
    id: 'sale-1',
    sold_on: '2026-09-01',
    marketplace: null,
    currency: 'NOK',
    gross_minor: '1000',
    fees_minor: '0',
    shipping_cost_minor: '0',
    shipping_charged_minor: '0',
    net_proceeds_minor: '1000',
    fx_rate_to_nok: 1,
    fx_rate_date: '2026-09-01',
    fx_source: 'manual',
    net_proceeds_nok_minor: '1000',
    realized_result_nok_minor: null,
    proceeds_from_uncosted_nok_minor: '0',
    notes: null,
    voided_at: null,
  }
}

/** One tab of the world: an authority, the browser's shared session, and the backend. */
function makeWorld() {
  const authority = new IdentityAuthority()
  authority.observe('user-a')
  const world = {
    authority,
    session: sessionOf('a') as Session | null,
    getSessionCalls: 0,
    /** Awaited inside getSession while set: models a slow session lookup / token refresh. */
    getSessionGate: null as Promise<void> | null,
    /** Awaited inside fetch (after the bearer was already attached) while set. */
    requestGate: null as Promise<void> | null,
    requests: [] as Recorded[],
    /** What the backend actually wrote, attributed to the account of the bearer. */
    written: [] as { table: string; owner: string; payload: unknown }[],
  }

  const fetchStub: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const headers = new Headers(init?.headers)
    const owner = ownerOfToken(headers.get('authorization'))
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    const record: Recorded = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      owner,
      authorization: headers.get('authorization'),
      body: bodyText === '' ? null : (JSON.parse(bodyText) as unknown),
    }
    world.requests.push(record)
    if (world.requestGate) await world.requestGate
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    const write = (table: string, payload: unknown) => {
      if (owner === null) return json(401, { message: 'no bearer' })
      world.written.push({ table, owner, payload })
      return null
    }
    if (url.pathname.endsWith('/manual_card_definitions')) {
      const denied = write('manual_card_definitions', record.body)
      if (denied) return denied
      return json(201, {
        id: `card-of-${owner ?? 'nobody'}`,
        name: (record.body as { name: string }).name,
        set_name: null,
        collector_number: null,
        language: null,
        finish: null,
        stamp: null,
        subtype: null,
        notes: null,
      })
    }
    if (url.pathname.endsWith('/rpc/create_purchase')) {
      const denied = write('purchases', record.body)
      return denied ?? json(200, purchaseRow())
    }
    if (url.pathname.endsWith('/rpc/create_sale')) {
      const denied = write('sales', record.body)
      return denied ?? json(200, saleRow())
    }
    if (url.pathname.endsWith('/profiles')) {
      const denied = write('profiles', { patch: record.body, filter: url.search })
      return denied ?? new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/functions/v1/fetch-fx-rate')) {
      return json(200, { ok: true, rate: '11.5', rateDate: '2026-09-01', source: 'norges_bank' })
    }
    return json(404, { message: `unexpected ${url.pathname}` })
  }

  const deps: LeasedClientDeps = {
    url: 'http://stub.invalid',
    publishableKey: 'stub-key',
    fetch: fetchStub,
    getSession: async () => {
      world.getSessionCalls += 1
      if (world.getSessionGate) await world.getSessionGate
      return { data: { session: world.session } }
    },
  }

  /** The other tab signs in as B: the shared session changes and this tab hears about it. */
  const switchToB = (options: { heardYet: boolean } = { heardYet: true }) => {
    world.session = sessionOf('b')
    if (options.heardYet) world.authority.observe('user-b')
  }

  return { world, deps, switchToB }
}

/** The purchase submission's awaited steps, in the page's order, through the real data functions. */
async function purchaseSubmission(
  world: ReturnType<typeof makeWorld>,
  lease: ReturnType<IdentityAuthority['begin']>,
  between: () => void,
) {
  const db = createLeasedDb(lease, world.deps)
  await createManualCard({ name: MARKER }, db)
  between()
  // Deliberately NO lease assertion here: the request layer alone must refuse step 2.
  return createPurchase(
    { purchasedOn: '2026-09-01', currency: 'NOK', lines: [], notes: MARKER },
    'idempotency-key-1',
    db,
  )
}

describe('leased client — the purchase submission across an identity change', () => {
  let ctx: ReturnType<typeof makeWorld>

  beforeEach(() => {
    ctx = makeWorld()
  })

  it('control: with no identity change every step is recorded for A', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const purchase = await runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => undefined),
    )
    expect(purchase.id).toBe('purchase-1')
    expect(ctx.world.written.map((w) => [w.table, w.owner])).toEqual([
      ['manual_card_definitions', 'user-a'],
      ['purchases', 'user-a'],
    ])
  })

  it('A -> B between the steps: the manual card stays A-only and NOTHING is written for B', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const outcome = runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.switchToB()
      }),
    )
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.written).toEqual([
      {
        table: 'manual_card_definitions',
        owner: 'user-a',
        payload: {
          name: MARKER,
          set_name: null,
          collector_number: null,
          language: null,
          finish: null,
          stamp: null,
          subtype: null,
          notes: null,
        },
      },
    ])
    expect(ctx.world.written.filter((w) => w.owner === 'user-b')).toEqual([])
    // Step 2 never left the browser: only step 1's request exists.
    expect(ctx.world.requests.map((r) => r.path)).toEqual(['/rest/v1/manual_card_definitions'])
  })

  it('the check-to-dispatch window: the identity changes WHILE the session lookup for step 2 is pending', async () => {
    const lease = ctx.world.authority.begin('user-a')
    let release: () => void = () => undefined
    const outcome = runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        // From here the next getSession() parks; step 2 has started but has no bearer yet.
        ctx.world.getSessionGate = new Promise<void>((resolve) => {
          release = resolve
        })
      }),
    )
    // Let step 2 reach the parked lookup, switch identity, then let the lookup resolve.
    // getSession call 1 belonged to step 1; call 2 is step 2, parked with no bearer chosen yet.
    await vi.waitFor(() => {
      expect(ctx.world.getSessionCalls).toBe(2)
    })
    ctx.switchToB()
    release()
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.written.filter((w) => w.owner === 'user-b')).toEqual([])
    expect(ctx.world.requests).toHaveLength(1)
  })

  it('EVENT GAP: the browser already holds B, this tab has not heard yet: refused from the credentials alone', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const outcome = runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.switchToB({ heardYet: false })
      }),
    )
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    // The authority still says A (no event yet); the request layer alone caught it, and ended the lease.
    expect(ctx.world.authority.userId).toBe('user-a')
    expect(lease.isCurrent()).toBe(false)
    expect(ctx.world.written.filter((w) => w.owner === 'user-b')).toEqual([])
  })

  it('A signs out between the steps (session gone): the operation stops, nothing is written afterwards', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const outcome = runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.world.session = null
        ctx.world.authority.observe(null)
      }),
    )
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.written.map((w) => w.table)).toEqual(['manual_card_definitions'])
  })

  it('this tab is mid sign-out (retire() before the session is removed): no further step starts', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const outcome = runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.world.authority.retire() // the session itself is still stored for a moment
      }),
    )
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.written.map((w) => w.table)).toEqual(['manual_card_definitions'])
  })

  it('A -> B -> A: the old lease stays dead although the bearer is A again', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const outcome = runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.switchToB()
        ctx.world.session = sessionOf('a', 2)
        ctx.world.authority.observe('user-a')
      }),
    )
    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(ctx.world.written.map((w) => w.table)).toEqual(['manual_card_definitions'])
    // A fresh lease for the new A session works.
    const fresh = ctx.world.authority.begin('user-a')
    const db = createLeasedDb(fresh, ctx.deps)
    await expect(createManualCard({ name: 'second' }, db)).resolves.toMatchObject({
      name: 'second',
    })
  })

  it('same-user token refresh between the steps does not disturb the operation, and the NEW token is used', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const purchase = await runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.world.session = sessionOf('a', 2) // TOKEN_REFRESHED
        ctx.world.authority.observe('user-a')
      }),
    )
    expect(purchase.id).toBe('purchase-1')
    expect(ctx.world.requests.map((r) => r.authorization)).toEqual([
      'Bearer token-a-1',
      'Bearer token-a-2',
    ])
  })

  it('USER_UPDATED / repeated SIGNED_IN for the same user do not disturb it either', async () => {
    const lease = ctx.world.authority.begin('user-a')
    await runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.world.authority.observe('user-a')
        ctx.world.authority.observe('user-a')
      }),
    )
    expect(ctx.world.written.map((w) => w.owner)).toEqual(['user-a', 'user-a'])
  })

  it('an already-dispatched request completes as A even though the identity changed while it was in flight', async () => {
    const lease = ctx.world.authority.begin('user-a')
    let openGate: () => void = () => undefined
    ctx.world.requestGate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const db = createLeasedDb(lease, ctx.deps)
    const step1 = createManualCard({ name: MARKER }, db)
    await vi.waitFor(() => {
      expect(ctx.world.requests).toHaveLength(1)
    })
    ctx.switchToB() // while step 1 is still on its way to the backend
    openGate()
    await expect(step1).resolves.toMatchObject({ id: 'card-of-user-a' })
    expect(ctx.world.requests[0]?.authorization).toBe('Bearer token-a-1')
    expect(ctx.world.written).toEqual([expect.objectContaining({ owner: 'user-a' })])
    // ...and the NEXT step is refused.
    await expect(createManualCard({ name: 'next' }, db)).rejects.toBeDefined()
    expect(ctx.world.requests).toHaveLength(1)
  })

  it('every request asks the LIVE session: nothing is cached or replayed from an earlier request', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const db = createLeasedDb(lease, ctx.deps)
    await createManualCard({ name: 'one' }, db)
    ctx.switchToB({ heardYet: false })
    await expect(createManualCard({ name: 'two' }, db)).rejects.toBeDefined()
    expect(ctx.world.requests).toHaveLength(1)
    expect(ctx.world.getSessionCalls).toBe(2)
  })

  it('constructing a leased client neither reads the session nor makes a request, even after the event loop turns', async () => {
    const lease = ctx.world.authority.begin('user-a')
    createLeasedDb(lease, ctx.deps)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ctx.world.getSessionCalls).toBe(0)
    expect(ctx.world.requests).toEqual([])
  })

  it('a lease that is already dead makes no request at all, not even a session lookup', async () => {
    const lease = ctx.world.authority.begin('user-b') // rendered under B, tab is in A
    const db = createLeasedDb(lease, ctx.deps)
    await expect(createManualCard({ name: MARKER }, db)).rejects.toBeDefined()
    expect(ctx.world.getSessionCalls).toBe(0)
    expect(ctx.world.requests).toEqual([])
  })

  it('the aborted operation reports the fixed domain outcome, never a raw transport message', async () => {
    const lease = ctx.world.authority.begin('user-a')
    const error = await runWithLease(lease, () =>
      purchaseSubmission(ctx, lease, () => {
        ctx.switchToB()
      }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AuthIdentityChangedError)
    const text = `${(error as Error).name} ${(error as Error).message}`
    expect(text).not.toMatch(/token|Bearer|stub\.invalid|fetch|Postgrest/i)
    expect(text).not.toContain(MARKER)
  })
})

describe('leased client — the other flows that take a lease', () => {
  it('the exchange-rate step (Edge Function) is authenticated as the lease owner, then refused after a switch', async () => {
    const ctx = makeWorld()
    const lease = ctx.world.authority.begin('user-a')
    const db = createLeasedDb(lease, ctx.deps)
    await expect(fetchFxRate('EUR', '2026-09-01', db)).resolves.toMatchObject({ rate: '11.5' })
    expect(ctx.world.requests[0]?.authorization).toBe('Bearer token-a-1')
    ctx.switchToB()
    await expect(fetchFxRate('EUR', '2026-09-01', db)).rejects.toBeDefined()
    expect(ctx.world.requests).toHaveLength(1)
    expect(lease.isCurrent()).toBe(false)
  })

  it('a sale is written for A, an aborted attempt writes nothing, and a same-identity retry reuses the key', async () => {
    const ctx = makeWorld()
    const first = ctx.world.authority.begin('user-a')
    const dbFirst = createLeasedDb(first, ctx.deps)
    await createSale(
      [{ lotId: 'lot-1', quantity: 1, unitGrossMinor: 1000n }],
      { soldOn: '2026-09-01', currency: 'NOK' },
      'sale-key-1',
      dbFirst,
    )
    // An attempt begun and abandoned across an identity change: no request, nothing for B, and no
    // key consumed on anyone's behalf.
    const second = ctx.world.authority.begin('user-a')
    ctx.switchToB()
    await expect(
      createSale(
        [{ lotId: 'lot-1', quantity: 1, unitGrossMinor: 1000n }],
        { soldOn: '2026-09-01', currency: 'NOK' },
        'sale-key-2',
        createLeasedDb(second, ctx.deps),
      ),
    ).rejects.toBeDefined()
    expect(ctx.world.written.map((w) => [w.table, w.owner])).toEqual([['sales', 'user-a']])
    // B's own, fresh action under B's own lease goes through with its OWN key.
    const bLease = ctx.world.authority.begin('user-b')
    await createSale(
      [{ lotId: 'lot-9', quantity: 1, unitGrossMinor: 5n }],
      { soldOn: '2026-09-01', currency: 'NOK' },
      'sale-key-b',
      createLeasedDb(bLease, ctx.deps),
    )
    const keys = ctx.world.written.map((w) => [
      w.owner,
      (w.payload as { p_idempotency_key: string }).p_idempotency_key,
    ])
    expect(keys).toEqual([
      ['user-a', 'sale-key-1'],
      ['user-b', 'sale-key-b'],
    ])
  })

  it('a same-identity retry after an ambiguous failure re-sends the SAME idempotency key (P138 preserved)', async () => {
    const ctx = makeWorld()
    const lease = ctx.world.authority.begin('user-a')
    const db = createLeasedDb(lease, ctx.deps)
    ctx.world.requestGate = Promise.reject(new TypeError('network died'))
    ctx.world.requestGate.catch(() => undefined)
    await expect(
      createPurchase({ purchasedOn: '2026-09-01', currency: 'NOK', lines: [] }, 'key-A', db),
    ).rejects.toBeDefined()
    expect(lease.isCurrent()).toBe(true) // an ordinary failure is not an identity change
    ctx.world.requestGate = null
    await createPurchase({ purchasedOn: '2026-09-01', currency: 'NOK', lines: [] }, 'key-A', db)
    const sent = ctx.world.requests.map(
      (r) => (r.body as { p_idempotency_key: string }).p_idempotency_key,
    )
    expect(sent).toEqual(['key-A', 'key-A'])
  })

  it('the profile row is named by the LEASE, so a value typed under A can never be applied to B', async () => {
    const ctx = makeWorld()
    const lease = ctx.world.authority.begin('user-a')
    const db = createLeasedDb(lease, ctx.deps)
    await updateMyProfile({ displayName: MARKER }, db)
    expect(ctx.world.requests[0]?.search).toContain('id=eq.user-a')
    ctx.switchToB({ heardYet: false })
    await expect(updateMyProfile({ displayName: MARKER }, db)).rejects.toBeDefined()
    expect(ctx.world.written.filter((w) => w.owner === 'user-b')).toEqual([])
  })
})
