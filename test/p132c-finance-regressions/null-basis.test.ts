/**
 * NULL cost basis must remain unknown through every operation around the P130-01/03 fix surface:
 * never 0, never borrowed from a known sibling, never counted into realized results.
 * (CLAUDE.md "Honesty in the product"; FINANCIAL_MODEL NULL semantics.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertInvariants,
  newUser,
  openFileContext,
  step,
  type FileContext,
} from './harness/context'
import { heldRace } from './harness/concurrency'
import * as fx from './harness/fixtures'
import { checkInvariants, formatViolations, recordRemovals } from './harness/invariants'
import {
  createSaleSql,
  updatePurchaseSql,
  voidOpeningSql,
  type LotRow,
  type Snapshot,
} from './harness/ledger'

let ctx: FileContext

beforeAll(async () => {
  ctx = await openFileContext('nullbasis')
})
afterAll(async () => {
  await ctx.close()
})
beforeEach(async () => {
  await ctx.reset()
})

const lot = (snap: Snapshot, id: string): LotRow => {
  const row = snap.lots.find((l) => l.id === id)
  if (!row) throw new Error(`lot ${id} missing`)
  return row
}

describe('NULL basis stays unknown', () => {
  it.each([
    ['unknown', 'pre_tracking'],
    ['not_paid', 'gift'],
  ] as const)(
    '%s-cost sealed lot: split, then sell from both siblings',
    async (costState, origin) => {
      const user = await newUser(ctx, `split-${costState}`)
      const acquired = await fx.acquire(ctx.a, {
        sealedProductId: ctx.catalog.sealedProductId,
        quantity: 4,
        costState,
        origin,
      })
      const carved = await fx.split(ctx.a, acquired.lot_id, 'keep_sealed', 1)
      const afterSplit = await user.snap()
      for (const id of [acquired.lot_id, carved]) {
        expect(lot(afterSplit, id)).toMatchObject({
          cost_basis_state: costState,
          unit_cost_basis_minor: null,
          unit_cost_basis_nok_minor: null,
          cost_basis_currency: null,
        })
      }
      const { after } = await step(
        ctx.a,
        user,
        'sell one from each unknown sibling',
        createSaleSql([
          { lot_id: acquired.lot_id, quantity: 1, unit_gross_minor: 9_000 },
          { lot_id: carved, quantity: 1, unit_gross_minor: 8_000 },
        ]),
      )
      const sale = after.sales[0]!
      expect(sale.realized_result_nok_minor).toBeNull()
      expect(sale.proceeds_from_uncosted_nok_minor).toBe(17_000)
      expect(
        after.saleLines.every(
          (l) => l.cost_basis_at_sale_nok_minor === null && l.realized_result_nok_minor === null,
        ),
      ).toBe(true)
    },
  )

  it('a receipt edit on a split known line never touches an unknown lot sharing the holding', async () => {
    const user = await newUser(ctx, 'shared-holding')
    const bought = await fx.buy(ctx.a, user, [fx.sealedLine(ctx, 3, 10_000)])
    const unknown = await fx.acquire(ctx.a, {
      sealedProductId: ctx.catalog.sealedProductId,
      quantity: 2,
    })
    expect(unknown.holding_id).toBe(bought.holdingIds[0])
    await fx.split(ctx.a, bought.lotIds[0]!, 'keep_sealed', 1)
    const before = await user.snap()
    const unknownBefore = lot(before, unknown.lot_id)
    const { outcome, after } = await step(
      ctx.a,
      user,
      'price edit on split known line',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 12_000 } },
      }),
    )
    expect(lot(after, unknown.lot_id)).toEqual(unknownBefore)
    if (outcome.kind === 'ok') {
      const knownLive = after.lots.filter(
        (l) => l.purchase_line_id === bought.lineIds[0] && l.voided_at === null,
      )
      expect(knownLive.reduce((s, l) => s + l.quantity, 0)).toBe(3)
    }
  })

  it('mixed sale (known + unknown lot): realized counts only the known line, uncosted proceeds stay separate', async () => {
    const user = await newUser(ctx, 'mixed')
    const bought = await fx.buy(ctx.a, user, [fx.cardLine(ctx, 2, 10_000)])
    const unknown = await fx.acquire(ctx.a, {
      cardVariantId: ctx.catalog.cardVariantId2,
      condition: 'EX',
      quantity: 2,
    })
    const { after } = await step(
      ctx.a,
      user,
      'mixed-basis sale',
      createSaleSql([
        { lot_id: bought.lotIds[0]!, quantity: 1, unit_gross_minor: 15_000 },
        { lot_id: unknown.lot_id, quantity: 1, unit_gross_minor: 12_000 },
      ]),
    )
    const sale = after.sales[0]!
    expect(sale.realized_result_nok_minor).toBe(5_000)
    expect(sale.proceeds_from_uncosted_nok_minor).toBe(12_000)
  })

  it('opening an unknown-cost sealed lot: NULL opening cost, unallocated pulls, NULL sale basis, clean void', async () => {
    const user = await newUser(ctx, 'opening')
    const acquired = await fx.acquire(ctx.a, {
      sealedProductId: ctx.catalog.sealedProductId,
      quantity: 2,
    })
    const { openingId, pullLotId } = await fx.openWithPull(ctx, ctx.a, user, acquired.lot_id, 1, 2)
    let snap = await user.snap()
    assertInvariants('after opening', snap, user.model)
    expect(snap.openings[0]).toMatchObject({ cost_source: 'unknown', cost_nok_minor: null })
    expect(lot(snap, pullLotId)).toMatchObject({
      cost_basis_state: 'unallocated_opening',
      unit_cost_basis_nok_minor: null,
    })
    await step(
      ctx.a,
      user,
      'sell a pulled card',
      createSaleSql([{ lot_id: pullLotId, quantity: 1, unit_gross_minor: 3_000 }]),
    )
    snap = await user.snap()
    expect(snap.saleLines[0]).toMatchObject({
      cost_basis_at_sale_nok_minor: null,
      realized_result_nok_minor: null,
    })
    // Voiding an opening whose pull was sold must be refused (or leave no live disposal on a voided lot).
    await step(ctx.a, user, 'void the opening after a pull was sold', voidOpeningSql(openingId))
  })

  it('held race: receipt edit vs sale of the unknown lot sharing its holding keeps NULL basis NULL', async () => {
    const user = await newUser(ctx, 'race')
    const bought = await fx.buy(ctx.a, user, [fx.sealedLine(ctx, 3, 10_000)])
    const unknown = await fx.acquire(ctx.a, {
      sealedProductId: ctx.catalog.sealedProductId,
      quantity: 2,
    })
    const before = await user.snap()
    const result = await heldRace(
      ctx.observer,
      {
        session: ctx.a,
        sql: createSaleSql([{ lot_id: unknown.lot_id, quantity: 1, unit_gross_minor: 7_000 }]),
      },
      {
        session: ctx.b,
        sql: updatePurchaseSql(before, bought.purchaseId, {
          lines: { [bought.lineIds[0]!]: { unit_price_minor: 11_000 } },
        }),
      },
    )
    expect(result.first.kind).toBe('ok')
    expect(['ok', 'domain_rejection', 'retryable_conflict']).toContain(result.second.kind)
    const after = await user.snap()
    recordRemovals(before, after, user.model)
    const violations = checkInvariants(after, user.model)
    expect(violations, formatViolations(violations)).toEqual([])
    expect(lot(after, unknown.lot_id)).toMatchObject({
      quantity: 2,
      quantity_remaining: 1,
      unit_cost_basis_minor: null,
      unit_cost_basis_nok_minor: null,
    })
  })
})
