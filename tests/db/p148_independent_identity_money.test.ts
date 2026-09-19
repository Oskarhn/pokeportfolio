import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { createAppSupabaseClient } from '../../src/data/supabase-factory'
import { IdentityAuthority, runWithLease } from '../../src/auth/identity-lease'
import { createLeasedDb, type LeasedDb } from '../../src/data/leased-client'

/**
 * P148 - independent adversarial review of the integrated candidate (identity lease D-136 x exact
 * money D-137 on one client, D-138), against a REAL local PostgREST + PostgreSQL + GoTrue.
 *
 * Deliberately NOT built on tests/db/leased.ts (P147's SimulatedTab). Differences that matter:
 *
 *   SCHEDULING   P145/P147 park a session lookup and release it later. Here a scenario is a
 *                CHECKPOINT MATRIX: the identity action runs INLINE at one of four points on the
 *                request's path (before the session is read, after it was read but before the
 *                provider returns, after the provider chose the token but before the request
 *                leaves, after the server committed but before the caller sees the answer). No
 *                timers, no release handles: every interleaving is deterministic and exhaustive.
 *   ORACLE       The expected outcome of every cell is derived from the identity contract in
 *                docs/DECISIONS.md D-136 ("a request is either not sent, or authenticated as the
 *                lease's user; nothing is sent once the tab has heard the identity end") - not from
 *                what the implementation happens to do - and the money is checked against the
 *                ledger as text (`col::text`, service role) against decimal literals written here.
 *   BOTH AT ONCE Every identity cell uses amounts a JavaScript number cannot hold (2^53+1 and
 *                2^62+12345), so a defect in either protection shows in the same run.
 */

// --- amounts: literals, so the expected values never pass through production code ---------------
const PRICE = '9007199254740993' // 2^53 + 1
const SHIPPING = '4611686018427400249' // 2^62 + 12345
const TOTAL = (BigInt(PRICE) + BigInt(SHIPPING)).toString() // 4620693217682141242
const today = new Date().toISOString().slice(0, 10)

const transport = vi.hoisted(() => ({ client: null as unknown as object }))
vi.mock('../../src/data/supabase-client', () => ({
  supabase: new Proxy(
    {},
    {
      get(_target, property) {
        const target = transport.client as Record<PropertyKey, unknown>
        const value = target[property]
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    },
  ),
}))

import { createPurchase } from '../../src/data/purchases'
import { createSale } from '../../src/data/sales'
import { addCardAcquisition } from '../../src/data/collection'
import { resetMyPortfolioData } from '../../src/data/reset'

type AppClient = ReturnType<typeof createAppSupabaseClient>
interface Person {
  id: string
  client: AppClient
  user: SyntheticUser
}

let service: TestClient
const created: SyntheticUser[] = []
const rewrites: string[] = []

async function signedIn(user: SyntheticUser): Promise<AppClient> {
  const client = createAppSupabaseClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_ANON_KEY as string,
    { onResponseRewrite: (l) => rewrites.push(...l) },
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(error.message)
  return client
}

async function person(label: string): Promise<Person> {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  return { id: user.id, client: await signedIn(user), user }
}

beforeAll(() => {
  service = createServiceClient()
})

afterAll(async () => {
  for (const user of created) await deleteSyntheticUser(service, user.id)
}, 600_000)

// --- the tab: checkpoints instead of parking ------------------------------------------------------

type Checkpoint = 'before-session' | 'after-session' | 'before-dispatch' | 'after-dispatch'
type Action = 'none' | 'refresh' | 'switch-heard' | 'switch-unheard' | 'sign-out' | 'a-b-a'

interface Wire {
  method: string
  path: string
  bearerSub: string | null
  body: string
}

function subOf(authorization: string | null): string | null {
  const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
  const payload = token?.split('.')[1]
  if (payload === undefined) return null
  try {
    return (
      (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub ??
      null
    )
  } catch {
    return null
  }
}

class Tab {
  readonly authority = new IdentityAuthority()
  readonly wire: Wire[] = []
  /** What a lookup returns instead of the storage, for the transient-failure cell. */
  sessionOverride: (() => Promise<{ data: { session: null }; error: Error }>) | null = null
  private readonly queued: Partial<Record<Checkpoint, (() => Promise<void> | void)[]>> = {}

  storage: Person | null
  private readonly a: Person
  private readonly b: Person

  constructor(storage: Person | null, a: Person, b: Person) {
    this.storage = storage
    this.a = a
    this.b = b
    this.authority.observe(storage?.id ?? null)
  }

  /** Run `action` (once) when the next request reaches `checkpoint`. */
  at(checkpoint: Checkpoint, action: Action): void {
    ;(this.queued[checkpoint] ??= []).push(() => this.perform(action))
  }

  /** Block the next request at `checkpoint` until `release()`; `arrived` settles when it got there. */
  hold(checkpoint: Checkpoint): { arrived: Promise<void>; release: () => void } {
    let arrive: () => void = () => undefined
    let release: () => void = () => undefined
    const arrived = new Promise<void>((resolve) => (arrive = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    ;(this.queued[checkpoint] ??= []).push(async () => {
      arrive()
      await gate
    })
    return { arrived, release }
  }

  /** Make the next request fail at `checkpoint` (after-dispatch = the server committed, the answer is lost). */
  failAt(checkpoint: Checkpoint, error: Error): void {
    ;(this.queued[checkpoint] ??= []).push(() => {
      throw error
    })
  }

  private async fire(checkpoint: Checkpoint): Promise<void> {
    await this.queued[checkpoint]?.shift()?.()
  }

  async perform(action: Action): Promise<void> {
    switch (action) {
      case 'none':
        return
      case 'refresh': {
        const refreshed = await this.a.client.auth.refreshSession()
        if (refreshed.error) throw new Error(refreshed.error.message)
        this.authority.observe(this.a.id) // TOKEN_REFRESHED: same user, must change nothing
        return
      }
      case 'switch-heard':
        this.storage = this.b
        this.authority.observe(this.b.id)
        return
      case 'switch-unheard':
        this.storage = this.b // the browser storage moved on; this tab has not been told yet
        return
      case 'sign-out':
        this.storage = null
        this.authority.observe(null)
        return
      case 'a-b-a':
        this.storage = this.b
        this.authority.observe(this.b.id)
        this.storage = this.a
        this.authority.observe(this.a.id)
        return
    }
  }

  readonly getSession = async () => {
    await this.fire('before-session')
    if (this.sessionOverride) return this.sessionOverride()
    const result = this.storage
      ? await this.storage.client.auth.getSession()
      : { data: { session: null } }
    await this.fire('after-session')
    return result
  }

  private readonly transportFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    await this.fire('before-dispatch')
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    this.wire.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      bearerSub: subOf(new Headers(init?.headers).get('authorization')),
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const response = await fetch(input, init)
    await this.fire('after-dispatch')
    return response
  }

  /** A fresh click on the currently RENDERED identity (the person whose form is on screen). */
  leaseFor(rendered: Person) {
    return this.authority.begin(rendered.id)
  }

  dbFor(lease: ReturnType<Tab['leaseFor']>): LeasedDb {
    return createLeasedDb(lease, {
      url: process.env.SUPABASE_URL as string,
      publishableKey: process.env.SUPABASE_ANON_KEY as string,
      getSession: this.getSession,
      fetch: this.transportFetch,
      transport: { onResponseRewrite: (l) => rewrites.push(...l) },
    })
  }

  requestsFor(fn: string): Wire[] {
    return this.wire.filter((r) => r.path.endsWith(`/rpc/${fn}`))
  }
}

// --- ledger witnesses (service role, text columns) ----------------------------------------------

async function purchasesWithNote(note: string) {
  const { data, error } = await service
    .from('purchases')
    .select('id, user_id, subtotal_minor::text, shipping_minor::text, total_minor::text, notes')
    .eq('notes', note)
  if (error) throw new Error(error.message)
  return data as unknown as {
    id: string
    user_id: string
    subtotal_minor: string
    shipping_minor: string
    total_minor: string
  }[]
}

async function salesWithNote(note: string) {
  const { data, error } = await service
    .from('sales')
    .select(
      'id, user_id, gross_minor::text, fees_minor::text, net_proceeds_minor::text, ' +
        'proceeds_from_uncosted_nok_minor::text, realized_result_nok_minor::text, notes',
    )
    .eq('notes', note)
  if (error) throw new Error(error.message)
  return data as unknown as {
    id: string
    user_id: string
    gross_minor: string
    fees_minor: string
    net_proceeds_minor: string
    proceeds_from_uncosted_nok_minor: string
    realized_result_nok_minor: string | null
  }[]
}

const purchaseInput = (note: string) => ({
  purchasedOn: today,
  currency: 'NOK',
  lines: [
    {
      lineType: 'accessory' as const,
      description: 'p148',
      quantity: 1,
      unitPriceMinor: BigInt(PRICE),
    },
  ],
  shippingMinor: BigInt(SHIPPING),
  notes: note,
})

async function lot(db: LeasedDb, kind: 'unknown' | { knownCost: bigint }): Promise<string> {
  const { lotId } = await addCardAcquisition(
    {
      cardVariantId: seedCatalog.charizardVariantId,
      gradingState: 'raw',
      condition: 'NM',
      origin: kind === 'unknown' ? 'pre_tracking' : 'purchase',
      costBasisState: kind === 'unknown' ? 'unknown' : 'known',
      unitCostBasisMinor: kind === 'unknown' ? undefined : kind.knownCost,
      quantity: 1,
      acquiredOn: today,
      clientRequestKey: crypto.randomUUID(),
    },
    db,
  )
  return lotId
}

// --- the contract, as a table -------------------------------------------------------------------

/**
 * How many requests may/must be made, derived from the contract, per (checkpoint, action):
 *   - the token is chosen by the provider after its last await. Anything that happens at or after
 *     'before-dispatch' cannot change whose request it is: it completes as A (one row).
 *   - before that, an action the tab HEARD (or that is visible in the credentials it reads) ends
 *     the operation: no request at all.
 *   - the one honest exception: at 'after-session' an UNHEARD switch cannot be seen by the tab, and
 *     the credentials it already read were A's, so the request is authenticated as A.
 * A same-user refresh never ends anything.
 */
function expectedRequests(checkpoint: Checkpoint, action: Action): 0 | 1 {
  if (action === 'none' || action === 'refresh') return 1
  if (checkpoint === 'before-dispatch' || checkpoint === 'after-dispatch') return 1
  if (checkpoint === 'after-session' && action === 'switch-unheard') return 1
  return 0
}

const CHECKPOINTS: Checkpoint[] = [
  'before-session',
  'after-session',
  'before-dispatch',
  'after-dispatch',
]
const ACTIONS: Action[] = ['none', 'refresh', 'switch-heard', 'switch-unheard', 'sign-out', 'a-b-a']
const CELLS = CHECKPOINTS.flatMap((checkpoint) => ACTIONS.map((action) => ({ checkpoint, action })))

describe('purchase with amounts above 2^53: every interleaving of the identity events', () => {
  it.each(CELLS)('$action at $checkpoint', async ({ checkpoint, action }) => {
    const A = await person('p148-pa')
    const B = await person('p148-pb')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const note = `p148-purchase-${checkpoint}-${action}-${crypto.randomUUID()}`
    const key = crypto.randomUUID()
    const lease = tab.leaseFor(A)
    tab.at(checkpoint, action)

    const outcome = await runWithLease(lease, () =>
      createPurchase(purchaseInput(note), key, tab.dbFor(lease)),
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    const want = expectedRequests(checkpoint, action)
    const rows = await purchasesWithNote(note)
    // never anything under B, never a request authenticated as B, never a second row
    expect(rows.filter((r) => r.user_id === B.id)).toEqual([])
    expect(tab.wire.filter((r) => r.bearerSub !== A.id)).toEqual([])
    expect(tab.requestsFor('create_purchase')).toHaveLength(want)
    expect(rows).toHaveLength(want)
    if (want === 1) {
      expect(rows[0]).toMatchObject({
        user_id: A.id,
        subtotal_minor: PRICE,
        shipping_minor: SHIPPING,
        total_minor: TOTAL,
      })
      // the request itself carried the amounts as text, and no number literal of the money fields
      expect(tab.wire[0]?.body).toContain(`"unit_price_minor":"${PRICE}"`)
      expect(tab.wire[0]?.body).toContain(`"p_shipping_minor":"${SHIPPING}"`)
      // a success reached the caller with the exact amounts, or the answer was legitimately lost
      if (outcome.ok) {
        expect(outcome.value.totalMinor.toString()).toBe(TOTAL)
      }
    } else {
      expect(outcome.ok).toBe(false)
    }
    expect(rewrites).toEqual([])
  })
})

describe('sale with unknown basis and a NEGATIVE net above 2^53 in magnitude: every interleaving', () => {
  const GROSS = 100n
  const FEES = BigInt(SHIPPING) + 100n // net = -(2^62 + 12345)
  it.each(CELLS)('$action at $checkpoint', async ({ checkpoint, action }) => {
    const A = await person('p148-sa')
    const B = await person('p148-sb')
    transport.client = A.client
    const seedTab = new Tab(A, A, B)
    const seedLease = seedTab.leaseFor(A)
    const lotId = await lot(seedTab.dbFor(seedLease), 'unknown')

    const tab = new Tab(A, A, B)
    const note = `p148-sale-${checkpoint}-${action}-${crypto.randomUUID()}`
    const lease = tab.leaseFor(A)
    tab.at(checkpoint, action)
    await runWithLease(lease, () =>
      createSale(
        [{ lotId, quantity: 1, unitGrossMinor: GROSS }],
        { soldOn: today, currency: 'NOK', feesMinor: FEES, notes: note },
        crypto.randomUUID(),
        tab.dbFor(lease),
      ),
    ).catch(() => undefined)

    const want = expectedRequests(checkpoint, action)
    const rows = await salesWithNote(note)
    expect(rows.filter((r) => r.user_id === B.id)).toEqual([])
    expect(tab.wire.filter((r) => r.bearerSub !== A.id)).toEqual([])
    expect(rows).toHaveLength(want)
    if (want === 1) {
      const net = (GROSS - FEES).toString() // BigInt arithmetic written here, not the helper's
      expect(rows[0]).toMatchObject({
        user_id: A.id,
        gross_minor: GROSS.toString(),
        fees_minor: FEES.toString(),
        net_proceeds_minor: net,
        proceeds_from_uncosted_nok_minor: net, // signed, not clamped, not rounded
        realized_result_nok_minor: null, // unknown basis stays unknown - not 0
      })
    }
    // A's lot is disposed exactly when the sale exists
    const { data: lotRow } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', lotId)
      .single()
    expect((lotRow as { quantity_remaining: number }).quantity_remaining).toBe(1 - want)
    expect(rewrites).toEqual([])
  })
})

describe('portfolio reset: a confirmation given by A is never executed as B', () => {
  it.each(CELLS)('$action at $checkpoint', async ({ checkpoint, action }) => {
    const A = await person('p148-ra')
    const B = await person('p148-rb')
    transport.client = A.client
    // one purchase each, so a wrong-bearer reset would be visible
    const seedTab = new Tab(A, A, B)
    const noteA = `p148-reset-a-${crypto.randomUUID()}`
    const noteB = `p148-reset-b-${crypto.randomUUID()}`
    const seedA = seedTab.leaseFor(A)
    await createPurchase(purchaseInput(noteA), crypto.randomUUID(), seedTab.dbFor(seedA))
    const tabB = new Tab(B, A, B)
    const seedB = tabB.leaseFor(B)
    await createPurchase(purchaseInput(noteB), crypto.randomUUID(), tabB.dbFor(seedB))

    const tab = new Tab(A, A, B)
    const lease = tab.leaseFor(A)
    tab.at(checkpoint, action)
    await runWithLease(lease, () => resetMyPortfolioData(tab.dbFor(lease))).catch(() => undefined)

    const want = expectedRequests(checkpoint, action)
    expect(tab.requestsFor('reset_my_portfolio_data')).toHaveLength(want)
    expect(tab.wire.filter((r) => r.bearerSub !== A.id)).toEqual([])
    // B's data survives every cell; A's is gone exactly when the reset was dispatched
    expect(await purchasesWithNote(noteB)).toHaveLength(1)
    expect(await purchasesWithNote(noteA)).toHaveLength(1 - want)
  })
})

describe('several operations pending at once, completing in different orders', () => {
  it('P1 already dispatched, A -> B heard, P2 starts afterwards: P1 completes as A, P2 never leaves, none under B', async () => {
    const A = await person('p148-ma')
    const B = await person('p148-mb')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const leaseP1 = tab.leaseFor(A)
    const leaseP2 = tab.leaseFor(A) // both clicked while A was on screen
    const n1 = `p148-multi-1-${crypto.randomUUID()}`
    const n2 = `p148-multi-2-${crypto.randomUUID()}`

    // P1's request is at the network layer when the switch happens
    tab.at('before-dispatch', 'switch-heard')
    const p1 = runWithLease(leaseP1, () =>
      createPurchase(purchaseInput(n1), crypto.randomUUID(), tab.dbFor(leaseP1)),
    )
    const r1 = await p1
    // the delayed continuation of P2 begins only now
    const p2 = await runWithLease(leaseP2, () =>
      createPurchase(purchaseInput(n2), crypto.randomUUID(), tab.dbFor(leaseP2)),
    ).then(
      () => 'completed',
      () => 'refused',
    )

    expect(r1.totalMinor.toString()).toBe(TOTAL)
    expect(p2).toBe('refused')
    expect((await purchasesWithNote(n1)).map((r) => [r.user_id, r.total_minor])).toEqual([
      [A.id, TOTAL],
    ])
    expect(await purchasesWithNote(n2)).toEqual([])
    expect(tab.wire.filter((r) => r.bearerSub !== A.id)).toEqual([])
  })

  it('two dispatched together, answers delivered in the opposite order, identity changes in between', async () => {
    const A = await person('p148-mc')
    const B = await person('p148-md')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const l1 = tab.leaseFor(A)
    const l2 = tab.leaseFor(A)
    const n1 = `p148-order-1-${crypto.randomUUID()}`
    const n2 = `p148-order-2-${crypto.randomUUID()}`
    // each request is held AFTER the server committed it; released in reverse order of arrival
    const h1 = tab.hold('after-dispatch')
    const h2 = tab.hold('after-dispatch')
    const p1 = runWithLease(l1, () =>
      createPurchase(purchaseInput(n1), crypto.randomUUID(), tab.dbFor(l1)),
    )
    const p2 = runWithLease(l2, () =>
      createPurchase(purchaseInput(n2), crypto.randomUUID(), tab.dbFor(l2)),
    )
    await Promise.all([h1.arrived, h2.arrived])
    // both are committed on the server; the browser now moves to B
    await tab.perform('switch-heard')
    h2.release() // answers come back in the opposite order of dispatch
    h1.release()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.totalMinor.toString()).toBe(TOTAL)
    expect(r2.totalMinor.toString()).toBe(TOTAL)
    for (const note of [n1, n2]) {
      expect((await purchasesWithNote(note)).map((r) => [r.user_id, r.total_minor])).toEqual([
        [A.id, TOTAL],
      ])
    }
    expect(tab.wire.filter((r) => r.bearerSub !== A.id)).toEqual([])
    // B, acting now with its own lease, is unaffected by anything A had pending
    const lb = tab.leaseFor(B)
    const nb = `p148-order-b-${crypto.randomUUID()}`
    await createPurchase(purchaseInput(nb), crypto.randomUUID(), tab.dbFor(lb))
    expect((await purchasesWithNote(nb)).map((r) => r.user_id)).toEqual([B.id])
  })
})

describe('failure paths of the credential lookup', () => {
  it('a lookup that reports "no session" together with an error (a failed token refresh) sends nothing and writes nothing', async () => {
    const A = await person('p148-fa')
    const B = await person('p148-fb')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    tab.sessionOverride = () =>
      Promise.resolve({ data: { session: null }, error: new Error('network') })
    const lease = tab.leaseFor(A)
    const note = `p148-lookup-failure-${crypto.randomUUID()}`
    await expect(
      runWithLease(lease, () =>
        createPurchase(purchaseInput(note), crypto.randomUUID(), tab.dbFor(lease)),
      ),
    ).rejects.toBeDefined()
    expect(tab.wire).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])
  })

  it('a lookup that throws sends nothing, writes nothing, and leaves the lease usable for the retry', async () => {
    const A = await person('p148-ga')
    const B = await person('p148-gb')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    let failNext = true
    const realLookup = tab.getSession
    const flaky = {
      getSession: async () => {
        if (failNext) {
          failNext = false
          throw new TypeError('Failed to fetch')
        }
        return realLookup()
      },
    }
    const lease = tab.leaseFor(A)
    const db = createLeasedDb(lease, {
      url: process.env.SUPABASE_URL as string,
      publishableKey: process.env.SUPABASE_ANON_KEY as string,
      getSession: flaky.getSession,
    })
    const note = `p148-lookup-throws-${crypto.randomUUID()}`
    const key = crypto.randomUUID()
    await expect(createPurchase(purchaseInput(note), key, db)).rejects.toThrow()
    expect(await purchasesWithNote(note)).toEqual([])
    expect(lease.isCurrent()).toBe(true) // a network failure is not an identity change
    // the same lease, the same key: one row, exact
    const purchase = await createPurchase(purchaseInput(note), key, db)
    expect(purchase.totalMinor.toString()).toBe(TOTAL)
    expect(await purchasesWithNote(note)).toHaveLength(1)
  })
})

describe('after an ambiguous failure (server committed, answer lost) the retry is scoped to the right user', () => {
  it("A retries with the same key: one row. B using the SAME key value creates B's own row and replays nothing of A", async () => {
    const A = await person('p148-ka')
    const B = await person('p148-kb')
    transport.client = A.client
    const key = crypto.randomUUID()
    const note = `p148-retry-${crypto.randomUUID()}`

    const tab = new Tab(A, A, B)
    const first = tab.leaseFor(A)
    // the answer to the first attempt is lost after the server committed
    tab.failAt('after-dispatch', new TypeError('Failed to fetch'))
    await expect(createPurchase(purchaseInput(note), key, tab.dbFor(first))).rejects.toThrow()
    expect(await purchasesWithNote(note)).toHaveLength(1)

    // same user, same key, fresh lease (a retry of the same form): the ORIGINAL purchase, no second row
    const retry = tab.leaseFor(A)
    const again = await createPurchase(purchaseInput(note), key, tab.dbFor(retry))
    expect(again.totalMinor.toString()).toBe(TOTAL)
    expect(await purchasesWithNote(note)).toHaveLength(1)

    // B, same key value, its own lease: a NEW purchase owned by B; nothing of A's is returned
    await tab.perform('switch-heard')
    const b = tab.leaseFor(B)
    const noteB = `p148-retry-b-${crypto.randomUUID()}`
    const bPurchase = await createPurchase(purchaseInput(noteB), key, tab.dbFor(b))
    expect((await purchasesWithNote(noteB)).map((r) => r.user_id)).toEqual([B.id])
    expect(bPurchase.id).not.toBe(again.id)
    expect(await purchasesWithNote(note)).toHaveLength(1) // A's row untouched
  })
})

describe('idempotency: financial equality across representations and changes (raw RPC through the leased client)', () => {
  interface Base {
    p_lines: Record<string, unknown>[]
    [k: string]: unknown
  }
  const base = (over: Record<string, unknown> = {}): Base => ({
    p_purchased_on: today,
    p_currency: 'NOK',
    p_lines: [
      { line_type: 'accessory', description: 'p148 idem', quantity: 1, unit_price_minor: PRICE },
    ],
    p_shipping_minor: '5',
    ...over,
  })

  async function call(db: LeasedDb, key: string, args: Base) {
    return db
      .rpc('create_purchase', { ...args, p_idempotency_key: key } as never)
      .select('id, subtotal_minor::text, total_minor::text')
      .single()
  }

  async function rowsFor(userId: string, key: string) {
    const { data } = await service
      .from('purchases')
      .select('id, subtotal_minor::text, shipping_minor::text')
      .eq('user_id', userId)
      .eq('idempotency_key', key)
    return data as unknown as { id: string; subtotal_minor: string; shipping_minor: string }[]
  }

  it('identical logical retry replays; each changed financial field is refused and the stored row never changes', async () => {
    const A = await person('p148-ia')
    const B = await person('p148-ib')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const db = tab.dbFor(tab.leaseFor(A))
    const key = crypto.randomUUID()

    const first = await call(db, key, base())
    expect(first.error).toBeNull()
    const id = (first.data as unknown as { id: string }).id

    // (1) same request, object properties in another order: the SAME purchase, no false conflict
    const reordered = await call(
      db,
      key,
      base({
        p_lines: [
          {
            unit_price_minor: PRICE,
            quantity: 1,
            description: 'p148 idem',
            line_type: 'accessory',
          },
        ],
      }),
    )
    expect(reordered.error).toBeNull()
    expect((reordered.data as unknown as { id: string }).id).toBe(id)

    // (2) every material change is refused under the same key
    const changes: [string, Record<string, unknown>][] = [
      [
        'unit price +1 minor unit above 2^53',
        {
          p_lines: [
            {
              line_type: 'accessory',
              description: 'p148 idem',
              quantity: 1,
              unit_price_minor: '9007199254740994',
            },
          ],
        },
      ],
      [
        'unit price -1 (the same double as 2^53)',
        {
          p_lines: [
            {
              line_type: 'accessory',
              description: 'p148 idem',
              quantity: 1,
              unit_price_minor: '9007199254740992',
            },
          ],
        },
      ],
      ['shipping +1', { p_shipping_minor: '6' }],
      [
        'date',
        { p_purchased_on: new Date(Date.now() - 86_400_000 * 3).toISOString().slice(0, 10) },
      ],
      [
        'quantity',
        {
          p_lines: [
            {
              line_type: 'accessory',
              description: 'p148 idem',
              quantity: 2,
              unit_price_minor: PRICE,
            },
          ],
        },
      ],
      [
        'known zero manual value added where none existed (NULL vs 0)',
        {
          p_lines: [
            {
              line_type: 'accessory',
              description: 'p148 idem',
              quantity: 1,
              unit_price_minor: PRICE,
              manual_value_minor: '0',
            },
          ],
        },
      ],
    ]
    for (const [label, over] of changes) {
      const result = await call(db, key, base(over))
      expect(result.error?.message ?? `NOT REFUSED: ${label}`, label).toContain(
        'idempotency-key-reuse',
      )
    }
    const rows = await rowsFor(A.id, key)
    expect(rows).toEqual([{ id, subtotal_minor: PRICE, shipping_minor: '5' }])

    // (3) the same key VALUE under another user is that user's own request, not A's replay
    const tabB = new Tab(B, A, B)
    const bDb = tabB.dbFor(tabB.leaseFor(B))
    const other = await call(bDb, key, base({ p_shipping_minor: '9' }))
    expect(other.error).toBeNull()
    expect((other.data as unknown as { id: string }).id).not.toBe(id)
    expect(await rowsFor(A.id, key)).toHaveLength(1)
    expect(await rowsFor(B.id, key)).toHaveLength(1)
  })

  it('a changed FX rate or currency under the same key is refused (foreign-currency purchase)', async () => {
    const A = await person('p148-ic')
    const B = await person('p148-id')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const db = tab.dbFor(tab.leaseFor(A))
    const key = crypto.randomUUID()
    const eur = (over: Record<string, unknown> = {}) =>
      base({
        p_currency: 'EUR',
        p_fx_rate_to_nok: '11.5',
        p_fx_rate_date: today,
        p_fx_source: 'manual',
        p_shipping_minor: undefined,
        ...over,
      })
    expect((await call(db, key, eur())).error).toBeNull()
    expect((await call(db, key, eur({ p_fx_rate_to_nok: '11.6' }))).error?.message).toContain(
      'idempotency-key-reuse',
    )
    expect((await call(db, key, eur({ p_currency: 'USD' }))).error?.message).toContain(
      'idempotency-key-reuse',
    )
    // the same rate written with trailing zeros is the same number: a replay, not a conflict
    expect((await call(db, key, eur({ p_fx_rate_to_nok: '11.50000000' }))).error).toBeNull()
    expect(await rowsFor(A.id, key)).toHaveLength(1)
  })

  it('an unsafe JSON NUMBER for the amount is refused by the client and never reaches the database', async () => {
    const A = await person('p148-ie')
    const B = await person('p148-if')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const db = tab.dbFor(tab.leaseFor(A))
    const key = crypto.randomUUID()
    const { error } = await call(
      db,
      key,
      base({
        p_lines: [
          {
            line_type: 'accessory',
            description: 'p148 idem',
            quantity: 1,
            unit_price_minor: Number(9007199254740993n),
          },
        ],
      }),
    )
    expect(error?.message ?? '').toContain('refusing request body')
    expect(tab.wire).toEqual([])
    expect(await rowsFor(A.id, key)).toEqual([])
  })

  it('CHARACTERISATION (not a requirement): a JSON number and the same amount as text are different requests for the same key', async () => {
    // Cross-version note. The released client sent unit_price_minor as a JSON number; the integrated
    // client sends decimal text. Under one idempotency key the two are compared as jsonb values
    // (number != string), so a retry that crossed a client upgrade would be REFUSED, never duplicated.
    // Keys live in one form instance (memory only), so a bundle change always mints a new key.
    const A = await person('p148-ig')
    const B = await person('p148-ih')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const db = tab.dbFor(tab.leaseFor(A))
    const key = crypto.randomUUID()
    const line = (price: unknown) => ({
      p_lines: [{ line_type: 'accessory', description: 'x', quantity: 1, unit_price_minor: price }],
    })
    expect(
      (await call(db, key, base({ ...line('1000'), p_shipping_minor: undefined }))).error,
    ).toBeNull()
    const numeric = await call(db, key, base({ ...line(1000), p_shipping_minor: undefined }))
    expect(numeric.error?.message ?? 'REPLAYED').toContain('idempotency-key-reuse')
    expect(await rowsFor(A.id, key)).toHaveLength(1)
  })
})

describe('unknown basis is not zero, through the integrated data layer', () => {
  it('a sale of an unknown-basis lot has realized NULL; the same sale of a known-zero-basis lot has a realized result', async () => {
    const A = await person('p148-za')
    const B = await person('p148-zb')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const db = tab.dbFor(tab.leaseFor(A))
    const unknownLot = await lot(db, 'unknown')
    const zeroLot = await lot(db, { knownCost: 0n })
    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id, cost_basis_state, unit_cost_basis_minor::text')
      .in('id', [unknownLot, zeroLot])
    const byId = new Map(
      (
        lots as unknown as {
          id: string
          cost_basis_state: string
          unit_cost_basis_minor: string | null
        }[]
      ).map((l) => [l.id, l]),
    )
    expect(byId.get(unknownLot)).toMatchObject({
      cost_basis_state: 'unknown',
      unit_cost_basis_minor: null,
    })
    expect(byId.get(zeroLot)).toMatchObject({
      cost_basis_state: 'known',
      unit_cost_basis_minor: '0',
    })

    const noteU = `p148-null-${crypto.randomUUID()}`
    const noteZ = `p148-zero-${crypto.randomUUID()}`
    const gross = BigInt(PRICE)
    const returnedU = await createSale(
      [{ lotId: unknownLot, quantity: 1, unitGrossMinor: gross }],
      { soldOn: today, currency: 'NOK', notes: noteU },
      crypto.randomUUID(),
      tab.dbFor(tab.leaseFor(A)),
    )
    const returnedZ = await createSale(
      [{ lotId: zeroLot, quantity: 1, unitGrossMinor: gross }],
      { soldOn: today, currency: 'NOK', notes: noteZ },
      crypto.randomUUID(),
      tab.dbFor(tab.leaseFor(A)),
    )
    // what the data layer hands the UI: NULL stays null, a known zero basis gives a real result
    expect(returnedU.realizedResultNokMinor).toBeNull()
    expect(returnedZ.realizedResultNokMinor).toBe(gross)
    const [u] = await salesWithNote(noteU)
    const [z] = await salesWithNote(noteZ)
    expect(u?.realized_result_nok_minor).toBeNull()
    expect(u?.proceeds_from_uncosted_nok_minor).toBe(PRICE)
    expect(z?.realized_result_nok_minor).toBe(PRICE) // net - 0, a real number
    expect(z?.proceeds_from_uncosted_nok_minor).toBe('0')
  })
})

describe('the completed-event date contract (1996-10-20 .. UTC today + 1), through the leased client', () => {
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const cases: [string, string, boolean][] = [
    ['the first Pokemon TCG release day', '1996-10-20', true],
    ['the day before it', '1996-10-19', false],
    ['year 0001', '0001-01-01', false],
    ['UTC today', day(0), true],
    ['UTC today + 1 (the earliest time zone already there)', day(1), true],
    ['UTC today + 2', day(2), false],
    ['year 9999', '9999-12-31', false],
  ]
  it.each(cases)('purchase and acquisition dated %s (%s)', async (_label, date, accepted) => {
    const A = await person('p148-da')
    const B = await person('p148-db')
    transport.client = A.client
    const tab = new Tab(A, A, B)
    const db = tab.dbFor(tab.leaseFor(A))
    const purchase = await db
      .rpc('create_purchase', {
        p_purchased_on: date,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'accessory',
            description: 'p148 date',
            quantity: 1,
            unit_price_minor: '100',
          },
        ],
        p_idempotency_key: crypto.randomUUID(),
      } as never)
      .select('id')
      .single()
    const acquisition = await db
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.charizardVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 1,
        p_acquired_on: date,
        p_client_request_key: crypto.randomUUID(),
      } as never)
      .single()
    if (accepted) {
      expect(purchase.error).toBeNull()
      expect(acquisition.error).toBeNull()
    } else {
      // a NAMED domain error, not a raw constraint violation
      expect(purchase.error?.message ?? '').toContain('invalid-event-date')
      expect(acquisition.error?.message ?? '').toContain('invalid-event-date')
    }
  })
})
