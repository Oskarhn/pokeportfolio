/**
 * P130-01 — a sealed lot split by set_sealed_lot_intent followed by an ordinary receipt edit.
 *
 * Expected state is derived from the accounting rules, not from the current function body:
 *   sum(live lot quantity) == line quantity (less units the owner removed)
 *   sum(live lot basis)    == line attributable cost, in NOK and in the receipt currency
 * An edit of a split line may be refused (smallest safe fix) or applied (redistribution); either is
 * accepted as long as the refusal is a domain error that changes nothing, and the application keeps
 * every invariant plus each sibling's intent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  judge,
  newUser,
  openFileContext,
  step,
  type FileContext,
  type UserContext,
} from './harness/context'
import {
  classify,
  createSaleSql,
  updatePurchaseSql,
  voidLotSql,
  voidSaleSql,
  type NewPurchaseLine,
  type PurchaseHeader,
  type Snapshot,
} from './harness/ledger'
import { checkInvariants } from './harness/invariants'
import * as fx from './harness/fixtures'

let ctx: FileContext

beforeAll(async () => {
  ctx = await openFileContext('p13001')
})
afterAll(async () => {
  await ctx.close()
})
beforeEach(async () => {
  await ctx.reset()
})

const buy = (user: UserContext, lines: NewPurchaseLine[], header: PurchaseHeader = {}) =>
  fx.buy(ctx.a, user, lines, header)

function sealedLine(
  quantity: number,
  unitPrice: number,
  productId = ctx.catalog.sealedProductId,
): NewPurchaseLine {
  return {
    line_type: 'sealed',
    quantity,
    unit_price_minor: unitPrice,
    sealed_product_id: productId,
  }
}

const split = (lotId: string, intent: string, quantity: number | null) =>
  fx.split(ctx.a, lotId, intent, quantity)

function liveLotsOfLine(snap: Snapshot, lineId: string) {
  return snap.lots.filter((l) => l.purchase_line_id === lineId && l.voided_at === null)
}

function unitsByIntent(snap: Snapshot, lineId: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const lot of liveLotsOfLine(snap, lineId)) {
    const key = lot.sealed_intent ?? 'null'
    out[key] = (out[key] ?? 0) + lot.quantity
  }
  return out
}

describe('P130-01 exact reproduction', () => {
  it('buy 5 sealed @ 100.00 NOK, split 2 to keep_sealed, edit unit price to 120.00', async () => {
    const user = await newUser(ctx, 'exact')
    const bought = await buy(user, [sealedLine(5, 10_000)])
    const lineId = bought.lineIds[0]!
    const newLot = await split(bought.lotIds[0]!, 'keep_sealed', 2)

    const afterSplit = await user.snap()
    expect(checkInvariants(afterSplit, user.model)).toEqual([])
    expect(
      liveLotsOfLine(afterSplit, lineId)
        .map((l) => l.quantity)
        .sort(),
    ).toEqual([2, 3])
    expect(afterSplit.lots.find((l) => l.id === newLot)?.sealed_intent).toBe('keep_sealed')

    const { outcome, after } = await step(
      ctx.a,
      user,
      'update_purchase price 100.00 -> 120.00 on a split line',
      updatePurchaseSql(afterSplit, bought.purchaseId, {
        lines: { [lineId]: { unit_price_minor: 12_000 } },
      }),
    )
    if (outcome.kind === 'ok') {
      const line = after.lines.find((l) => l.id === lineId)!
      expect(line.attributable_cost_nok_minor).toBe(60_000)
      const live = liveLotsOfLine(after, lineId)
      expect(live.reduce((s, l) => s + l.quantity, 0)).toBe(5)
      expect(
        live.reduce(
          (s, l) => s + (l.unit_cost_basis_nok_minor ?? 0) * l.quantity + l.residual_nok_minor,
          0,
        ),
      ).toBe(60_000)
      // A price edit is not an intent decision: the owner's split survives.
      expect(unitsByIntent(after, lineId)).toEqual({ undecided: 3, keep_sealed: 2 })
    }
  })
})

describe('receipt edits after a split (any fix policy)', () => {
  it('metadata-only edit (date + notes) leaves every sibling untouched when it succeeds', async () => {
    const user = await newUser(ctx, 'meta')
    const bought = await buy(user, [sealedLine(5, 10_000)])
    await split(bought.lotIds[0]!, 'keep_sealed', 2)
    const before = await user.snap()
    const { outcome, after } = await step(
      ctx.a,
      user,
      'metadata edit on split line',
      updatePurchaseSql(before, bought.purchaseId, {
        header: { purchasedOn: '2026-01-11', notes: 'receipt found' },
      }),
    )
    if (outcome.kind === 'ok') {
      const shape = (s: Snapshot) =>
        liveLotsOfLine(s, bought.lineIds[0]!)
          .map((l) => [
            l.id,
            l.quantity,
            l.quantity_remaining,
            l.unit_cost_basis_nok_minor,
            l.residual_nok_minor,
            l.sealed_intent,
          ])
          .sort()
      expect(shape(after)).toEqual(shape(before))
    }
  })

  it.each([
    ['increase 5 -> 7', 7],
    ['decrease 5 -> 4 (inside the original lot)', 4],
    ['decrease 5 -> 2 (equal to the split sibling)', 2],
    ['decrease 5 -> 1 (below the split sibling)', 1],
  ])('quantity edit %s: applied with invariants or refused unchanged', async (_label, quantity) => {
    const user = await newUser(ctx, `qty${String(quantity)}`)
    const bought = await buy(user, [sealedLine(5, 10_000)])
    await split(bought.lotIds[0]!, 'keep_sealed', 2)
    const before = await user.snap()
    const { outcome, after } = await step(
      ctx.a,
      user,
      `quantity edit 5 -> ${String(quantity)}`,
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { quantity } },
      }),
    )
    if (outcome.kind === 'ok') {
      expect(liveLotsOfLine(after, bought.lineIds[0]!).reduce((s, l) => s + l.quantity, 0)).toBe(
        quantity,
      )
    }
  })

  it('repeated splits (three siblings, one carved from the carved lot) then a price edit', async () => {
    const user = await newUser(ctx, 'repeat')
    const bought = await buy(user, [sealedLine(6, 5_001)])
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 3)
    await split(bought.lotIds[0]!, 'planned_to_open', 1)
    await split(keep, 'planned_to_open', 1)
    const before = await user.snap()
    expect(liveLotsOfLine(before, bought.lineIds[0]!)).toHaveLength(4)
    expect(checkInvariants(before, user.model)).toEqual([])
    const { outcome, after } = await step(
      ctx.a,
      user,
      'price edit on a 4-sibling line',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 7_003 } },
      }),
    )
    if (outcome.kind === 'ok') {
      expect(unitsByIntent(after, bought.lineIds[0]!)).toEqual(
        unitsByIntent(before, bought.lineIds[0]!),
      )
    }
  })

  it('whole-lot intent change (no split) keeps a single lot and ordinary edits must still work', async () => {
    const user = await newUser(ctx, 'whole')
    const bought = await buy(user, [sealedLine(4, 2_500)])
    await split(bought.lotIds[0]!, 'keep_sealed', null)
    const before = await user.snap()
    expect(liveLotsOfLine(before, bought.lineIds[0]!)).toHaveLength(1)
    const { outcome } = await step(
      ctx.a,
      user,
      'price edit on unsplit line',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 3_000, quantity: 6 } },
      }),
    )
    // Control: a line with one live lot is an ordinary receipt edit. Refusing it would be a regression.
    expect(outcome.kind).toBe('ok')
  })

  it('allocated shipping/customs/discount across lines: basis sums per line after a split and a header edit', async () => {
    const user = await newUser(ctx, 'alloc')
    const bought = await buy(
      user,
      [
        sealedLine(5, 10_000),
        sealedLine(3, 4_999, ctx.catalog.sealedProductId2),
        {
          line_type: 'card',
          quantity: 2,
          unit_price_minor: 1_234,
          card_variant_id: ctx.catalog.cardVariantId,
          condition: 'NM',
        },
      ],
      { shipping: 1_901, customs: 777, discount: 1_003 },
    )
    await split(bought.lotIds[0]!, 'keep_sealed', 2)
    await split(bought.lotIds[1]!, 'planned_to_open', 1)
    const before = await user.snap()
    expect(checkInvariants(before, user.model)).toEqual([])
    await step(
      ctx.a,
      user,
      'shipping/discount edit with two split lines',
      updatePurchaseSql(before, bought.purchaseId, { header: { shipping: 4_999, discount: 17 } }),
    )
  })

  it('EUR receipt: FX-rate edit after a split keeps EUR and NOK basis sums', async () => {
    const user = await newUser(ctx, 'eur')
    const bought = await buy(user, [sealedLine(5, 1_999)], {
      currency: 'EUR',
      fxRate: '11.73210000',
      fxDate: '2026-01-10',
      fxSource: 'manual',
    })
    await split(bought.lotIds[0]!, 'keep_sealed', 2)
    const before = await user.snap()
    expect(checkInvariants(before, user.model)).toEqual([])
    await step(
      ctx.a,
      user,
      'fx rate edit on split EUR line',
      updatePurchaseSql(before, bought.purchaseId, { header: { fxRate: '11.90000000' } }),
    )
  })

  it('split, remove one sibling from inventory, then edit: removed units are never resurrected', async () => {
    const user = await newUser(ctx, 'resurrect')
    const bought = await buy(user, [
      sealedLine(5, 10_000),
      sealedLine(1, 500, ctx.catalog.sealedProductId2),
    ])
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 2)
    await step(ctx.a, user, 'void the keep_sealed sibling', voidLotSql(keep))
    expect(user.model.removedUnits.get(bought.lineIds[0]!)).toBe(2)
    const before = await user.snap()
    await step(
      ctx.a,
      user,
      'price edit after removing a sibling',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 11_000 } },
      }),
    )
  })

  it('split, sell part of a sibling: the edit must not reset sold units', async () => {
    const user = await newUser(ctx, 'sold')
    const bought = await buy(user, [sealedLine(5, 10_000)])
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 2)
    await step(
      ctx.a,
      user,
      'sell 1 from the keep_sealed sibling',
      createSaleSql([{ lot_id: keep, quantity: 1, unit_gross_minor: 15_000 }]),
    )
    const before = await user.snap()
    await step(
      ctx.a,
      user,
      'price edit with a partially sold sibling',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 12_000 } },
      }),
    )
    await step(
      ctx.a,
      user,
      'quantity edit with a partially sold sibling',
      updatePurchaseSql(await user.snap(), bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { quantity: 3 } },
      }),
    )
  })

  it('split, sell a sibling completely, void that sale, then edit', async () => {
    const user = await newUser(ctx, 'voidsale')
    const bought = await buy(user, [sealedLine(5, 10_000)])
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 2)
    const sale = JSON.parse(
      await ctx.a.value(createSaleSql([{ lot_id: keep, quantity: 2, unit_gross_minor: 15_000 }])),
    ) as { id: string }
    await step(ctx.a, user, 'void the sale', voidSaleSql(sale.id))
    const before = await user.snap()
    expect(checkInvariants(before, user.model)).toEqual([])
    await step(
      ctx.a,
      user,
      'price edit after the sale was voided',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 9_000 } },
      }),
    )
  })
})

describe('EXTENDED beyond P130-01: voiding one split sibling', () => {
  it('void_acquisition_lot of one sibling on a single-line purchase must not void the purchase under a live sibling', async () => {
    const user = await newUser(ctx, 'autovoid')
    const bought = await buy(user, [sealedLine(5, 10_000)])
    const keep = await split(bought.lotIds[0]!, 'keep_sealed', 2)
    const { outcome, after } = await step(
      ctx.a,
      user,
      'void one of two live siblings',
      voidLotSql(keep),
    )
    if (outcome.kind === 'ok') {
      // Spend must not disappear while 3 units bought with it are still inventory.
      expect(after.purchases.find((p) => p.id === bought.purchaseId)?.voided_at).toBeNull()
    }
  })
})

describe('controls that a fix must not break', () => {
  it('single-lot sealed line: price and quantity edit succeed with exact basis', async () => {
    const user = await newUser(ctx, 'ctrl1')
    const bought = await buy(user, [sealedLine(5, 10_000)])
    const before = await user.snap()
    const { outcome, after } = await step(
      ctx.a,
      user,
      'ordinary edit',
      updatePurchaseSql(before, bought.purchaseId, {
        lines: { [bought.lineIds[0]!]: { unit_price_minor: 12_000, quantity: 4 } },
      }),
    )
    expect(outcome.kind).toBe('ok')
    const live = liveLotsOfLine(after, bought.lineIds[0]!)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({
      quantity: 4,
      quantity_remaining: 4,
      unit_cost_basis_nok_minor: 12_000,
      residual_nok_minor: 0,
    })
  })

  it('card line with a partial sale: a quantity edit never resets sold units', async () => {
    const user = await newUser(ctx, 'ctrl2')
    const bought = await buy(user, [
      {
        line_type: 'card',
        quantity: 3,
        unit_price_minor: 2_000,
        card_variant_id: ctx.catalog.cardVariantId,
        condition: 'NM',
      },
    ])
    await ctx.a.value(
      createSaleSql([{ lot_id: bought.lotIds[0]!, quantity: 1, unit_gross_minor: 2_500 }]),
    )
    const before = await user.snap()
    const outcome = classify(
      await ctx.a.exec(
        updatePurchaseSql(before, bought.purchaseId, {
          lines: { [bought.lineIds[0]!]: { quantity: 2 } },
        }),
      ),
    )
    judge(
      'quantity edit of a partially sold card line',
      outcome,
      before,
      await user.snap(),
      user.model,
    )
  })
})
