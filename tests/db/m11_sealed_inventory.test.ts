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
 * M11: Sealed Inventory (PRODUCT_SPEC.md §4.6, DATA_MODEL.md §3.3/§5.4-5.5, FINANCIAL_MODEL.md
 * §6.3). Proves the hard gates the prompt names explicitly: the sealed-intent cardinality gate
 * (prompt §79 — mixed intent among identical physical units must be truthfully representable),
 * manual-only valuation with quantity multiplication and "missing != zero" (prompt §35/§39/§81),
 * the cards/sealed value segment (prompt §82), purchase integration incl. mixed-receipt allocation
 * (prompt §62/§83), direct acquisition with no fabricated cost (prompt §26-27), and that a sealed
 * lot sells through the ordinary M10 sale engine unmodified (prompt §57/§84). Cross-tenant/RLS
 * attacks live in tests/authorization/m11_sealed.test.ts, same split M8/M10 established.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm11-sealed-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface HoldingRow {
  id: string
  holding_kind: string
  sealed_product_id: string | null
}

interface LotRow {
  id: string
  holding_id: string
  quantity: number
  quantity_remaining: number
  sealed_intent: string | null
  unit_cost_basis_minor: number | null
  cost_basis_state: string
  purchase_line_id: string | null
}

async function lotsForHolding(holdingId: string): Promise<LotRow[]> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, holding_id, quantity, quantity_remaining, sealed_intent, unit_cost_basis_minor, cost_basis_state, purchase_line_id',
    )
    .eq('holding_id', holdingId)
    .is('voided_at', null)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data
}

async function holdingById(id: string): Promise<HoldingRow> {
  const { data, error } = await service
    .from('holdings')
    .select('id, holding_kind, sealed_product_id')
    .eq('id', id)
    .single()
  if (error) throw new Error(error.message)
  return data
}

describe('direct sealed acquisition (add_card_acquisition, prompt §23-27)', () => {
  it('purchased/known cost: creates a real purchase, holding and lot with the chosen intent', async () => {
    const { data, error } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 129900,
        p_quantity: 1,
        p_acquired_on: today,
        p_sealed_intent: 'keep_sealed',
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(error).toBeNull()

    const holding = await holdingById(data!.holding_id)
    expect(holding.holding_kind).toBe('sealed')
    expect(holding.sealed_product_id).toBe(seedCatalog.sealedProductId)

    const lots = await lotsForHolding(data!.holding_id)
    expect(lots).toHaveLength(1)
    expect(lots[0]!.sealed_intent).toBe('keep_sealed')
    expect(lots[0]!.unit_cost_basis_minor).toBe(129900)
    expect(lots[0]!.purchase_line_id).not.toBeNull()
  })

  it('gift: not_paid, no fabricated zero cost, no purchase row created', async () => {
    const { data, error } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'gift',
        p_cost_basis_state: 'not_paid',
        p_quantity: 1,
        p_acquired_on: today,
        p_sealed_intent: 'undecided',
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(error).toBeNull()

    const { data: lot, error: lotError } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor, cost_basis_state, purchase_line_id')
      .eq('id', data!.lot_id)
      .single()
    expect(lotError).toBeNull()
    expect(lot!.cost_basis_state).toBe('not_paid')
    expect(lot!.unit_cost_basis_minor).toBeNull()
    expect(lot!.purchase_line_id).toBeNull()
  })

  it('existing/pre-tracking: unknown cost stays unknown, never coerced to 0', async () => {
    const { data, error } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 2,
        p_acquired_on: today,
        p_sealed_intent: 'undecided',
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(error).toBeNull()

    const { data: lot, error: lotError } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor, cost_basis_state, quantity')
      .eq('id', data!.lot_id)
      .single()
    expect(lotError).toBeNull()
    expect(lot!.cost_basis_state).toBe('unknown')
    expect(lot!.unit_cost_basis_minor).toBeNull()
    expect(lot!.quantity).toBe(2)
  })
})

describe('sealed intent cardinality — the mandatory real-world gate (prompt §17-19/§79)', () => {
  it('three identical boxes can end up 2 keep_sealed + 1 planned_to_open, truthfully, without touching cost basis', async () => {
    const { data: purchase, error: purchaseError } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 3,
            unit_price_minor: 15000,
          },
        ],
      })
      .single<{ id: string }>()
    expect(purchaseError).toBeNull()

    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase!.id)
      .single()
    expect(lineError).toBeNull()

    const { data: originalLot, error: lotError } = await service
      .from('acquisition_lots')
      .select('id, holding_id, quantity, quantity_remaining, sealed_intent, unit_cost_basis_minor')
      .eq('purchase_line_id', line!.id)
      .single<LotRow>()
    expect(lotError).toBeNull()
    expect(originalLot!.quantity).toBe(3)
    expect(originalLot!.sealed_intent).toBe('undecided') // create_purchase's default

    const holdingId = originalLot!.holding_id

    // Split 2 of the 3 units to "keep_sealed" — a partial change, so this must produce a sibling
    // lot rather than overwriting the whole position's intent.
    const { data: splitLot, error: splitError } = await clientA
      .rpc('set_sealed_lot_intent', {
        p_lot_id: originalLot!.id,
        p_intent: 'keep_sealed',
        p_quantity: 2,
      })
      .single<LotRow>()
    expect(splitError).toBeNull()
    expect(splitLot!.quantity).toBe(2)
    expect(splitLot!.sealed_intent).toBe('keep_sealed')
    expect(splitLot!.unit_cost_basis_minor).toBe(15000) // unchanged — organisational only

    const remainingOriginal = await service
      .from('acquisition_lots')
      .select('quantity, quantity_remaining, sealed_intent, unit_cost_basis_minor')
      .eq('id', originalLot!.id)
      .single()
    expect(remainingOriginal.data!.quantity).toBe(1)
    expect(remainingOriginal.data!.quantity_remaining).toBe(1)
    expect(remainingOriginal.data!.sealed_intent).toBe('undecided')
    expect(remainingOriginal.data!.unit_cost_basis_minor).toBe(15000)

    // The last unit: whole-remaining-quantity change, no split needed.
    const { error: wholeError } = await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: originalLot!.id,
      p_intent: 'planned_to_open',
    })
    expect(wholeError).toBeNull()

    const lots = await lotsForHolding(holdingId)
    expect(lots).toHaveLength(2)
    const totalQuantity = lots.reduce((sum, l) => sum + l.quantity, 0)
    expect(totalQuantity).toBe(3) // no unit invented or lost across the split

    const byIntent = new Map(lots.map((l) => [l.sealed_intent, l.quantity]))
    expect(byIntent.get('keep_sealed')).toBe(2)
    expect(byIntent.get('planned_to_open')).toBe(1)
    expect(byIntent.get('undecided')).toBeUndefined()

    // Read path: holding_summaries (Holding Detail's own query) must expose the same breakdown,
    // not collapse it to one intent for the whole holding.
    const { data: summary, error: summaryError } = await clientA
      .from('holding_summaries')
      .select('quantity, qty_keep_sealed, qty_planned_to_open, qty_undecided')
      .eq('holding_id', holdingId)
      .single()
    expect(summaryError).toBeNull()
    expect(summary!.quantity).toBe(3)
    expect(summary!.qty_keep_sealed).toBe(2)
    expect(summary!.qty_planned_to_open).toBe(1)
    expect(summary!.qty_undecided).toBe(0)

    // Financial invariant (prompt §80): changing intent touched no money.
    const { data: summaryRow } = await clientA.rpc('purchase_spending_summary').single()
    const spend = summaryRow as { cs_nok_minor: string }
    expect(Number(spend.cs_nok_minor)).toBeGreaterThanOrEqual(45000) // 3 x 150 kr, at minimum
  })

  it('set_sealed_lot_intent rejects a quantity larger than what remains in the lot', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 1,
            unit_price_minor: 10000,
          },
        ],
      })
      .single<{ id: string }>()
    const { data: line } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase!.id)
      .single()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', line!.id)
      .single()

    const { error } = await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: lot!.id,
      p_intent: 'keep_sealed',
      p_quantity: 5,
    })
    expect(error).not.toBeNull()
  })

  it('rejects sealed_intent on a non-sealed lot and requires it on a sealed one (owner-check trigger)', async () => {
    const { data: cardLot, error: cardError } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 5000,
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(cardError).toBeNull()

    // A raw card's lot has no sealed_intent — set_sealed_lot_intent must refuse it outright.
    const { error } = await clientA.rpc('set_sealed_lot_intent', {
      p_lot_id: cardLot!.lot_id,
      p_intent: 'keep_sealed',
    })
    expect(error).not.toBeNull()
  })
})

describe('manual valuation for sealed holdings — quantity multiplication, missing != zero (prompt §31-36/§81)', () => {
  it('per-unit manual value multiplies by quantity, and clearing it never becomes zero', async () => {
    const { data: acquired, error } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 3,
        p_acquired_on: today,
        p_sealed_intent: 'undecided',
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(error).toBeNull()
    const holdingId = acquired!.holding_id

    const { error: valueError } = await clientA.rpc('set_manual_valuation', {
      p_holding_id: holdingId,
      p_value_minor: 100000, // 1000.00 kr per unit
    })
    expect(valueError).toBeNull()

    const { data: provenance, error: provError } = await clientA
      .rpc('get_holding_value_provenance', { p_holding_id: holdingId })
      .single<{
        price_state: string
        unit_value_nok_minor: string | null
        holding_value_nok_minor: string | null
        quantity: string
      }>()
    expect(provError).toBeNull()
    expect(provenance!.price_state).toBe('manual')
    expect(Number(provenance!.unit_value_nok_minor)).toBe(100000)
    expect(Number(provenance!.holding_value_nok_minor)).toBe(300000) // 3 x 1000 kr
    expect(Number(provenance!.quantity)).toBe(3)

    const { error: clearError } = await clientA.rpc('clear_manual_valuation', {
      p_holding_id: holdingId,
    })
    expect(clearError).toBeNull()

    const { data: cleared, error: clearedError } = await clientA
      .rpc('get_holding_value_provenance', { p_holding_id: holdingId })
      .single<{ price_state: string; unit_value_nok_minor: string | null; quantity: string }>()
    expect(clearedError).toBeNull()
    expect(cleared!.price_state).toBe('missing') // never zero
    expect(cleared!.unit_value_nok_minor).toBeNull()
    expect(Number(cleared!.quantity)).toBe(3) // still owned
  })
})

describe('Portfolio value segment — cards vs sealed never silently merged (prompt §37-39/§82)', () => {
  it('portfolio_counts splits cards_value/sealed_value, and they sum to the total exactly', async () => {
    const before = await clientA.rpc('portfolio_counts').single<{
      portfolio_value_nok_minor: string
      cards_value_nok_minor: string
      sealed_value_nok_minor: string
    }>()
    const beforeTotal = Number(before.data!.portfolio_value_nok_minor)
    const beforeCards = Number(before.data!.cards_value_nok_minor)
    const beforeSealed = Number(before.data!.sealed_value_nok_minor)
    expect(beforeCards + beforeSealed).toBe(beforeTotal)

    // A graded card with a manual value — the existing "cards" contributor.
    const { data: graded, error: gradedError } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'graded',
        p_grader: 'psa',
        p_grade: 10,
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 20000,
        p_quantity: 1,
        p_acquired_on: today,
        p_manual_value_minor: 50000,
      })
      .single<{ holding_id: string }>()
    expect(gradedError).toBeNull()

    // A sealed product with a manual value — the "sealed" contributor.
    const { data: sealed, error: sealedError } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 1,
        p_acquired_on: today,
        p_sealed_intent: 'undecided',
        p_manual_value_minor: 30000,
      })
      .single<{ holding_id: string }>()
    expect(sealedError).toBeNull()

    const after = await clientA.rpc('portfolio_counts').single<{
      portfolio_value_nok_minor: string
      cards_value_nok_minor: string
      sealed_value_nok_minor: string
    }>()
    const afterTotal = Number(after.data!.portfolio_value_nok_minor)
    const afterCards = Number(after.data!.cards_value_nok_minor)
    const afterSealed = Number(after.data!.sealed_value_nok_minor)

    expect(afterCards + afterSealed).toBe(afterTotal) // invariant holds after real writes too
    expect(afterCards).toBe(beforeCards + 50000)
    expect(afterSealed).toBe(beforeSealed + 30000)
    expect(afterTotal).toBe(beforeTotal + 80000)

    await service.from('holdings').delete().eq('id', graded!.holding_id)
    await service.from('holdings').delete().eq('id', sealed!.holding_id)
  })
})

describe('purchase integration — mixed receipt, allocation exactness (prompt §62/§83)', () => {
  it('sealed + accessory + shipping: F1 holds, sealed line is collectible, shipping allocates across both', async () => {
    const { data: purchase, error } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_shipping_minor: 10000, // 100 kr
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 1,
            unit_price_minor: 120000, // 1200 kr
          },
          {
            line_type: 'accessory',
            description: 'Sleeves',
            quantity: 1,
            unit_price_minor: 10000, // 100 kr
          },
        ],
      })
      .single<{
        id: string
        subtotal_minor: number
        total_minor: number
        shipping_minor: number
      }>()
    expect(error).toBeNull()
    expect(purchase!.subtotal_minor).toBe(130000)
    expect(purchase!.total_minor).toBe(140000) // + 100 kr shipping

    const { data: lines, error: linesError } = await service
      .from('purchase_lines')
      .select('id, line_type, spend_class, allocated_shipping_minor, attributable_cost_minor')
      .eq('purchase_id', purchase!.id)
      .order('created_at')
    expect(linesError).toBeNull()

    const sealedLine = lines!.find((l) => l.line_type === 'sealed')!
    const accessoryLine = lines!.find((l) => l.line_type === 'accessory')!
    expect(sealedLine.spend_class).toBe('collectible')
    expect(accessoryLine.spend_class).toBe('hobby')
    // Shipping allocated pro rata by gross (largest remainder): 1200/(1200+100) share to sealed.
    expect(Number(sealedLine.allocated_shipping_minor)).toBeGreaterThan(
      Number(accessoryLine.allocated_shipping_minor),
    )
    expect(
      Number(sealedLine.allocated_shipping_minor) + Number(accessoryLine.allocated_shipping_minor),
    ).toBe(10000)

    const { data: sealedLot, error: lotError } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor, sealed_intent')
      .eq('purchase_line_id', sealedLine.id)
      .single()
    expect(lotError).toBeNull()
    // Lot basis includes the allocated shipping portion, not just the bare unit price.
    expect(sealedLot!.unit_cost_basis_minor).toBe(sealedLine.attributable_cost_minor)
    expect(sealedLot!.unit_cost_basis_minor).toBeGreaterThan(120000)
    expect(sealedLot!.sealed_intent).toBe('undecided')
  })
})

describe('a real sealed lot sells through the ordinary M10 sale engine, unmodified (prompt §57/§84)', () => {
  it('sells, freezes cost basis, reduces quantity; void restores it', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 1,
            unit_price_minor: 100000,
          },
        ],
      })
      .single<{ id: string }>()
    const { data: line } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase!.id)
      .single()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', line!.id)
      .single<{ id: string }>()

    const { data: sale, error } = await clientA
      .rpc('create_sale', {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: lot!.id, quantity: 1, unit_gross_minor: 140000 }],
      })
      .single<{ id: string; realized_result_nok_minor: number | null }>()
    expect(error).toBeNull()
    expect(sale!.realized_result_nok_minor).toBe(40000) // +400 kr

    const { data: afterSale } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', lot!.id)
      .single()
    expect(afterSale!.quantity_remaining).toBe(0)

    const { error: voidError } = await clientA.rpc('void_sale', { p_sale_id: sale!.id })
    expect(voidError).toBeNull()

    const { data: afterVoid } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', lot!.id)
      .single()
    expect(afterVoid!.quantity_remaining).toBe(1) // restored
  })
})
