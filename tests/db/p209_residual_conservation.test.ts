import { beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { rebuildSnapshots } from './lib/rebuild-snapshots'

/**
 * P209 (docs/FINANCIAL_MODEL.md section 4.3 / F17, D-060, D-199, D-209): cost is conserved for
 * ARBITRARY valid sequences of disposals and voids.
 *
 * A lot stores `unit = floor(C / q)` and a residual `R = C - q * unit`. D-060 hands the residual to
 * the disposal that exhausts the lot. Before D-209 that decision was frozen at creation time and the
 * void paths never looked at it, so after an out-of-order void the same R sat on a live disposal and
 * on the lot again (or on two live disposals), and the snapshot cost basis was off by R.
 *
 * The oracle below never reads a figure the system derived about the residual. It only uses facts
 * that are frozen by the model: the lot's total cost C (chosen by the test, paid through the
 * purchase RPC), and the frozen basis of each live disposal. The invariant is F17 in its as-of-date
 * form: for every day D on which the lot exists,
 *
 *   DCB(D) = C - sum(frozen basis of the live disposals with disposed_on <= D)
 *
 * and a lot with no unit left at D contributes exactly zero (so the sum equals C: nothing lost,
 * nothing counted twice).
 */

let service: TestClient
const today = new Date().toISOString().slice(0, 10)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

interface Disposal {
  kind: string
  quantity: number
  disposed_on: string
  cost_basis_at_disposal_nok_minor: number | null
  sale_line_id: string | null
  voided_at: string | null
}

async function must<T>(
  label: string,
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
  const { data, error } = await q
  if (error) throw new Error(`${label}: ${error.message}`)
  return data as T
}

async function buyLot(
  client: TestClient,
  o: {
    kind: 'card' | 'sealed'
    quantity: number
    unitPrice: number
    shipping: number
    purchasedOn: string
  },
): Promise<{ lotId: string; total: bigint }> {
  const line =
    o.kind === 'card'
      ? {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: o.quantity,
          unit_price_minor: o.unitPrice,
        }
      : {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: o.quantity,
          unit_price_minor: o.unitPrice,
        }
  const r = await client
    .rpc('create_purchase', {
      p_purchased_on: o.purchasedOn,
      p_currency: 'NOK',
      p_shipping_minor: o.shipping,
      p_lines: [line],
    })
    .single<{ id: string }>()
  if (r.error) throw new Error(`create_purchase: ${r.error.message}`)
  const pl = await must(
    'purchase line',
    service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', r.data.id)
      .single<{ id: string }>(),
  )
  const lot = await must(
    'lot',
    service
      .from('acquisition_lots')
      .select('id, unit_cost_basis_nok_minor, residual_nok_minor, quantity')
      .eq('purchase_line_id', pl.id)
      .single<{
        id: string
        unit_cost_basis_nok_minor: number
        residual_nok_minor: number
        quantity: number
      }>(),
  )
  const total =
    BigInt(lot.quantity) * BigInt(lot.unit_cost_basis_nok_minor) + BigInt(lot.residual_nok_minor)
  expect(total).toBe(BigInt(o.quantity * o.unitPrice + o.shipping))
  return { lotId: lot.id, total }
}

async function sell(client: TestClient, lotId: string, quantity: number, soldOn: string) {
  const r = await client
    .rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: soldOn,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity, unit_gross_minor: 700 }],
    })
    .single<{ id: string }>()
  if (r.error) throw new Error(`create_sale: ${r.error.message}`)
  return r.data.id
}

async function openPacks(client: TestClient, lotId: string, quantity: number, openedOn: string) {
  const r = await client
    .rpc('create_opening', {
      p_source_lot_id: lotId,
      p_quantity: quantity,
      p_opened_on: openedOn,
      p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
    })
    .single<{ id: string }>()
  if (r.error) throw new Error(`create_opening: ${r.error.message}`)
  return r.data.id
}

/** Every disposal of the lot with the basis frozen for it, whatever path produced it. */
async function disposalsOf(lotId: string): Promise<(Disposal & { frozen: bigint | null })[]> {
  const rows = await must(
    'disposals',
    service
      .from('lot_disposals')
      .select(
        'kind, quantity, disposed_on, cost_basis_at_disposal_nok_minor, sale_line_id, voided_at',
      )
      .eq('lot_id', lotId)
      .order('created_at') as unknown as PromiseLike<{
      data: Disposal[] | null
      error: { message: string } | null
    }>,
  )
  const out: (Disposal & { frozen: bigint | null })[] = []
  for (const d of rows) {
    let frozen: bigint | null = null
    if (d.sale_line_id) {
      const sl = await must(
        'sale line',
        service
          .from('sale_lines')
          .select('cost_basis_at_sale_nok_minor')
          .eq('id', d.sale_line_id)
          .single<{ cost_basis_at_sale_nok_minor: number | null }>(),
      )
      frozen =
        sl.cost_basis_at_sale_nok_minor === null ? null : BigInt(sl.cost_basis_at_sale_nok_minor)
    } else if (d.cost_basis_at_disposal_nok_minor !== null) {
      frozen = BigInt(d.cost_basis_at_disposal_nok_minor)
    }
    out.push({ ...d, frozen })
  }
  return out
}

function liveFrozen(ds: (Disposal & { frozen: bigint | null })[], upTo?: string): bigint {
  return ds
    .filter((d) => d.voided_at === null && (upTo === undefined || d.disposed_on <= upTo))
    .reduce((s, d) => s + (d.frozen ?? 0n), 0n)
}

async function snapshotCosts(userId: string, from: string): Promise<Map<string, bigint>> {
  const rb = await rebuildSnapshots(service, userId, from, today)
  if (rb.error) throw new Error(`rebuild: ${rb.error.message}`)
  const rows = await must(
    'snapshots',
    service
      .from('portfolio_snapshots')
      .select('snapshot_date, cost_basis_nok_minor')
      .eq('user_id', userId)
      .order('snapshot_date') as unknown as PromiseLike<{
      data: { snapshot_date: string; cost_basis_nok_minor: number }[] | null
      error: { message: string } | null
    }>,
  )
  return new Map(rows.map((r) => [r.snapshot_date, BigInt(r.cost_basis_nok_minor)]))
}

/** F17 as of every day since `acquiredOn`; returns problems, empty when cost is conserved. */
async function conservationProblems(
  userId: string,
  lotId: string,
  total: bigint,
  acquiredOn: string,
): Promise<string[]> {
  const problems: string[] = []
  const ds = await disposalsOf(lotId)
  const lot = await must(
    'lot',
    service
      .from('acquisition_lots')
      .select('quantity, quantity_remaining')
      .eq('id', lotId)
      .single<{ quantity: number; quantity_remaining: number }>(),
  )
  const frozenNow = liveFrozen(ds)
  if (frozenNow > total) problems.push(`frozen ${frozenNow} exceeds the lot's total cost ${total}`)
  if (lot.quantity_remaining === 0 && frozenNow !== total) {
    problems.push(`lot sold out: frozen ${frozenNow} != total ${total}`)
  }
  const snaps = await snapshotCosts(userId, acquiredOn)
  for (const [day, dcb] of snaps) {
    const soldQty = ds
      .filter((d) => d.voided_at === null && d.disposed_on <= day)
      .reduce((s, d) => s + d.quantity, 0)
    const soldOut = soldQty >= lot.quantity
    const frozenD = liveFrozen(ds, day)
    if (soldOut && frozenD !== total) {
      problems.push(`${day}: lot sold out but frozen is ${frozenD} of ${total}`)
    }
    const want = soldOut ? 0n : total - frozenD
    if (dcb !== want) problems.push(`${day}: snapshot cost ${dcb}, conserved cost ${want}`)
  }
  return problems
}

beforeAll(() => {
  service = createServiceClient()
})

describe('D-209: the residual is carried by exactly one live disposal', () => {
  it('voiding an earlier sale while the exhausting sale stays live: 4 x 100 + 1 is not 401 (the P199 pin)', async () => {
    const u: SyntheticUser = await createSyntheticUser(service, 'p209-pin')
    const c = await signInAs(u)
    try {
      const { lotId, total } = await buyLot(c, {
        kind: 'card',
        quantity: 5,
        unitPrice: 100,
        shipping: 1,
        purchasedOn: isoDaysAgo(3),
      })
      const first = await sell(c, lotId, 4, today) // not exhausting: 400
      await sell(c, lotId, 1, today) // exhausting: 100 + residual 1
      expect((await c.rpc('void_sale', { p_sale_id: first })).error).toBeNull()
      expect(await conservationProblems(u.id, lotId, total, isoDaysAgo(3))).toEqual([])
      const snaps = await snapshotCosts(u.id, isoDaysAgo(3))
      expect(snaps.get(today)).toBe(400n) // 501 - the 101 frozen on the live sale
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('selling the units that came back does not hand the residual out a second time', async () => {
    const u = await createSyntheticUser(service, 'p209-twice')
    const c = await signInAs(u)
    try {
      const { lotId, total } = await buyLot(c, {
        kind: 'card',
        quantity: 5,
        unitPrice: 100,
        shipping: 1,
        purchasedOn: isoDaysAgo(3),
      })
      const x = await sell(c, lotId, 3, today)
      await sell(c, lotId, 2, today) // exhausts, carries the residual: 201
      expect((await c.rpc('void_sale', { p_sale_id: x })).error).toBeNull()
      await sell(c, lotId, 3, today) // exhausts again, but the residual is already on a live sale
      const ds = await disposalsOf(lotId)
      expect(liveFrozen(ds)).toBe(total) // 201 + 300; before D-209: 201 + 301 = 502
      expect(await conservationProblems(u.id, lotId, total, isoDaysAgo(3))).toEqual([])
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('voiding the sale that carries the residual puts it back on the lot', async () => {
    const u = await createSyntheticUser(service, 'p209-back')
    const c = await signInAs(u)
    try {
      const { lotId, total } = await buyLot(c, {
        kind: 'card',
        quantity: 5,
        unitPrice: 100,
        shipping: 1,
        purchasedOn: isoDaysAgo(3),
      })
      await sell(c, lotId, 4, today)
      const last = await sell(c, lotId, 1, today)
      expect((await c.rpc('void_sale', { p_sale_id: last })).error).toBeNull()
      // One unit left: 100 + the residual 1.
      expect((await snapshotCosts(u.id, isoDaysAgo(3))).get(today)).toBe(101n)
      await sell(c, lotId, 1, today) // takes it again
      expect(liveFrozen(await disposalsOf(lotId))).toBe(total)
      expect(await conservationProblems(u.id, lotId, total, isoDaysAgo(3))).toEqual([])
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('a backdated exhausting sale: history is conserved on every day, before and after it', async () => {
    const u = await createSyntheticUser(service, 'p209-backdated')
    const c = await signInAs(u)
    try {
      const { lotId, total } = await buyLot(c, {
        kind: 'card',
        quantity: 4,
        unitPrice: 250,
        shipping: 3,
        purchasedOn: isoDaysAgo(6),
      })
      await sell(c, lotId, 2, isoDaysAgo(1)) // recorded first, dated late
      await sell(c, lotId, 2, isoDaysAgo(4)) // exhausts when recorded, dated EARLIER
      expect(await conservationProblems(u.id, lotId, total, isoDaysAgo(6))).toEqual([])
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('openings: voiding an earlier opening while the exhausting one stays live conserves the sealed lot cost', async () => {
    const u = await createSyntheticUser(service, 'p209-open')
    const c = await signInAs(u)
    try {
      const { lotId, total } = await buyLot(c, {
        kind: 'sealed',
        quantity: 5,
        unitPrice: 100,
        shipping: 1,
        purchasedOn: isoDaysAgo(3),
      })
      const first = await openPacks(c, lotId, 4, today)
      await openPacks(c, lotId, 1, today) // exhausting: 101
      expect((await c.rpc('void_opening', { p_opening_id: first })).error).toBeNull()

      // The preview the UI shows for "open the remaining 4" must be what create_opening freezes.
      const src = await c.rpc('list_opening_sources', { p_holding_id: null })
      expect(src.error).toBeNull()
      const row = (
        src.data as { lot_id: string; exhaustion_residual_nok_minor: string | null }[]
      ).find((r) => r.lot_id === lotId)
      expect(row?.exhaustion_residual_nok_minor).toBe('0')

      await openPacks(c, lotId, 4, today)
      const ds = await disposalsOf(lotId)
      expect(liveFrozen(ds)).toBe(total) // 101 + 400
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('reconcile_opening_cost onto a real lot whose residual is already carried does not carry it twice', async () => {
    const u = await createSyntheticUser(service, 'p209-reconcile')
    const c = await signInAs(u)
    try {
      const { lotId, total } = await buyLot(c, {
        kind: 'sealed',
        quantity: 5,
        unitPrice: 100,
        shipping: 1,
        purchasedOn: isoDaysAgo(3),
      })
      const first = await openPacks(c, lotId, 4, today)
      await openPacks(c, lotId, 1, today) // carries the residual
      expect((await c.rpc('void_opening', { p_opening_id: first })).error).toBeNull()
      // A provisional opening of 4 packs, then the receipt arrives: reconcile onto the real lot.
      const prov = await c
        .rpc('create_opening_from_provisional', {
          p_sealed_product_id: seedCatalog.sealedProductId,
          p_quantity: 4,
          p_total_paid_minor: 400,
          p_purchased_on: today,
        })
        .single<{ id: string }>()
      expect(prov.error).toBeNull()
      const rec = await c
        .rpc('reconcile_opening_cost', { p_opening_id: prov.data!.id, p_real_source_lot_id: lotId })
        .single<{ cost_nok_minor: number }>()
      expect(rec.error).toBeNull()
      expect(rec.data!.cost_nok_minor).toBe(400)
      expect(liveFrozen(await disposalsOf(lotId))).toBe(total)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})

describe('D-209: seeded arbitrary sale / void sequences conserve cost on every day', () => {
  const SEEDS = Array.from({ length: 28 }, (_, i) => 2000 + i)
  let sequencesWithOutOfOrderVoid = 0
  let sequencesSoldOut = 0

  for (const seed of SEEDS) {
    it(`seed ${String(seed)}`, async () => {
      const rng = mulberry32(seed)
      const ri = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
      const quantity = ri(2, 9)
      const unitPrice = ri(40, 400)
      const shipping = ri(1, quantity - 1) // an inexact division: residual = shipping
      const acquired = isoDaysAgo(8)
      const u = await createSyntheticUser(service, `p209-seq-${String(seed)}`)
      const c = await signInAs(u)
      try {
        const { lotId, total } = await buyLot(c, {
          kind: 'card',
          quantity,
          unitPrice,
          shipping,
          purchasedOn: acquired,
        })
        const live: { id: string; qty: number; order: number }[] = []
        let remaining = quantity
        let order = 0
        let everSoldOut = false
        const log: string[] = []
        for (let step = 0; step < 10; step++) {
          const roll = rng()
          if (roll < 0.6 && remaining > 0) {
            const qty = rng() < 0.45 ? remaining : ri(1, remaining)
            const soldOn = isoDaysAgo(ri(0, 7))
            const id = await sell(c, lotId, qty, soldOn)
            live.push({ id, qty, order: order++ })
            remaining -= qty
            log.push(`sell ${String(qty)} on ${soldOn}`)
          } else if (live.length > 0) {
            const idx = ri(0, live.length - 1)
            const [gone] = live.splice(idx, 1)
            const laterLive = live.some((s) => s.order > gone!.order)
            const r = await c.rpc('void_sale', { p_sale_id: gone!.id })
            expect(r.error).toBeNull()
            remaining += gone!.qty
            if (laterLive) sequencesWithOutOfOrderVoid++
            log.push(`void #${String(gone!.order)}${laterLive ? ' (out of order)' : ''}`)
          }
          if (remaining === 0) everSoldOut = true
          const problems = await conservationProblems(u.id, lotId, total, acquired)
          if (problems.length > 0) {
            throw new Error(
              `after [${log.join('; ')}] (q=${String(quantity)}, C=${String(total)}): ${problems.join(' | ')}`,
            )
          }
        }
        if (everSoldOut) sequencesSoldOut++
      } finally {
        await deleteSyntheticUser(service, u.id)
      }
    })
  }

  it('the seeds exercised out-of-order voids and sold-out lots', () => {
    expect(sequencesWithOutOfOrderVoid).toBeGreaterThanOrEqual(10)
    expect(sequencesSoldOut).toBeGreaterThanOrEqual(8)
  })
})
