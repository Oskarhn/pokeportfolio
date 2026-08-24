import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P28 — Holding Detail quantity reduction / removal (BACKLOG.md "Holding-level quantity reduction
 * and removal"). The correction lifecycle itself is M8.1's (void_acquisition_lot /
 * remove_holdings_from_portfolio, D-051) plus the purchase-correction path update_purchase has had
 * since M8 — this suite covers what is new: reduce_holding_quantity for NON-purchase lots, the
 * purchased-lot routing guarantee (never silently rewritten), partially-sold blocking with frozen
 * sale history intact, unknown-cost semantics, and natural M12 invalidation.
 *
 * Matrix coverage per prompt §17: A/B/C below and in the remove describes; D multi-lot; E unknown
 * cost; F/N partial sale; H disappearance from Current Portfolio; J queue invalidation;
 * K/L/M purchased lots via update_purchase; I sold records intact. G lives in
 * tests/authorization/p28_quantity_reduction.test.ts.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p28-quantity-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface LotRow {
  id: string
  origin: string
  cost_basis_state: string
  quantity: number
  quantity_remaining: number
  unit_cost_basis_minor: number | null
  voided_at: string | null
}

async function insertLot(input: {
  holdingId: string
  origin: string
  costBasisState: string
  quantity: number
}) {
  const { data, error } = await service
    .from('acquisition_lots')
    .insert({
      holding_id: input.holdingId,
      user_id: userA.id,
      origin: input.origin,
      cost_basis_state: input.costBasisState,
      acquired_on: today,
      quantity: input.quantity,
      quantity_remaining: input.quantity,
    })
    .select(
      'id, origin, cost_basis_state, quantity, quantity_remaining, unit_cost_basis_minor, voided_at',
    )
    .single<LotRow>()
  if (error) throw new Error(error.message)
  return data
}

async function insertHolding(input: {
  cardVariantId: string
  condition?: string
}): Promise<string> {
  const { data, error } = await service
    .from('holdings')
    .insert({
      user_id: userA.id,
      holding_kind: 'raw_card',
      card_variant_id: input.cardVariantId,
      condition: input.condition ?? 'NM',
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  return data.id
}

async function lotById(lotId: string): Promise<LotRow> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, origin, cost_basis_state, quantity, quantity_remaining, unit_cost_basis_minor, voided_at',
    )
    .eq('id', lotId)
    .single<LotRow>()
  if (error) throw new Error(error.message)
  return data
}

/** The REAL wire shape: p_lot_reductions is a jsonb parameter and receives an actual JavaScript
 *  array (PostgREST casts it to a jsonb array). A stringified payload arrives as a jsonb STRING
 *  scalar and is rejected by the function's own array guard — exactly what CI's first P28 run
 *  proved. Every call below exercises the same shape production's reduceHoldingQuantity sends.
 *  tests/data/collection-reduce-wire.test.ts pins the wrapper itself to this same contract. */
interface LotReductionWire {
  lot_id: string
  remove_quantity: number
}

async function reduce(args: { p_holding_id: string; p_lot_reductions: LotReductionWire[] }) {
  const { data, error } = await clientA.rpc('reduce_holding_quantity', args)
  return {
    data: data as { owned_quantity: number }[] | null,
    error,
  }
}

async function listPortfolioHoldingIds(): Promise<Set<string>> {
  const { data, error } = await clientA.rpc('list_portfolio')
  if (error) throw new Error(error.message)
  return new Set((data as { holding_id: string }[]).map((row) => row.holding_id))
}

async function spending() {
  const { data, error } = await clientA.rpc('purchase_spending_summary').single<{
    gpo_nok_minor: string
    cs_nok_minor: string
    hs_nok_minor: string
  }>()
  if (error) throw new Error(error.message)
  return data
}

describe('reduce_holding_quantity — non-purchase lots', () => {
  it('B: a gift lot of 3 reduced by 1 leaves ×2 owned, provenance and no-cost state untouched', async () => {
    const holdingId = await insertHolding({ cardVariantId: seedCatalog.grassEnergyVariantId })
    const lot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 3,
    })

    const { data, error } = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 1 }],
    })
    expect(error).toBeNull()
    expect(data![0]!.owned_quantity).toBe(2)

    const after = await lotById(lot.id)
    expect(after.quantity).toBe(2)
    expect(after.quantity_remaining).toBe(2)
    expect(after.origin).toBe('gift')
    expect(after.cost_basis_state).toBe('not_paid')
    expect(after.unit_cost_basis_minor).toBeNull()
    expect(after.voided_at).toBeNull()
  })

  it('E: an unknown-cost pre_tracking lot stays unknown — never silently given a zero or known basis', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.charizardVariantId,
      condition: 'EX',
    })
    const lot = await insertLot({
      holdingId,
      origin: 'pre_tracking',
      costBasisState: 'unknown',
      quantity: 2,
    })

    const { error } = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 1 }],
    })
    expect(error).toBeNull()

    const after = await lotById(lot.id)
    expect(after.quantity).toBe(1)
    expect(after.cost_basis_state).toBe('unknown')
    expect(after.unit_cost_basis_minor).toBeNull()
  })

  it('D: a multi-lot holding reduces exactly the chosen provenance', async () => {
    // Pikachu ×3 as one holding: Lot A gifted ×2 + Lot B existing-collection ×1. The prompt's own
    // example — the owner must be able to correct one lot without touching the other.
    const holdingId = await insertHolding({ cardVariantId: seedCatalog.pikachuVariantId })
    const giftLot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 2,
    })
    const existingLot = await insertLot({
      holdingId,
      origin: 'pre_tracking',
      costBasisState: 'unknown',
      quantity: 1,
    })

    const { data, error } = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: giftLot.id, remove_quantity: 1 }],
    })
    expect(error).toBeNull()
    expect(data![0]!.owned_quantity).toBe(2)

    const giftAfter = await lotById(giftLot.id)
    expect(giftAfter.quantity_remaining).toBe(1)
    const existingAfter = await lotById(existingLot.id)
    expect(existingAfter.quantity).toBe(1)
    expect(existingAfter.quantity_remaining).toBe(1)
    expect(existingAfter.origin).toBe('pre_tracking')
  })

  it('rejects removing every remaining copy through adjustment — that is Remove from Portfolio', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.grassEnergyVariantId,
      condition: 'EX',
    })
    const lot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 2,
    })

    const { error } = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 2 }],
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/remove from portfolio/i)

    const after = await lotById(lot.id)
    expect(after.quantity_remaining).toBe(2)
  })

  it('rejects duplicate lots, non-positive quantities, and lots from another holding — nothing mutated', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.pikachuVariantId,
      condition: 'EX',
    })
    const lot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 4,
    })
    const otherHoldingId = await insertHolding({
      cardVariantId: seedCatalog.pikachuVariantId,
      condition: 'GD',
    })
    const otherLot = await insertLot({
      holdingId: otherHoldingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 1,
    })

    const dup = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [
        { lot_id: lot.id, remove_quantity: 1 },
        { lot_id: lot.id, remove_quantity: 1 },
      ],
    })
    expect(dup.error).not.toBeNull()

    const zero = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 0 }],
    })
    expect(zero.error).not.toBeNull()

    const foreign = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: otherLot.id, remove_quantity: 1 }],
    })
    expect(foreign.error).not.toBeNull()

    const after = await lotById(lot.id)
    expect(after.quantity_remaining).toBe(4)
  })

  it('rejects malformed JSON input shapes outright — zero mutation in every case', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.charizardVariantId,
      condition: 'LP',
    })
    const lot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 3,
    })

    // Deliberately untyped payloads — this test exists to prove hostile shapes are rejected.
    const attempt = async (p_lot_reductions: unknown) => {
      const { error } = await clientA.rpc('reduce_holding_quantity', {
        p_holding_id: holdingId,
        p_lot_reductions,
      } as never)
      return error
    }

    // Not an array: object payload, and an empty one.
    expect(await attempt({ lot_id: lot.id, remove_quantity: 1 })).not.toBeNull()
    expect(await attempt([])).not.toBeNull()
    // Missing lot_id, and a lot_id that is not a UUID.
    expect(await attempt([{ remove_quantity: 1 }])).not.toBeNull()
    expect(await attempt([{ lot_id: 'not-a-uuid', remove_quantity: 1 }])).not.toBeNull()
    // Missing, fractional and negative quantities — '1.5' must not silently round to 2.
    expect(await attempt([{ lot_id: lot.id }])).not.toBeNull()
    expect(await attempt([{ lot_id: lot.id, remove_quantity: 1.5 }])).not.toBeNull()
    expect(await attempt([{ lot_id: lot.id, remove_quantity: -1 }])).not.toBeNull()

    const after = await lotById(lot.id)
    expect(after.quantity).toBe(3)
    expect(after.quantity_remaining).toBe(3)
  })
})

describe('Remove from Portfolio / Remove all (existing M8.1 lifecycle, exercised from the same surface)', () => {
  it('A + H: a qty-1 holding is removed entirely and disappears from Current Portfolio', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.charizardVariantId,
      condition: 'GD',
    })
    await insertLot({ holdingId, origin: 'gift', costBasisState: 'not_paid', quantity: 1 })
    expect((await listPortfolioHoldingIds()).has(holdingId)).toBe(true)

    const { data, error } = await clientA.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [holdingId],
    })
    expect(error).toBeNull()
    expect((data as { blocked: boolean }[])[0]!.blocked).toBe(false)

    expect((await listPortfolioHoldingIds()).has(holdingId)).toBe(false)
  })

  it('C + H: a qty-3 holding removed whole leaves nothing in Current Portfolio', async () => {
    const { data: countsBefore } = await clientA.rpc('portfolio_counts').single<{
      physical_card_count: string
    }>()

    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.grassEnergyVariantId,
      condition: 'GD',
    })
    await insertLot({ holdingId, origin: 'pre_tracking', costBasisState: 'unknown', quantity: 3 })
    expect((await listPortfolioHoldingIds()).has(holdingId)).toBe(true)

    const { error } = await clientA.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [holdingId],
    })
    expect(error).toBeNull()

    expect((await listPortfolioHoldingIds()).has(holdingId)).toBe(false)
    const { data: countsAfter } = await clientA.rpc('portfolio_counts').single<{
      physical_card_count: string
    }>()
    expect(BigInt(countsBefore!.physical_card_count)).toBe(BigInt(countsAfter!.physical_card_count))
  })
})

describe('J — M12 recompute invalidation happens naturally', () => {
  it('a quantity correction enqueues a recompute from the lot acquisition date, with no manual writes', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.pikachuVariantId,
      condition: 'LP',
    })
    const lot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 5,
    })

    // Start from a clean queue so the assertion is about THIS call only.
    await service.from('portfolio_recompute_queue').delete().eq('user_id', userA.id)

    const { error } = await reduce({
      p_holding_id: holdingId,
      p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 2 }],
    })
    expect(error).toBeNull()

    const { data: queued } = await service
      .from('portfolio_recompute_queue')
      .select('user_id, dirty_from')
      .eq('user_id', userA.id)
      .single<{ user_id: string; dirty_from: string }>()
    expect(queued).not.toBeNull()
    expect(queued!.dirty_from <= today).toBe(true)
  })
})

// The purchase-correction lifecycle: purchased lots are NOT adjustable in place — they are routed
// to update_purchase, which rewrites receipt, allocations and cost basis atomically.
describe('purchased lots route through the receipt (update_purchase), never a silent rewrite', () => {
  async function createPurchase(lines: Record<string, unknown>[], shippingMinor = 0) {
    const { data, error } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: lines,
        p_shipping_minor: shippingMinor,
      })
      .single<{ id: string }>()
    if (error) throw new Error(error.message)
    return data
  }

  async function purchaseLinesFor(purchaseId: string) {
    const { data, error } = await service
      .from('purchase_lines')
      .select('id, line_type, quantity, attributable_cost_nok_minor')
      .eq('purchase_id', purchaseId)
      .order('created_at')
    if (error) throw new Error(error.message)
    return data as {
      id: string
      line_type: string
      quantity: number
      attributable_cost_nok_minor: number
    }[]
  }

  async function updatePurchase(
    purchaseId: string,
    lines: Record<string, unknown>[],
    shippingMinor: number,
  ) {
    const { error } = await clientA.rpc('update_purchase', {
      p_purchase_id: purchaseId,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: lines,
      p_shipping_minor: shippingMinor,
    })
    return error
  }

  it('L: reduce_holding_quantity refuses a purchased lot and mutates nothing', async () => {
    const before = await spending()
    const purchase = await createPurchase([
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
        condition: 'NM',
        quantity: 3,
        unit_price_minor: 700,
      },
    ])
    const lines = await purchaseLinesFor(purchase.id)
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id, holding_id, quantity, quantity_remaining')
      .eq('purchase_line_id', lines[0]!.id)
      .single<{ id: string; holding_id: string; quantity: number; quantity_remaining: number }>()
    expect(lot!.quantity).toBe(3)

    const { error } = await reduce({
      p_holding_id: lot!.holding_id,
      p_lot_reductions: [{ lot_id: lot!.id, remove_quantity: 1 }],
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/purchase/i)

    const after = await lotById(lot!.id)
    expect(after.quantity).toBe(3)
    expect(after.quantity_remaining).toBe(3)
    const afterSpend = await spending()
    expect(BigInt(afterSpend.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(2100n)
  })

  it('K: correcting the receipt to a lower quantity moves inventory and money together, exactly', async () => {
    const purchase = await createPurchase([
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'MT',
        quantity: 3,
        unit_price_minor: 700,
      },
    ])
    const lines = await purchaseLinesFor(purchase.id)
    const lot = await service
      .from('acquisition_lots')
      .select('id, quantity, quantity_remaining, unit_cost_basis_nok_minor')
      .eq('purchase_line_id', lines[0]!.id)
      .single<{
        id: string
        quantity: number
        quantity_remaining: number
        unit_cost_basis_nok_minor: number
      }>()
    expect(lot.data!.quantity_remaining).toBe(3)

    // The delta under test is the CORRECTION step alone (3×700 → 2×700 = −700), so the baseline
    // is taken after the purchase exists. (CI's first run measured from before creation — where
    // the correct net figure is +1400: +2100 created, then −700 corrected. The implementation was
    // right; the measurement window was not. Creation's own +2100 is asserted by L.)
    const before = await spending()

    const updateError = await updatePurchase(
      purchase.id,
      [{ line_id: lines[0]!.id, quantity: 2, unit_price_minor: 700 }],
      0,
    )
    expect(updateError).toBeNull()

    const { data: afterLot } = await service
      .from('acquisition_lots')
      .select('quantity, quantity_remaining, unit_cost_basis_nok_minor')
      .eq('id', lot.data!.id)
      .single<{ quantity: number; quantity_remaining: number; unit_cost_basis_nok_minor: number }>()
    expect(afterLot!.quantity).toBe(2)
    expect(afterLot!.quantity_remaining).toBe(2)
    expect(afterLot!.unit_cost_basis_nok_minor).toBe(700)

    const after = await spending()
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(-700n) // 2100 → 1400
    expect(BigInt(after.gpo_nok_minor)).toBe(
      BigInt(after.cs_nok_minor) + BigInt(after.hs_nok_minor),
    )
  })

  it('M: a mixed card+accessory+shipping receipt keeps its allocation exact when a card line is corrected', async () => {
    const before = await spending()
    const purchase = await createPurchase(
      [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'MT',
          quantity: 2,
          unit_price_minor: 1000,
        },
        { line_type: 'accessory', description: 'Binder', quantity: 1, unit_price_minor: 500 },
      ],
      300,
    )
    const originalLines = await purchaseLinesFor(purchase.id)
    expect(originalLines).toHaveLength(2)

    const updateError = await updatePurchase(
      purchase.id,
      [
        { line_id: originalLines[0]!.id, quantity: 1, unit_price_minor: 1000 },
        { line_id: originalLines[1]!.id, quantity: 1, unit_price_minor: 500 },
      ],
      300,
    )
    expect(updateError).toBeNull()

    // New totals: subtotal 1500 + shipping 300 → GPO 1800; pro-rata shipping 200/100 →
    // CS 1200, HS 600, F1 exact. The accessory's real spend survives the card correction.
    const after = await spending()
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(1800n)
    expect(BigInt(after.cs_nok_minor) - BigInt(before.cs_nok_minor)).toBe(1200n)
    expect(BigInt(after.hs_nok_minor) - BigInt(before.hs_nok_minor)).toBe(600n)
    expect(BigInt(after.gpo_nok_minor)).toBe(
      BigInt(after.cs_nok_minor) + BigInt(after.hs_nok_minor),
    )
  })
})

describe('F/I/N — a partially-sold lot blocks correction and frozen sale history is untouched', () => {
  it('sold copies are out of reach: reduce refuses, bulk remove reports blocked, the sale record stands', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.japaneseVariantId,
            condition: 'NM',
            quantity: 4,
            unit_price_minor: 800,
          },
        ],
      })
      .single<{ id: string }>()
    const lines = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase!.id)
      .single<{ id: string }>()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id, holding_id, quantity, quantity_remaining')
      .eq('purchase_line_id', lines.data!.id)
      .single<{ id: string; holding_id: string; quantity: number; quantity_remaining: number }>()
    expect(lot!.quantity).toBe(4)

    // A real disposal (M10 lifecycle): sell 2 of the 4. Owned becomes 2.
    const { data: sale, error: saleError } = await clientA
      .rpc('create_sale', {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: today,
        p_currency: 'NOK',
        p_fees_minor: 0,
        p_lines: [{ lot_id: lot!.id, quantity: 2, unit_gross_minor: 30000 }],
      })
      .single<{ id: string }>()
    expect(saleError).toBeNull()

    const { data: saleLine } = await service
      .from('sale_lines')
      .select('id, cost_basis_at_sale_nok_minor, realized_result_nok_minor, net_proceeds_nok_minor')
      .eq('sale_id', sale!.id)
      .single<{
        id: string
        cost_basis_at_sale_nok_minor: number
        realized_result_nok_minor: number | null
        net_proceeds_nok_minor: number
      }>()
    expect(saleLine!.cost_basis_at_sale_nok_minor).toBe(1600)

    // Only currently-owned units could ever be corrected — and neither correction path may act on
    // this lot at all while its history carries a live disposal.
    const reduceAttempt = await reduce({
      p_holding_id: lot!.holding_id,
      p_lot_reductions: [{ lot_id: lot!.id, remove_quantity: 1 }],
    })
    expect(reduceAttempt.error).not.toBeNull()
    expect(reduceAttempt.error!.message).toMatch(/partially disposed/i)

    const removeAttempt = await clientA.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [lot!.holding_id],
    })
    expect(removeAttempt.error).toBeNull()
    expect(removeAttempt.data![0]!.blocked).toBe(true)
    expect(removeAttempt.data![0]!.blocked_reason).toMatch(/partially removed elsewhere/i)

    // Nothing moved: inventory still 2 of 4, the sale and its frozen basis byte-identical.
    const afterLot = await lotById(lot!.id)
    expect(afterLot.quantity).toBe(4)
    expect(afterLot.quantity_remaining).toBe(2)

    const { data: saleLineAfter } = await service
      .from('sale_lines')
      .select('cost_basis_at_sale_nok_minor, realized_result_nok_minor, net_proceeds_nok_minor')
      .eq('id', saleLine!.id)
      .single<{
        cost_basis_at_sale_nok_minor: number
        realized_result_nok_minor: number | null
        net_proceeds_nok_minor: number
      }>()
    expect(saleLineAfter).toEqual({
      cost_basis_at_sale_nok_minor: saleLine!.cost_basis_at_sale_nok_minor,
      realized_result_nok_minor: saleLine!.realized_result_nok_minor,
      net_proceeds_nok_minor: saleLine!.net_proceeds_nok_minor,
    })

    // head: true returns the tally in `count`, not `data` (which is null by design) — same
    // pattern as m81_remove_from_portfolio's liveLotCount. First executed on the third CI run:
    // both earlier runs stopped at the reduce-refusal message before reaching this line.
    const { count: disposalCount, error: disposalError } = await service
      .from('lot_disposals')
      .select('id', { count: 'exact', head: true })
      .eq('lot_id', lot!.id)
      .is('voided_at', null)
    if (disposalError !== null) throw new Error(disposalError.message)
    expect(disposalCount).toBe(1)
  })
})

// ─── Concurrency (Prompt 32 repair of Claude's PR #42 review) ────────────────────────────────
//
// Claude demonstrated a real race against the pre-repair function: v_owned_total was computed by
// an UNLOCKED aggregate before any row lock existed, so two simultaneous adjustments targeting
// DIFFERENT sibling lots of one holding (A=5, B=5) each read total=10, each passed 5 < 10, and
// jointly committed the holding to zero — violating "adjust never removes the final owned unit".
// The repaired SQL locks EVERY live sibling lot FOR UPDATE in ascending lot-id order (create_
// sale's convention) before computing anything. These tests pin that behaviour with real
// overlapping transactions, using the same Promise.all harness as m10_sales.test.ts's own
// concurrency proof. The winner is nondeterministic by design — no test may assert which call wins.

describe('concurrency — two simultaneous adjustments of different sibling lots', () => {
  it('serialize: exactly one succeeds, the holding keeps ≥1 owned unit, no financial or disposal row moves', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.pikachuVariantId,
      condition: 'GD',
    })
    const lotA = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 5,
    })
    const lotB = await insertLot({
      holdingId,
      origin: 'pre_tracking',
      costBasisState: 'unknown',
      quantity: 5,
    })

    const spendBefore = await spending()
    await service.from('portfolio_recompute_queue').delete().eq('user_id', userA.id)

    const attempt = (lotId: string) =>
      reduce({
        p_holding_id: holdingId,
        p_lot_reductions: [{ lot_id: lotId, remove_quantity: 5 }],
      })

    const [first, second] = await Promise.all([attempt(lotA.id), attempt(lotB.id)])

    const outcomes = [first, second]
    const succeeded = outcomes.filter((o) => o.error === null)
    const failed = outcomes.filter((o) => o.error !== null)
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)

    // The loser must fail on the invariant itself — it observed the winner's committed total and
    // refused to empty the holding (never a deadlock or transport error).
    expect(failed[0]!.error!.message).toMatch(/remove every remaining copy/i)

    const afterA = await lotById(lotA.id)
    const afterB = await lotById(lotB.id)
    // Exactly one lot was emptied; the other stands at its full 5 — total owned = 5 either way,
    // never negative, and the winner's returned figure matches.
    expect([afterA.quantity_remaining, afterB.quantity_remaining].sort()).toEqual([0, 5])
    expect(afterA.quantity).toBeGreaterThanOrEqual(0)
    expect(afterB.quantity).toBeGreaterThanOrEqual(0)
    expect(succeeded[0]!.data![0]!.owned_quantity).toBe(5)

    // No disposal was created and no financial row moved: these lots are cost-free by fixture,
    // and the adjustment path must stay a correction, not a disguised sale.
    for (const lotId of [lotA.id, lotB.id]) {
      const { count: disposalCount, error: disposalError } = await service
        .from('lot_disposals')
        .select('id', { count: 'exact', head: true })
        .eq('lot_id', lotId)
      if (disposalError !== null) throw new Error(disposalError.message)
      expect(disposalCount).toBe(0)

      const { count: saleLineCount, error: saleLineError } = await service
        .from('sale_lines')
        .select('id', { count: 'exact', head: true })
        .eq('lot_id', lotId)
      if (saleLineError !== null) throw new Error(saleLineError.message)
      expect(saleLineCount).toBe(0)
    }
    const spendAfter = await spending()
    expect(BigInt(spendAfter.gpo_nok_minor)).toBe(BigInt(spendBefore.gpo_nok_minor))
    expect(BigInt(spendAfter.cs_nok_minor)).toBe(BigInt(spendBefore.cs_nok_minor))
    expect(BigInt(spendAfter.hs_nok_minor)).toBe(BigInt(spendBefore.hs_nok_minor))

    // M12 invalidation stays sane: exactly the winning UPDATE enqueued a recompute (the aborted
    // transaction's enqueue rolled back with it).
    const { data: queued } = await service
      .from('portfolio_recompute_queue')
      .select('user_id, dirty_from')
      .eq('user_id', userA.id)
      .single<{ user_id: string; dirty_from: string }>()
    expect(queued).not.toBeNull()
    expect(queued!.dirty_from <= today).toBe(true)
  })
})

describe('concurrency — reversed multi-lot input orders cannot deadlock', () => {
  it('overlapping payloads sent in opposite orders serialize cleanly — never 40P01', async () => {
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.grassEnergyVariantId,
      condition: 'MT',
    })
    const lotA = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 3,
    })
    const lotB = await insertLot({
      holdingId,
      origin: 'pre_tracking',
      costBasisState: 'unknown',
      quantity: 3,
    })

    // Each call alone is legal (4 < 6); jointly impossible (8 ≥ 6). Caller-supplied ordering
    // must not matter: pass 2 locks all siblings ascending regardless of payload order.
    const [first, second] = await Promise.all([
      reduce({
        p_holding_id: holdingId,
        p_lot_reductions: [
          { lot_id: lotA.id, remove_quantity: 2 },
          { lot_id: lotB.id, remove_quantity: 2 },
        ],
      }),
      reduce({
        p_holding_id: holdingId,
        p_lot_reductions: [
          { lot_id: lotB.id, remove_quantity: 2 },
          { lot_id: lotA.id, remove_quantity: 2 },
        ],
      }),
    ])

    const outcomes = [first, second]
    const succeeded = outcomes.filter((o) => o.error === null)
    const failed = outcomes.filter((o) => o.error !== null)
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error!.message.toLowerCase()).not.toContain('deadlock')
    expect(failed[0]!.error!.code).not.toBe('40P01')

    // Total 6 − 4 = 2, whichever payload won.
    const afterA = await lotById(lotA.id)
    const afterB = await lotById(lotB.id)
    expect(afterA.quantity_remaining + afterB.quantity_remaining).toBe(2)
    expect(succeeded[0]!.data![0]!.owned_quantity).toBe(2)
  })
})

describe('concurrency — adjustment vs sale of the same eligible gift lot', () => {
  it('create_sale and reduce_holding_quantity serialize on one lock order — legal correction OR legal sale wins, the other refuses safely', async () => {
    // create_sale disposes gift/pre_tracking lots too, so an adjust and a sale CAN target the
    // same lot simultaneously. Both functions lock acquisition_lots in ascending lot-id order,
    // so neither can deadlock against the other; the loser must refuse against the winner's
    // committed state with zero partial mutation.
    const holdingId = await insertHolding({
      cardVariantId: seedCatalog.charizardShadowlessFirstEditionVariantId,
      condition: 'EX',
    })
    const lot = await insertLot({
      holdingId,
      origin: 'gift',
      costBasisState: 'not_paid',
      quantity: 5,
    })

    const [adjust, sale] = await Promise.all([
      reduce({
        p_holding_id: holdingId,
        p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 3 }],
      }),
      clientA
        .rpc('create_sale', {
          p_idempotency_key: crypto.randomUUID(),
          p_sold_on: today,
          p_currency: 'NOK',
          p_fees_minor: 0,
          p_lines: [{ lot_id: lot.id, quantity: 5, unit_gross_minor: 5000 }],
        })
        .single<{ id: string }>(),
    ])

    const outcomes = [adjust.error, sale.error]
    expect(outcomes.filter((e) => e === null)).toHaveLength(1)
    for (const e of outcomes) {
      if (e !== null) {
        expect(e.message.toLowerCase()).not.toContain('deadlock')
      }
    }

    const after = await lotById(lot.id)
    if (sale.error === null) {
      // Sale won: the whole lot was disposed; the adjuster must have refused on the frozen
      // disposal history (or the exhausted remaining), and inventory reflects the sale only.
      expect(after.quantity).toBe(5)
      expect(after.quantity_remaining).toBe(0)
      const { count: disposalCount, error: disposalError } = await service
        .from('lot_disposals')
        .select('id', { count: 'exact', head: true })
        .eq('lot_id', lot.id)
      if (disposalError !== null) throw new Error(disposalError.message)
      expect(disposalCount).toBe(1)
    } else {
      // Adjust won: the shrink landed intact; the sale must have refused as insufficient stock.
      expect(sale.error.message).toMatch(/available|remain/i)
      expect(after.quantity).toBe(2)
      expect(after.quantity_remaining).toBe(2)
      const { count: disposalCount, error: disposalError } = await service
        .from('lot_disposals')
        .select('id', { count: 'exact', head: true })
        .eq('lot_id', lot.id)
      if (disposalError !== null) throw new Error(disposalError.message)
      expect(disposalCount).toBe(0)
    }
  })
})
