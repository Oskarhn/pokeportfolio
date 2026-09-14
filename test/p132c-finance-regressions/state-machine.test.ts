/**
 * Seeded state-machine sequences over the P130-01/03 surface: purchases, sealed splits (repeated,
 * partial and whole-lot), metadata / cost / quantity receipt edits, sales, sale voids, lot voids,
 * holding removal, purchase voids, openings and opening voids, and unknown-cost acquisitions.
 *
 * After EVERY operation the acceptance rule is applied: success keeps every global invariant, or the
 * operation is refused with a stable domain error and changes nothing. No fix policy is assumed for
 * ambiguous edits. Some generated operations are deliberately invalid (oversell, splitting more than
 * remains) so refusals are exercised too.
 *
 *   P132C_SM_COUNT (default 30), P132C_SM_BASE (default 1320001), P132C_SM_SEED=a,b,c to replay,
 *   P132C_SM_STEPS (default 28)
 */
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import {
  AcceptanceError,
  newUser,
  openFileContext,
  step,
  type FileContext,
  type UserContext,
} from './harness/context'
import { Prng, seedList } from './harness/prng'
import {
  addAcquisitionSql,
  createOpeningSql,
  createPurchaseSql,
  createSaleSql,
  describeOutcome,
  removeHoldingsSql,
  setSealedIntentSql,
  updatePurchaseSql,
  voidLotSql,
  voidOpeningSql,
  voidPurchaseSql,
  voidSaleSql,
  type NewPurchaseLine,
  type Snapshot,
} from './harness/ledger'

let ctx: FileContext
const STEPS = Number(process.env.P132C_SM_STEPS ?? 28)
const tally = new Map<string, number>()

beforeAll(async () => {
  ctx = await openFileContext('sm')
})
afterAll(async () => {
  console.log(`\nP132C_SM_TALLY ${JSON.stringify(Object.fromEntries([...tally].sort()))}`)
  await ctx.close()
})
beforeEach(async () => {
  await ctx.reset()
})

interface Op {
  name: string
  sql: string
}

const INTENTS = ['keep_sealed', 'planned_to_open', 'undecided'] as const

function livePurchases(s: Snapshot) {
  return s.purchases.filter((p) => p.voided_at === null)
}
function liveLots(s: Snapshot) {
  return s.lots.filter((l) => l.voided_at === null)
}
function sealedLiveLots(s: Snapshot) {
  const sealed = new Set(s.holdings.filter((h) => h.holding_kind === 'sealed').map((h) => h.id))
  return liveLots(s).filter((l) => sealed.has(l.holding_id))
}

function generate(rng: Prng, s: Snapshot, first: boolean): Op {
  const lots = liveLots(s)
  const sellable = lots.filter((l) => l.quantity_remaining > 0)
  const sealed = sealedLiveLots(s)
  const purchases = livePurchases(s)
  const menu: (() => Op | null)[] = [
    () => {
      const lines: NewPurchaseLine[] = []
      const sealedQty = rng.int(1, 6)
      lines.push({
        line_type: 'sealed',
        quantity: sealedQty,
        unit_price_minor: rng.int(100, 20_000),
        sealed_product_id: rng.chance(0.5)
          ? ctx.catalog.sealedProductId
          : ctx.catalog.sealedProductId2,
      })
      if (rng.chance(0.5)) {
        lines.push({
          line_type: 'card',
          quantity: rng.int(1, 4),
          unit_price_minor: rng.int(0, 9_999),
          card_variant_id: ctx.catalog.cardVariantId,
          condition: 'NM',
        })
      }
      const ship = rng.chance(0.5) ? rng.int(0, 999) : 0
      return {
        name: `create_purchase(${lines.map((l) => `${l.line_type}x${String(l.quantity)}`).join('+')}, ship ${String(ship)})`,
        sql: createPurchaseSql(lines, {
          shipping: ship,
          discount: rng.chance(0.3) ? rng.int(0, 50) : 0,
        }),
      }
    },
    () => {
      const lot = sealed.length ? rng.pick(sealed) : null
      if (!lot) return null
      const remaining = lot.quantity_remaining
      const qty = rng.chance(0.15)
        ? null
        : rng.chance(0.1)
          ? remaining + 1
          : Math.max(1, rng.int(1, Math.max(1, remaining)))
      return {
        name: `set_sealed_lot_intent(lot ${lot.id.slice(0, 8)}, qty ${String(qty)}/${String(remaining)})`,
        sql: setSealedIntentSql(lot.id, rng.pick(INTENTS), qty),
      }
    },
    () => {
      const p = purchases.length ? rng.pick(purchases) : null
      if (!p) return null
      return {
        name: `update_purchase metadata ${p.id.slice(0, 8)}`,
        sql: updatePurchaseSql(s, p.id, {
          header: {
            notes: `n${String(rng.int(0, 999))}`,
            purchasedOn: rng.pick(['2026-01-10', '2026-01-12']),
          },
        }),
      }
    },
    () => {
      const p = purchases.length ? rng.pick(purchases) : null
      if (!p) return null
      const lines = s.lines.filter((l) => l.purchase_id === p.id)
      const line = rng.pick(lines)
      return rng.chance(0.5)
        ? {
            name: `update_purchase price ${p.id.slice(0, 8)}`,
            sql: updatePurchaseSql(s, p.id, {
              lines: { [line.id]: { unit_price_minor: rng.int(0, 30_000) } },
            }),
          }
        : {
            name: `update_purchase shipping ${p.id.slice(0, 8)}`,
            sql: updatePurchaseSql(s, p.id, { header: { shipping: rng.int(0, 5_000) } }),
          }
    },
    () => {
      const p = purchases.length ? rng.pick(purchases) : null
      if (!p) return null
      const line = rng.pick(s.lines.filter((l) => l.purchase_id === p.id))
      const qty = rng.int(1, 8)
      return {
        name: `update_purchase quantity ${String(line.quantity)}->${String(qty)} ${p.id.slice(0, 8)}`,
        sql: updatePurchaseSql(s, p.id, { lines: { [line.id]: { quantity: qty } } }),
      }
    },
    () => {
      if (!sellable.length) return null
      const chosen = rng.shuffle(sellable).slice(0, rng.int(1, Math.min(2, sellable.length)))
      const lines = chosen.map((l) => ({
        lot_id: l.id,
        quantity: rng.chance(0.1) ? l.quantity_remaining + 1 : rng.int(1, l.quantity_remaining),
        unit_gross_minor: rng.int(0, 25_000),
      }))
      return {
        name: `create_sale(${lines.map((l) => `${l.lot_id.slice(0, 8)}x${String(l.quantity)}`).join('+')})`,
        sql: createSaleSql(lines),
      }
    },
    () => {
      const sales = s.sales.filter((x) => x.voided_at === null)
      if (!sales.length) return null
      const sale = rng.pick(sales)
      return { name: `void_sale ${sale.id.slice(0, 8)}`, sql: voidSaleSql(sale.id) }
    },
    () => {
      if (!lots.length) return null
      const lot = rng.pick(lots)
      return { name: `void_acquisition_lot ${lot.id.slice(0, 8)}`, sql: voidLotSql(lot.id) }
    },
    () => {
      const holdings = [...new Set(lots.map((l) => l.holding_id))]
      if (!holdings.length) return null
      const h = rng.pick(holdings)
      return { name: `remove_holdings ${h.slice(0, 8)}`, sql: removeHoldingsSql([h]) }
    },
    () => {
      const p = purchases.length ? rng.pick(purchases) : null
      if (!p) return null
      return { name: `void_purchase ${p.id.slice(0, 8)}`, sql: voidPurchaseSql(p.id) }
    },
    () => {
      const candidates = sealed.filter((l) => l.quantity_remaining > 0)
      if (!candidates.length) return null
      const lot = rng.pick(candidates)
      return {
        name: `create_opening ${lot.id.slice(0, 8)}`,
        sql: createOpeningSql(lot.id, 1, [
          { card_variant_id: ctx.catalog.cardVariantId2, quantity: rng.int(1, 3), condition: 'EX' },
        ]),
      }
    },
    () => {
      const openings = s.openings.filter((o) => o.voided_at === null)
      if (!openings.length) return null
      const o = rng.pick(openings)
      return { name: `void_opening ${o.id.slice(0, 8)}`, sql: voidOpeningSql(o.id) }
    },
    () =>
      rng.chance(0.5)
        ? {
            name: 'add sealed (unknown cost)',
            sql: addAcquisitionSql({
              sealedProductId: ctx.catalog.sealedProductId,
              quantity: rng.int(1, 3),
            }),
          }
        : {
            name: 'add sealed (known cost)',
            sql: addAcquisitionSql({
              sealedProductId: ctx.catalog.sealedProductId2,
              quantity: rng.int(1, 3),
              origin: 'purchase',
              costState: 'known',
              unitCost: rng.int(0, 9_000),
            }),
          },
  ]
  if (first) return menu[0]!()!
  // Bias toward the P130-01 path: splits, receipt edits and single-lot voids are drawn more often.
  const weighted = [0, 0, 1, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6, 7, 7, 8, 9, 10, 11, 12]
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const op = menu[rng.pick(weighted)]!()
    if (op) return op
  }
  return menu[0]!()!
}

/**
 * Invariant codes for defects OUTSIDE P130-01/03 that this package also found on the audited base
 * (README "Extended findings"). By default they are counted and printed but do not stop a sequence,
 * so one of them cannot hide a P130-01/03 violation later in the same sequence.
 * P132C_SM_STRICT=1 makes them fatal.
 */
const EXTENDED_CODES: ReadonlySet<string> =
  process.env.P132C_SM_STRICT === '1'
    ? new Set()
    : new Set(['VOIDED_PURCHASE_LIVE_LOT', 'LINE_QUANTITY_WITHOUT_LIVE_LOTS'])

async function runSequence(seed: number, user: UserContext): Promise<void> {
  const rng = new Prng(seed)
  const log: string[] = []
  let snap = await user.snap()
  for (let i = 0; i < STEPS; i += 1) {
    const op = generate(rng, snap, i === 0)
    try {
      const { outcome, after, tolerated } = await step(ctx.a, user, op.name, op.sql, EXTENDED_CODES)
      log.push(`${String(i)} ${op.name} -> ${describeOutcome(outcome)}`)
      const key = `${op.name.split(/[ (]/)[0] ?? op.name}:${outcome.kind}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
      for (const v of tolerated) {
        const extKey = `EXTENDED:${v.code}`
        tally.set(extKey, (tally.get(extKey) ?? 0) + 1)
      }
      snap = after
    } catch (error) {
      log.push(`${String(i)} ${op.name} -> FAILED`)
      const message = error instanceof Error ? error.message : String(error)
      throw new AcceptanceError(
        `seed ${String(seed)} failed at step ${String(i)}\n${log.join('\n')}\n\n${message}`,
      )
    }
  }
}

describe('state-machine sequences (acceptance rule after every operation)', () => {
  it.each(seedList('P132C_SM', 30, 1_320_001))('seed %i', async (seed) => {
    const user = await newUser(ctx, `sm${String(seed)}`)
    await runSequence(seed, user)
  })
})
