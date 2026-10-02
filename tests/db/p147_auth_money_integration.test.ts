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
import { AuthIdentityChangedError, runWithLease } from '../../src/auth/identity-lease'
import { SimulatedTab, type TabUser } from './leased'

/**
 * P147 — identity lease (D-136) and exact-money transport (D-137) on ONE client (D-138), against a
 * REAL local PostgREST + PostgreSQL + GoTrue:
 *
 *   SimulatedTab (real IdentityAuthority, real GoTrue sessions, real refreshSession)
 *     -> production createLeasedDb (accessToken provider + exact-transport guard)
 *     -> supabase-js -> PostgREST -> PostgreSQL -> and back
 *
 * Every assertion about ownership or money is made against the LEDGER through the service role
 * (`col::text`, so the witness cannot lose digits either), never against what the client reports.
 * The only test double is the fetch wrapper that records what left the browser and, for the
 * "ambiguous failure" cases, drops one response after the server committed.
 */

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

const SAFE = BigInt(Number.MAX_SAFE_INTEGER) // 2^53 - 1
const BIG = SAFE + 2n // 2^53 + 1 — a double cannot hold it
const HUGE = 2n ** 62n + 12345n
const today = new Date().toISOString().slice(0, 10)

let service: TestClient
const created: SyntheticUser[] = []
let userA: TabUser
let userB: TabUser
const rewrites: string[] = []

async function signedInClient(user: SyntheticUser) {
  const client = createAppSupabaseClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_ANON_KEY as string,
    { onResponseRewrite: (literals) => rewrites.push(...literals) },
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(error.message)
  return client
}

beforeAll(async () => {
  service = createServiceClient()
  const a = await createSyntheticUser(service, 'p147-a')
  const b = await createSyntheticUser(service, 'p147-b')
  created.push(a, b)
  userA = { id: a.id, client: await signedInClient(a) }
  userB = { id: b.id, client: await signedInClient(b) }
  transport.client = userA.client
})

afterAll(async () => {
  for (const user of created) await deleteSyntheticUser(service, user.id)
})

function tabAs(user: TabUser) {
  return new SimulatedTab(user, { onResponseRewrite: (l) => rewrites.push(...l) })
}

const line = (unitPriceMinor: bigint) => ({
  lineType: 'accessory' as const,
  description: 'p147',
  quantity: 1,
  unitPriceMinor,
})

const purchaseInput = (marker: string, amount: bigint) => ({
  purchasedOn: today,
  currency: 'NOK',
  lines: [line(amount)],
  notes: marker,
})

interface LedgerRow {
  id: string
  user_id: string
  subtotal_minor: string
  idempotency_key: string | null
}

async function purchasesByKey(key: string): Promise<LedgerRow[]> {
  const { data, error } = await service
    .from('purchases')
    .select('id, user_id, subtotal_minor::text, idempotency_key')
    .eq('idempotency_key', key)
  if (error) throw new Error(error.message)
  return data
}

async function salesByKey(key: string) {
  const { data, error } = await service
    .from('sales')
    .select('id, user_id, gross_minor::text')
    .eq('idempotency_key', key)
  if (error) throw new Error(error.message)
  return data as unknown as { id: string; user_id: string; gross_minor: string }[]
}

/** A lot with `quantity` units, bought for `unitPrice`, owned by `user` (through its own lease). */
async function lotOf(user: TabUser, quantity: number, unitPrice = 1000n): Promise<string> {
  const tab = tabAs(user)
  const lease = tab.leaseFor(user)
  const purchase = await createPurchase(
    {
      purchasedOn: today,
      currency: 'NOK',
      lines: [
        {
          lineType: 'card' as const,
          cardVariantId: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity,
          unitPriceMinor: unitPrice,
        },
      ],
    },
    crypto.randomUUID(),
    tab.dbFor(lease),
  )
  const { data: lines } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
  const { data: lot, error } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', (lines as { id: string }[])[0]!.id)
    .single()
  if (error) throw new Error(error.message)
  return lot.id
}

describe('normal authenticated request: A bearer, exact money, stored under A', () => {
  it('an amount above 2^53 crosses the leased client, PostgREST and PostgreSQL digit for digit', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const purchase = await runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-normal', BIG), key, tab.dbFor(lease)),
    )
    expect(purchase.subtotalMinor).toBe(BIG)
    expect(purchase.totalNokMinor).toBe(BIG)
    const rows = await purchasesByKey(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.user_id).toBe(userA.id)
    expect(rows[0]?.subtotal_minor).toBe(BIG.toString())
    // The request left as ONE decimal string under A's bearer.
    const rpc = tab.wire.filter((r) => r.path.endsWith('/rpc/create_purchase'))
    expect(rpc).toHaveLength(1)
    expect(rpc[0]?.bearerSub).toBe(userA.id)
    expect(rpc[0]?.body).toContain('"unit_price_minor":"9007199254740993"')
    expect(rpc[0]?.body).not.toMatch(/"unit_price_minor":\d/)
    expect(rewrites).toEqual([])
  })

  it('the 2^62 scale, on a charge as well as on a line', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const purchase = await createPurchase(
      { ...purchaseInput('p147-huge', HUGE), shippingMinor: BIG },
      key,
      tab.dbFor(lease),
    )
    expect(purchase.subtotalMinor).toBe(HUGE)
    expect(purchase.shippingMinor).toBe(BIG)
    expect(purchase.totalMinor).toBe(HUGE + BIG)
    const rows = await purchasesByKey(key)
    expect(rows[0]?.subtotal_minor).toBe(HUGE.toString())
  })
})

describe('the exact-transport guard is on the leased client (real PostgREST)', () => {
  it('an accidental unsafe JSON number is refused before it leaves, and nothing is written', async () => {
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const key = crypto.randomUUID()
    const { error } = await db.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      // The historical bug: Number(bigint) at the boundary. 2^53 + 1 becomes 2^53 on the way.
      p_lines: [
        { line_type: 'accessory', description: 'p147', quantity: 1, unit_price_minor: Number(BIG) },
      ],
      p_idempotency_key: key,
    })
    expect(error?.message ?? '').toContain('refusing request body')
    expect(tab.wire).toEqual([])
    expect(await purchasesByKey(key)).toEqual([])
  })

  it('the same amount as a decimal string passes the same client and is stored exactly', async () => {
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const key = crypto.randomUUID()
    const { error } = await db
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'accessory',
            description: 'p147',
            quantity: 1,
            unit_price_minor: BIG.toString(),
          },
        ],
        p_idempotency_key: key,
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    expect((await purchasesByKey(key)).map((r) => r.subtotal_minor)).toEqual([BIG.toString()])
  })
})

describe('identity change under a running operation (real GoTrue sessions)', () => {
  it("A -> B before dispatch: nothing is written for anybody and no request carries B's bearer", async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const release = tab.parkNextSessionLookup()
    const outcome = runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-a2b', BIG), key, tab.dbFor(lease)),
    )
    await tab.untilLookupParked(0)
    tab.switchTo(userB)
    release()

    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(await purchasesByKey(key)).toEqual([])
    expect(tab.wire).toEqual([])
    expect(tab.requestsNotFrom(userA.id)).toEqual([])
  })

  it('EVENT GAP: the browser already holds B but this tab has not heard yet — refused from the credentials', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const release = tab.parkNextSessionLookup()
    const outcome = runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-gap', BIG), key, tab.dbFor(lease)),
    )
    await tab.untilLookupParked(0)
    tab.switchTo(userB, { heard: false })
    release()

    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(await purchasesByKey(key)).toEqual([])
    expect(tab.wire).toEqual([])
    expect(lease.isCurrent()).toBe(false)
  })

  it('same-user refresh: a REAL refreshSession() while pending — completes with the new token, exactly', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const before = (await userA.client.auth.getSession()).data.session?.access_token
    const release = tab.parkNextSessionLookup()
    const outcome = runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-refresh', BIG), key, tab.dbFor(lease)),
    )
    await tab.untilLookupParked(0)
    const refreshed = await userA.client.auth.refreshSession()
    expect(refreshed.error).toBeNull()
    expect(refreshed.data.session?.access_token).not.toBe(before) // a genuinely new token
    tab.authority.observe(userA.id) // the TOKEN_REFRESHED auth event: same user
    release()

    const purchase = await outcome
    expect(purchase.subtotalMinor).toBe(BIG)
    const rows = await purchasesByKey(key)
    expect(rows.map((r) => [r.user_id, r.subtotal_minor])).toEqual([[userA.id, BIG.toString()]])
    expect(tab.wire.map((r) => r.bearerSub)).toEqual([userA.id])
  })

  it('A -> B -> A: the original lease stays dead; the operation does not restart or complete', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const release = tab.parkNextSessionLookup()
    const outcome = runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-aba', BIG), key, tab.dbFor(lease)),
    )
    await tab.untilLookupParked(0)
    tab.switchTo(userB)
    tab.switchTo(userA)
    release()

    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(await purchasesByKey(key)).toEqual([])
    expect(tab.wire).toEqual([])
    // A fresh action under the new A identity is a NEW lease and works.
    const fresh = tab.leaseFor(userA)
    const key2 = crypto.randomUUID()
    await createPurchase(purchaseInput('p147-aba-fresh', BIG), key2, tab.dbFor(fresh))
    expect((await purchasesByKey(key2))[0]?.user_id).toBe(userA.id)
  })

  it('signed out while pending: the write is never dispatched', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    const release = tab.parkNextSessionLookup()
    const outcome = runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-out', BIG), key, tab.dbFor(lease)),
    )
    await tab.untilLookupParked(0)
    tab.signOut()
    release()

    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(await purchasesByKey(key)).toEqual([])
    expect(tab.wire).toEqual([])
  })

  it("A's confirmed portfolio reset can never delete B's data after a switch", async () => {
    const keyB = crypto.randomUUID()
    const tabB = tabAs(userB)
    await createPurchase(
      purchaseInput('p147-b-survives', BIG),
      keyB,
      tabB.dbFor(tabB.leaseFor(userB)),
    )

    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const release = tab.parkNextSessionLookup()
    const outcome = runWithLease(lease, () => resetMyPortfolioData(tab.dbFor(lease)))
    await tab.untilLookupParked(0)
    tab.switchTo(userB)
    release()

    await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(tab.wire).toEqual([])
    expect((await purchasesByKey(keyB))[0]?.user_id).toBe(userB.id)
  })
})

describe('P138 idempotency survives the composed transport', () => {
  it('identical purchase replay (same key, amount above 2^53): one purchase, same id', async () => {
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const key = crypto.randomUUID()
    const first = await createPurchase(purchaseInput('p147-replay', BIG), key, db)
    const second = await createPurchase(purchaseInput('p147-replay', BIG), key, db)
    expect(second.id).toBe(first.id)
    expect(await purchasesByKey(key)).toHaveLength(1)
  })

  it('object-key order in the request does not create a false conflict', async () => {
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const key = crypto.randomUUID()
    const args = (lineKeys: string[]) => ({
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        Object.fromEntries(
          lineKeys.map((k) => [
            k,
            {
              line_type: 'accessory',
              description: 'p147 order',
              quantity: 1,
              unit_price_minor: BIG.toString(),
            }[k as 'line_type'],
          ]),
        ),
      ],
      p_idempotency_key: key,
    })
    const a = await db
      .rpc('create_purchase', args(['line_type', 'description', 'quantity', 'unit_price_minor']))
      .select('id')
      .single()
    const b = await db
      .rpc('create_purchase', args(['unit_price_minor', 'quantity', 'description', 'line_type']))
      .select('id')
      .single()
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    const idOf = (r: { data: unknown }) => (r.data as { id?: string } | null)?.id
    expect(idOf(b)).toBeDefined()
    expect(idOf(b)).toBe(idOf(a))
    expect(await purchasesByKey(key)).toHaveLength(1)
  })

  it('the same key with an amount that differs by ONE minor unit above 2^53 is refused', async () => {
    // 2^53 and 2^53 + 1 are the same double: a pipeline that rounds would call this a replay.
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const key = crypto.randomUUID()
    await createPurchase(purchaseInput('p147-reuse', BIG - 1n), key, db)
    await expect(createPurchase(purchaseInput('p147-reuse', BIG), key, db)).rejects.toThrow(
      /idempotency-key-reuse/,
    )
    const rows = await purchasesByKey(key)
    expect(rows.map((r) => r.subtotal_minor)).toEqual([(BIG - 1n).toString()])
  })

  it('identical sale replay is one sale; a changed amount (one unit above 2^53) is refused', async () => {
    const lotId = await lotOf(userA, 10)
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const key = crypto.randomUUID()
    const sale = (gross: bigint) =>
      createSale(
        [{ lotId, quantity: 1, unitGrossMinor: gross }],
        { soldOn: today, currency: 'NOK' },
        key,
        db,
      )
    const first = await sale(BIG - 1n)
    const again = await sale(BIG - 1n)
    expect(again.id).toBe(first.id)
    await expect(sale(BIG)).rejects.toThrow(/idempotency-key-reuse/)
    const rows = await salesByKey(key)
    expect(rows.map((r) => [r.user_id, r.gross_minor])).toEqual([[userA.id, (BIG - 1n).toString()]])
  })

  it('concurrent duplicate sale (same key, same payload): one sale, both callers get it', async () => {
    const lotId = await lotOf(userA, 10)
    const tab = tabAs(userA)
    const key = crypto.randomUUID()
    const attempt = () =>
      createSale(
        [{ lotId, quantity: 1, unitGrossMinor: BIG }],
        { soldOn: today, currency: 'NOK' },
        key,
        tab.dbFor(tab.leaseFor(userA)),
      )
    const [x, y] = await Promise.all([attempt(), attempt()])
    expect(x.id).toBe(y.id)
    expect(await salesByKey(key)).toHaveLength(1)
  })

  it('concurrent same-key sale with DIFFERENT amounts: exactly one wins, the loser gets a named refusal', async () => {
    const lotId = await lotOf(userA, 10)
    const tab = tabAs(userA)
    const key = crypto.randomUUID()
    const attempt = (gross: bigint) =>
      createSale(
        [{ lotId, quantity: 1, unitGrossMinor: gross }],
        { soldOn: today, currency: 'NOK' },
        key,
        tab.dbFor(tab.leaseFor(userA)),
      )
    const settled = await Promise.allSettled([attempt(BIG - 1n), attempt(BIG)])
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0]?.reason as Error).message).toMatch(/idempotency-key-reuse/)
    expect((rejected[0]?.reason as Error).message).not.toMatch(/duplicate key|23505/)
    expect(await salesByKey(key)).toHaveLength(1)
  })

  it('retry after an AMBIGUOUS failure (server committed, answer lost): same key -> same purchase', async () => {
    const tab = tabAs(userA)
    const lease = tab.leaseFor(userA)
    const db = tab.dbFor(lease)
    const key = crypto.randomUUID()
    tab.loseNextResponseOf('/rpc/create_purchase')
    await expect(
      runWithLease(lease, () => createPurchase(purchaseInput('p147-ambig', BIG), key, db)),
    ).rejects.toThrow(/Failed to fetch/)
    expect(await purchasesByKey(key)).toHaveLength(1) // it DID commit
    const retry = await runWithLease(lease, () =>
      createPurchase(purchaseInput('p147-ambig', BIG), key, db),
    )
    expect(retry.subtotalMinor).toBe(BIG)
    const rows = await purchasesByKey(key)
    expect(rows).toHaveLength(1)
    expect(retry.id).toBe(rows[0]?.id)
  })

  it("account switch during the retry: A's lease cannot retry as B; B's own action is B's alone", async () => {
    const tab = tabAs(userA)
    const leaseA = tab.leaseFor(userA)
    const key = crypto.randomUUID()
    tab.loseNextResponseOf('/rpc/create_purchase')
    await expect(
      createPurchase(purchaseInput('p147-ambig-switch', BIG), key, tab.dbFor(leaseA)),
    ).rejects.toThrow(/Failed to fetch/)
    expect(await purchasesByKey(key)).toHaveLength(1)

    tab.switchTo(userB)
    await expect(
      runWithLease(leaseA, () =>
        createPurchase(purchaseInput('p147-ambig-switch', BIG), key, tab.dbFor(leaseA)),
      ),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(await purchasesByKey(key)).toHaveLength(1)
    expect(tab.wire.filter((w) => w.bearerSub === userB.id)).toEqual([])

    // B acting on its own: its own lease, even with the same key value — a separate account, a
    // separate purchase, nothing replayed from A.
    const leaseB = tab.leaseFor(userB)
    await createPurchase(purchaseInput('p147-b-own', BIG), key, tab.dbFor(leaseB))
    const rows = await purchasesByKey(key)
    expect(rows.map((r) => r.user_id).sort()).toEqual([userA.id, userB.id].sort())
  })
})

describe('NULL and zero survive the composed transport', () => {
  it('lot cost basis: unknown -> NULL, known zero -> 0, known unsafe -> exact, on the ledger', async () => {
    const tab = tabAs(userA)
    const db = tab.dbFor(tab.leaseFor(userA))
    const add = (variant: string, cost: { state: 'unknown' } | { state: 'known'; minor: bigint }) =>
      addCardAcquisition(
        {
          cardVariantId: variant,
          gradingState: 'raw',
          condition: 'NM',
          origin: cost.state === 'unknown' ? 'pre_tracking' : 'purchase',
          costBasisState: cost.state,
          ...(cost.state === 'known' ? { unitCostBasisMinor: cost.minor } : {}),
          quantity: 1,
          acquiredOn: today,
          clientRequestKey: crypto.randomUUID(),
        },
        db,
      )
    const unknown = await add(seedCatalog.pikachuVariantId, { state: 'unknown' })
    const zero = await add(seedCatalog.grassEnergyVariantId, { state: 'known', minor: 0n })
    const big = await add(seedCatalog.japaneseVariantId, { state: 'known', minor: BIG })
    const basis = async (lotId: string) => {
      const { data, error } = await service
        .from('acquisition_lots')
        .select('unit_cost_basis_minor::text')
        .eq('id', lotId)
        .single()
      if (error) throw new Error(error.message)
      return (data as unknown as { unit_cost_basis_minor: string | null }).unit_cost_basis_minor
    }
    expect(await basis(unknown.lotId)).toBeNull()
    expect(await basis(zero.lotId)).toBe('0')
    expect(await basis(big.lotId)).toBe(BIG.toString())
  })
})
