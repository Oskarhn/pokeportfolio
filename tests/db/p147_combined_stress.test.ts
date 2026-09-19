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
 * P147 — a seeded, deterministic campaign that mixes everything the two tracks protect, on the
 * real stack: account switches (heard and event-gap), same-user token refresh, signed-out
 * transitions, A -> B -> A, large / zero / unsafe money, purchase and sale retries, ambiguous
 * failures (the server committed, the answer was lost), concurrent duplicates and lot-cost
 * NULL-versus-zero writes.
 *
 * Scheduling is deterministic: every "race" is a parked session lookup that the test releases at
 * the chosen moment — there is no sleep and no timing luck. The same seed always produces the same
 * cases in the same order (P147_STRESS_SEED / P147_STRESS_CASES override the defaults).
 *
 * For every case the ledger (service role, `col::text`) must show the correct owner, the exact
 * amount, exactly the expected number of rows for the idempotency identity and nothing under the
 * other account; and no request of an A-intent operation may authenticate as anybody but A.
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

const SEED = Number(process.env.P147_STRESS_SEED ?? 147)
const CASES = Number(process.env.P147_STRESS_CASES ?? 72)
const SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const AMOUNTS = [
  0n,
  1n,
  100n,
  SAFE - 1n,
  SAFE, // 2^53 - 1
  SAFE + 1n, // 2^53: representable, indistinguishable from 2^53 + 1
  SAFE + 2n, // 2^53 + 1
  2n ** 58n + 3n,
  2n ** 62n + 12345n,
]
const today = new Date().toISOString().slice(0, 10)

/** mulberry32: a tiny deterministic PRNG, so a failure is reproducible from the seed alone. */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Kind =
  | 'plain-purchase'
  | 'plain-sale'
  | 'switch-heard'
  | 'switch-gap'
  | 'refresh'
  | 'aba'
  | 'signout'
  | 'replay'
  | 'reuse-changed'
  | 'ambiguous-retry'
  | 'ambiguous-then-switch'
  | 'concurrent-duplicate'
  | 'lot-cost-states'

const WEIGHTED: [Kind, number][] = [
  ['plain-purchase', 3],
  ['plain-sale', 3],
  ['switch-heard', 2],
  ['switch-gap', 2],
  ['refresh', 2],
  ['aba', 2],
  ['signout', 2],
  ['replay', 2],
  ['reuse-changed', 3],
  ['ambiguous-retry', 2],
  ['ambiguous-then-switch', 2],
  ['concurrent-duplicate', 2],
  ['lot-cost-states', 2],
]

let service: TestClient
const created: SyntheticUser[] = []
let users: Record<'a' | 'b', TabUser>
const lots: Record<'a' | 'b', string> = { a: '', b: '' }
const rewrites: string[] = []

const other = (u: 'a' | 'b'): 'a' | 'b' => (u === 'a' ? 'b' : 'a')

async function signedIn(user: SyntheticUser) {
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

const newTab = (initial: TabUser | null) =>
  new SimulatedTab(initial, { onResponseRewrite: (l) => rewrites.push(...l) })

async function ledgerPurchases(key: string) {
  const { data, error } = await service
    .from('purchases')
    .select('id, user_id, subtotal_minor::text')
    .eq('idempotency_key', key)
  if (error) throw new Error(error.message)
  return data as unknown as { id: string; user_id: string; subtotal_minor: string }[]
}

async function ledgerSales(key: string) {
  const { data, error } = await service
    .from('sales')
    .select('id, user_id, gross_minor::text')
    .eq('idempotency_key', key)
  if (error) throw new Error(error.message)
  return data as unknown as { id: string; user_id: string; gross_minor: string }[]
}

beforeAll(async () => {
  service = createServiceClient()
  const a = await createSyntheticUser(service, 'p147-stress-a')
  const b = await createSyntheticUser(service, 'p147-stress-b')
  created.push(a, b)
  users = {
    a: { id: a.id, client: await signedIn(a) },
    b: { id: b.id, client: await signedIn(b) },
  }
  transport.client = users.a.client
  for (const who of ['a', 'b'] as const) {
    const tab = newTab(users[who])
    const lease = tab.leaseFor(users[who])
    const purchase = await createPurchase(
      {
        purchasedOn: today,
        currency: 'NOK',
        lines: [
          {
            lineType: 'card' as const,
            cardVariantId: seedCatalog.charizardVariantId,
            condition: 'NM',
            quantity: 5000,
            unitPriceMinor: 1000n,
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
    lots[who] = lot.id
  }
})

afterAll(async () => {
  for (const user of created) await deleteSyntheticUser(service, user.id)
})

interface Ctx {
  actor: 'a' | 'b'
  amount: bigint
  shipping: bigint | undefined
  key: string
  marker: string
}

const purchaseInput = (ctx: Ctx, amount = ctx.amount) => ({
  purchasedOn: today,
  currency: 'NOK',
  lines: [
    {
      lineType: 'accessory' as const,
      description: 'p147 stress',
      quantity: 1,
      unitPriceMinor: amount,
    },
  ],
  notes: ctx.marker,
  ...(ctx.shipping === undefined ? {} : { shippingMinor: ctx.shipping }),
})

async function expectOneOwnedPurchase(ctx: Ctx, owner: 'a' | 'b', amount: bigint) {
  const rows = await ledgerPurchases(ctx.key)
  expect(rows.map((r) => [r.user_id, r.subtotal_minor])).toEqual([
    [users[owner].id, amount.toString()],
  ])
}

/** One case; throws (via expect) on any violated invariant. */
async function runCase(kind: Kind, ctx: Ctx): Promise<void> {
  const actor = users[ctx.actor]
  const stranger = users[other(ctx.actor)]
  const tab = newTab(actor)
  const lease = tab.leaseFor(actor)

  switch (kind) {
    case 'plain-purchase': {
      const p = await runWithLease(lease, () =>
        createPurchase(purchaseInput(ctx), ctx.key, tab.dbFor(lease)),
      )
      expect(p.subtotalMinor).toBe(ctx.amount)
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount)
      expect(tab.requestsNotFrom(actor.id)).toEqual([])
      return
    }
    case 'plain-sale': {
      const s = await runWithLease(lease, () =>
        createSale(
          [{ lotId: lots[ctx.actor], quantity: 1, unitGrossMinor: ctx.amount }],
          { soldOn: today, currency: 'NOK' },
          ctx.key,
          tab.dbFor(lease),
        ),
      )
      expect(s.grossMinor).toBe(ctx.amount)
      const rows = await ledgerSales(ctx.key)
      expect(rows.map((r) => [r.user_id, r.gross_minor])).toEqual([
        [actor.id, ctx.amount.toString()],
      ])
      expect(tab.requestsNotFrom(actor.id)).toEqual([])
      return
    }
    case 'switch-heard':
    case 'switch-gap':
    case 'aba':
    case 'signout': {
      const release = tab.parkNextSessionLookup()
      const outcome = runWithLease(lease, () =>
        createPurchase(purchaseInput(ctx), ctx.key, tab.dbFor(lease)),
      )
      await tab.untilLookupParked(0)
      if (kind === 'switch-heard') tab.switchTo(stranger)
      else if (kind === 'switch-gap') tab.switchTo(stranger, { heard: false })
      else if (kind === 'aba') {
        tab.switchTo(stranger)
        tab.switchTo(actor)
      } else tab.signOut()
      release()
      await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
      expect(await ledgerPurchases(ctx.key)).toEqual([])
      expect(tab.wire).toEqual([])
      return
    }
    case 'refresh': {
      const release = tab.parkNextSessionLookup()
      const outcome = runWithLease(lease, () =>
        createPurchase(purchaseInput(ctx), ctx.key, tab.dbFor(lease)),
      )
      await tab.untilLookupParked(0)
      const refreshed = await actor.client.auth.refreshSession()
      expect(refreshed.error).toBeNull()
      tab.authority.observe(actor.id)
      release()
      const p = await outcome
      expect(p.subtotalMinor).toBe(ctx.amount)
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount)
      expect(tab.requestsNotFrom(actor.id)).toEqual([])
      return
    }
    case 'replay': {
      const db = tab.dbFor(lease)
      const first = await createPurchase(purchaseInput(ctx), ctx.key, db)
      const again = await createPurchase(purchaseInput(ctx), ctx.key, db)
      expect(again.id).toBe(first.id)
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount)
      return
    }
    case 'reuse-changed': {
      const db = tab.dbFor(lease)
      await createPurchase(purchaseInput(ctx), ctx.key, db)
      const changed = ctx.amount + 1n
      await expect(createPurchase(purchaseInput(ctx, changed), ctx.key, db)).rejects.toThrow(
        /idempotency-key-reuse/,
      )
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount)
      return
    }
    case 'ambiguous-retry': {
      const db = tab.dbFor(lease)
      tab.loseNextResponseOf('/rpc/create_purchase')
      await expect(
        runWithLease(lease, () => createPurchase(purchaseInput(ctx), ctx.key, db)),
      ).rejects.toThrow(/Failed to fetch/)
      const retry = await runWithLease(lease, () => createPurchase(purchaseInput(ctx), ctx.key, db))
      expect(retry.subtotalMinor).toBe(ctx.amount)
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount)
      return
    }
    case 'ambiguous-then-switch': {
      tab.loseNextResponseOf('/rpc/create_purchase')
      await expect(createPurchase(purchaseInput(ctx), ctx.key, tab.dbFor(lease))).rejects.toThrow(
        /Failed to fetch/,
      )
      tab.switchTo(stranger)
      await expect(
        runWithLease(lease, () => createPurchase(purchaseInput(ctx), ctx.key, tab.dbFor(lease))),
      ).rejects.toBeInstanceOf(AuthIdentityChangedError)
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount) // the first attempt committed as A
      expect(tab.wire.filter((w) => w.bearerSub === stranger.id)).toEqual([])
      return
    }
    case 'concurrent-duplicate': {
      const attempt = () => {
        const l = tab.leaseFor(actor)
        return createPurchase(purchaseInput(ctx), ctx.key, tab.dbFor(l))
      }
      const [x, y] = await Promise.all([attempt(), attempt()])
      expect(x.id).toBe(y.id)
      await expectOneOwnedPurchase(ctx, ctx.actor, ctx.amount)
      return
    }
    case 'lot-cost-states': {
      const db = tab.dbFor(lease)
      const variants = [
        seedCatalog.pikachuVariantId,
        seedCatalog.grassEnergyVariantId,
        seedCatalog.japaneseVariantId,
      ] as const
      const add = (variant: string, minor: bigint | null) =>
        addCardAcquisition(
          {
            cardVariantId: variant,
            gradingState: 'raw',
            condition: 'NM',
            origin: minor === null ? 'pre_tracking' : 'purchase',
            costBasisState: minor === null ? 'unknown' : 'known',
            ...(minor === null ? {} : { unitCostBasisMinor: minor }),
            quantity: 1,
            acquiredOn: today,
            clientRequestKey: crypto.randomUUID(),
          },
          db,
        )
      const expected: (bigint | null)[] = [null, 0n, ctx.amount]
      for (const [index, minor] of expected.entries()) {
        const lot = await add(variants[index]!, minor)
        const { data, error } = await service
          .from('acquisition_lots')
          .select('user_id, unit_cost_basis_minor::text')
          .eq('id', lot.lotId)
          .single()
        expect(error).toBeNull()
        const row = data as unknown as { user_id: string; unit_cost_basis_minor: string | null }
        expect(row.user_id).toBe(actor.id)
        expect(row.unit_cost_basis_minor).toBe(minor === null ? null : minor.toString())
      }
      return
    }
  }
}

describe('combined identity + money campaign (seeded, deterministic scheduling)', () => {
  it(`runs ${String(CASES)} cases from seed ${String(SEED)} with zero invariant violations`, async () => {
    const random = prng(SEED)
    const totalWeight = WEIGHTED.reduce((s, [, w]) => s + w, 0)
    const pick = (): Kind => {
      let r = random() * totalWeight
      for (const [kind, weight] of WEIGHTED) {
        r -= weight
        if (r < 0) return kind
      }
      return 'plain-purchase'
    }
    const tally = new Map<Kind, number>()
    const failures: string[] = []
    let completed = 0

    for (let i = 0; i < CASES; i += 1) {
      const kind = pick()
      const actor: 'a' | 'b' = random() < 0.5 ? 'a' : 'b'
      const amount = AMOUNTS[Math.floor(random() * AMOUNTS.length)] as bigint
      const shippingChoice = random()
      const ctx: Ctx = {
        actor,
        amount,
        shipping: shippingChoice < 0.4 ? undefined : shippingChoice < 0.7 ? 0n : SAFE + 2n,
        key: crypto.randomUUID(),
        marker: `p147-stress-${String(i)}-${kind}`,
      }
      // A stress amount of exactly zero in a REPLAY/REUSE pair is fine; a `reuse-changed` amount
      // must stay inside bigint, which every amount above is by a wide margin.
      try {
        await runCase(kind, ctx)
        completed += 1
        tally.set(kind, (tally.get(kind) ?? 0) + 1)
      } catch (error) {
        failures.push(
          `case ${String(i)} ${kind} actor=${actor} amount=${amount.toString()}: ${(error as Error).message.slice(0, 300)}`,
        )
      }
    }

    console.log(
      `P147_STRESS seed=${String(SEED)} cases=${String(CASES)} completed=${String(completed)} failures=${String(failures.length)} kinds=${JSON.stringify(Object.fromEntries(tally))} responseRewrites=${String(rewrites.length)}`,
    )
    expect(failures).toEqual([])
    expect(completed).toBe(CASES)
    expect(
      rewrites,
      'a response needed the transport net: money must be text on every path',
    ).toEqual([])

    // Whole-campaign ownership check: nothing of A's cases exists in B's account or vice versa.
    // Every stress purchase carries its case marker; the owner recorded on the row must be the
    // actor of that case, which the per-case assertions already pinned. Here: no row of either
    // synthetic user references a marker of an aborted case.
    const { data, error } = await service
      .from('purchases')
      .select('notes')
      .in('user_id', [users.a.id, users.b.id])
      .like('notes', 'p147-stress-%')
    expect(error).toBeNull()
    const aborted = /-(switch-heard|switch-gap|aba|signout)$/
    expect((data as { notes: string }[]).filter((r) => aborted.test(r.notes))).toEqual([])
  }, 240_000)
})
