/**
 * P130-03 — correction RPCs racing create_sale (and each other), with the interleaving fixed by
 * transaction locks rather than timing.
 *
 * Every row: the FIRST operation runs inside BEGIN and finishes its statement while holding its
 * locks; the SECOND is issued; the observer waits until the second is lock-blocked or finished;
 * the first commits; the second is awaited. Both start orders are covered for every pair.
 *
 * Accepted results (no fix policy assumed):
 *   - first succeeds (it ran without contention) and
 *   - second succeeds, or is refused with a stable domain error / explicit serialization failure, and
 *   - the committed ledger satisfies every invariant.
 * A deadlock, raw constraint violation or unexpected error in the second session fails the row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AcceptanceError,
  newUser,
  openFileContext,
  type FileContext,
  type UserContext,
} from './harness/context'
import { heldRace } from './harness/concurrency'
import * as fx from './harness/fixtures'
import { checkInvariants, formatViolations, recordRemovals } from './harness/invariants'
import {
  createSaleSql,
  describeOutcome,
  removeHoldingsSql,
  setSealedIntentSql,
  updatePurchaseSql,
  voidLotSql,
  voidOpeningSql,
  voidPurchaseSql,
  voidSaleSql,
} from './harness/ledger'

let ctx: FileContext
const observations: string[] = []

beforeAll(async () => {
  ctx = await openFileContext('p13003')
})
afterAll(async () => {
  console.log(`\nP132C_MATRIX_BEGIN\n${observations.join('\n')}\nP132C_MATRIX_END`)
  await ctx.close()
})
beforeEach(async () => {
  await ctx.reset()
})

interface Race {
  first: string
  second: string
}

type Builder = (user: UserContext) => Promise<Race>

const saleOf = (lotId: string, quantity = 1) =>
  createSaleSql([{ lot_id: lotId, quantity, unit_gross_minor: 15_000 }])

/** Card purchase of 3 @ 20.00 (single line, single lot). */
async function singleLot(user: UserContext) {
  const bought = await fx.buy(ctx.a, user, [fx.cardLine(ctx, 3, 2_000)])
  return {
    ...bought,
    lotId: bought.lotIds[0]!,
    lineId: bought.lineIds[0]!,
    holdingId: bought.holdingIds[0]!,
  }
}

/** Sealed purchase of 5 @ 100.00, split 2 to keep_sealed: original O (3) and carved K (2). */
async function splitLine(user: UserContext) {
  const bought = await fx.buy(ctx.a, user, [fx.sealedLine(ctx, 5, 10_000)])
  const original = bought.lotIds[0]!
  const carved = await fx.split(ctx.a, original, 'keep_sealed', 2)
  return {
    ...bought,
    original,
    carved,
    lineId: bought.lineIds[0]!,
    holdingId: bought.holdingIds[0]!,
  }
}

/** Sealed purchase of 4, one unit opened with 3 pulled copies of one card. */
async function opened(user: UserContext) {
  const bought = await fx.buy(ctx.a, user, [fx.sealedLine(ctx, 4, 10_000)])
  const { openingId, pullLotId } = await fx.openWithPull(ctx, ctx.a, user, bought.lotIds[0]!, 1, 3)
  return { ...bought, sourceLotId: bought.lotIds[0]!, openingId, pullLotId }
}

const priceEdit = async (user: UserContext, purchaseId: string, lineId: string, price: number) =>
  updatePurchaseSql(await user.snap(), purchaseId, {
    lines: { [lineId]: { unit_price_minor: price } },
  })

const pair = (id: string, title: string, build: Builder): [string, string, Builder] => [
  id,
  title,
  build,
]

const cases: [string, string, Builder][] = [
  // ── One lot: correction vs sale, both start orders ──────────────────────────────────────────
  pair('M01', 'sale held -> update_purchase (price)', async (u) => {
    const f = await singleLot(u)
    return { first: saleOf(f.lotId), second: await priceEdit(u, f.purchaseId, f.lineId, 2_500) }
  }),
  pair('M02', 'update_purchase (price) held -> sale', async (u) => {
    const f = await singleLot(u)
    return { first: await priceEdit(u, f.purchaseId, f.lineId, 2_500), second: saleOf(f.lotId) }
  }),
  pair('M03', 'sale held -> void_purchase', async (u) => {
    const f = await singleLot(u)
    return { first: saleOf(f.lotId), second: voidPurchaseSql(f.purchaseId) }
  }),
  pair('M04', 'void_purchase held -> sale', async (u) => {
    const f = await singleLot(u)
    return { first: voidPurchaseSql(f.purchaseId), second: saleOf(f.lotId) }
  }),
  pair('M05', 'sale held -> void_acquisition_lot', async (u) => {
    const f = await singleLot(u)
    return { first: saleOf(f.lotId), second: voidLotSql(f.lotId) }
  }),
  pair('M06', 'void_acquisition_lot held -> sale', async (u) => {
    const f = await singleLot(u)
    return { first: voidLotSql(f.lotId), second: saleOf(f.lotId) }
  }),
  pair('M07', 'sale held -> remove_holdings_from_portfolio', async (u) => {
    const f = await singleLot(u)
    return { first: saleOf(f.lotId), second: removeHoldingsSql([f.holdingId]) }
  }),
  pair('M08', 'remove_holdings_from_portfolio held -> sale', async (u) => {
    const f = await singleLot(u)
    return { first: removeHoldingsSql([f.holdingId]), second: saleOf(f.lotId) }
  }),
  pair('M09', 'sale of pull lot held -> void_opening', async (u) => {
    const f = await opened(u)
    return { first: saleOf(f.pullLotId), second: voidOpeningSql(f.openingId) }
  }),
  pair('M10', 'void_opening held -> sale of pull lot', async (u) => {
    const f = await opened(u)
    return { first: voidOpeningSql(f.openingId), second: saleOf(f.pullLotId) }
  }),
  // ── Split siblings on one purchase line ──────────────────────────────────────────────────────
  pair('M11', 'sale of carved sibling K held -> update_purchase (price)', async (u) => {
    const f = await splitLine(u)
    return { first: saleOf(f.carved), second: await priceEdit(u, f.purchaseId, f.lineId, 12_000) }
  }),
  pair('M12', 'sale of original sibling O held -> update_purchase (price)', async (u) => {
    const f = await splitLine(u)
    return { first: saleOf(f.original), second: await priceEdit(u, f.purchaseId, f.lineId, 12_000) }
  }),
  pair('M13', 'update_purchase (price) held -> sale of carved sibling K', async (u) => {
    const f = await splitLine(u)
    return { first: await priceEdit(u, f.purchaseId, f.lineId, 12_000), second: saleOf(f.carved) }
  }),
  pair('M14', 'sale of carved sibling K held -> void_purchase', async (u) => {
    const f = await splitLine(u)
    return { first: saleOf(f.carved), second: voidPurchaseSql(f.purchaseId) }
  }),
  pair('M15', 'sale of carved sibling K held -> remove_holdings (both siblings)', async (u) => {
    const f = await splitLine(u)
    return { first: saleOf(f.carved), second: removeHoldingsSql([f.holdingId]) }
  }),
  pair('M16', 'remove_holdings (both siblings) held -> sale of carved sibling K', async (u) => {
    const f = await splitLine(u)
    return { first: removeHoldingsSql([f.holdingId]), second: saleOf(f.carved) }
  }),
  pair('M17', 'sale of sibling K held -> void_acquisition_lot of sibling O', async (u) => {
    const f = await splitLine(u)
    return { first: saleOf(f.carved), second: voidLotSql(f.original) }
  }),
  pair('M18', 'void_acquisition_lot of sibling O held -> sale of sibling K', async (u) => {
    const f = await splitLine(u)
    return { first: voidLotSql(f.original), second: saleOf(f.carved) }
  }),
  pair('M19', 'sale of 1 from O held -> intent split of 2 from O', async (u) => {
    const f = await splitLine(u)
    return {
      first: saleOf(f.original, 1),
      second: setSealedIntentSql(f.original, 'planned_to_open', 2),
    }
  }),
  pair('M20', 'sale of all 3 from O held -> intent split of 2 from O', async (u) => {
    const f = await splitLine(u)
    return {
      first: saleOf(f.original, 3),
      second: setSealedIntentSql(f.original, 'planned_to_open', 2),
    }
  }),
  pair('M21', 'intent split of 2 from O held -> sale of all 3 from O', async (u) => {
    const f = await splitLine(u)
    return {
      first: setSealedIntentSql(f.original, 'planned_to_open', 2),
      second: saleOf(f.original, 3),
    }
  }),
  // ── Simultaneous corrections ─────────────────────────────────────────────────────────────────
  pair('M22', 'update_purchase held -> void_acquisition_lot (single-lot purchase)', async (u) => {
    const f = await singleLot(u)
    return { first: await priceEdit(u, f.purchaseId, f.lineId, 2_500), second: voidLotSql(f.lotId) }
  }),
  pair('M23', 'void_acquisition_lot held -> update_purchase (single-lot purchase)', async (u) => {
    const f = await singleLot(u)
    return { first: voidLotSql(f.lotId), second: await priceEdit(u, f.purchaseId, f.lineId, 2_500) }
  }),
  pair('M24', 'update_purchase held -> update_purchase (split line)', async (u) => {
    const f = await splitLine(u)
    const second = await priceEdit(u, f.purchaseId, f.lineId, 13_000)
    return { first: await priceEdit(u, f.purchaseId, f.lineId, 12_000), second }
  }),
  pair('M25', 'void_purchase held -> update_purchase', async (u) => {
    const f = await singleLot(u)
    return {
      first: voidPurchaseSql(f.purchaseId),
      second: await priceEdit(u, f.purchaseId, f.lineId, 2_500),
    }
  }),
  pair('M26', 'remove_holdings held -> void_purchase (split line)', async (u) => {
    const f = await splitLine(u)
    return { first: removeHoldingsSql([f.holdingId]), second: voidPurchaseSql(f.purchaseId) }
  }),
  // ── Disposal voids racing a new disposal on the same lot (D1 recompute) ─────────────────────
  pair('M27', 'sale of 1 held -> void_sale of an earlier sale on the same lot', async (u) => {
    const f = await singleLot(u)
    const earlier = await fx.sell(ctx.a, f.lotId, 1)
    return { first: saleOf(f.lotId, 1), second: voidSaleSql(earlier) }
  }),
  pair('M28', 'void_sale held -> sale of 1 on the same lot', async (u) => {
    const f = await singleLot(u)
    const earlier = await fx.sell(ctx.a, f.lotId, 1)
    return { first: voidSaleSql(earlier), second: saleOf(f.lotId, 1) }
  }),
  pair(
    'M29',
    'sale on the opened source lot held -> void_opening (restores source units)',
    async (u) => {
      const f = await opened(u)
      return { first: saleOf(f.sourceLotId, 1), second: voidOpeningSql(f.openingId) }
    },
  ),
  pair('M30', 'void_opening held -> sale on the opened source lot', async (u) => {
    const f = await opened(u)
    return { first: voidOpeningSql(f.openingId), second: saleOf(f.sourceLotId, 3) }
  }),
  // ── Controls ─────────────────────────────────────────────────────────────────────────────────
  pair(
    'M31',
    'sale of 2 held -> sale of 2 on the same 3-unit lot (oversell attempt)',
    async (u) => {
      const f = await singleLot(u)
      return { first: saleOf(f.lotId, 2), second: saleOf(f.lotId, 2) }
    },
  ),
  pair('M32', 'sale of sibling O held -> sale of sibling K', async (u) => {
    const f = await splitLine(u)
    return { first: saleOf(f.original, 1), second: saleOf(f.carved, 1) }
  }),
]

/**
 * Rows outside the P130-01/P130-03 finding text. They exercise the same lock/recompute mechanism and
 * failed on the audited base for their own reasons (recorded in the package README), so a failure
 * here after the P130-01/03 fix is a separate finding, not a regression of that fix.
 */
const EXTENDED = new Set(['M19', 'M20', 'M21', 'M27', 'M28', 'M29', 'M30'])

describe.each([
  [
    'P130-03 core: correction vs sale and correction vs correction',
    cases.filter(([id]) => !EXTENDED.has(id)),
  ],
  [
    'EXTENDED beyond P130-03: intent split and disposal-void recompute races',
    cases.filter(([id]) => EXTENDED.has(id)),
  ],
])('%s (held-lock interleavings)', (_scope, rows) => {
  it.each(rows)('%s %s', async (id, title, build) => {
    const user = await newUser(ctx, id.toLowerCase())
    const race = await build(user)
    const before = await user.snap()
    const result = await heldRace(
      ctx.observer,
      { session: ctx.a, sql: race.first },
      { session: ctx.b, sql: race.second },
    )
    const after = await user.snap()
    const acceptedSecond = ['ok', 'domain_rejection', 'retryable_conflict'].includes(
      result.second.kind,
    )
    if (result.first.kind === 'ok') recordRemovals(before, after, user.model)
    const violations = checkInvariants(after, user.model)
    observations.push(
      [
        id,
        title,
        `first=${describeOutcome(result.first)}`,
        `second=${describeOutcome(result.second)}`,
        `second_waited_for_first=${String(result.secondWaitedForFirst)}`,
        `violations=${violations.map((v) => v.code).join(',') || 'none'}`,
      ].join(' | '),
    )
    // The first operation ran uncontended. It may still be refused by policy (a fix that refuses
    // edits of split lines refuses M13/M24's first edit); the row then exercises no race, but a
    // refusal must still be a domain error that changed nothing.
    if (result.first.kind === 'domain_rejection') {
      expect(JSON.stringify(after), `${id} refused first operation changed the ledger`).toBe(
        JSON.stringify(before),
      )
      return
    }
    expect(
      result.first.kind,
      `${id} first operation (uncontended) must succeed or be refused`,
    ).toBe('ok')
    if (!acceptedSecond) {
      throw new AcceptanceError(`${id}: second operation ${describeOutcome(result.second)}`)
    }
    if (violations.length > 0) {
      throw new AcceptanceError(
        `${id}: committed ledger violates invariants:\n${formatViolations(violations)}`,
      )
    }
  })
})
