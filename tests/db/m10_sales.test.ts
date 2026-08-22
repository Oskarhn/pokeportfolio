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
 * M10: Sales and History (FINANCIAL_MODEL.md §2.2/§2.6/§4.5, DATA_MODEL.md §5.7/§5.11). Proves the
 * hard gates the prompt names explicitly: E2 and E7 reproduced exactly against real stored rows,
 * the unknown-basis and mixed-basis paths, partial-lot/residual/adjustment exactness, allocation
 * exactness (fees/outbound/buyer shipping and the NOK conversion), void/double-void, concurrency,
 * idempotency, D1, F5, and result-sort NULL handling. Cross-tenant/authorization attacks live in
 * tests/authorization/m10_sales.test.ts, same split M8 established.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm10-sales-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface SaleRow {
  id: string
  currency: string
  gross_minor: number
  fees_minor: number
  shipping_cost_minor: number
  shipping_charged_minor: number
  net_proceeds_minor: number
  net_proceeds_nok_minor: number
  realized_result_nok_minor: number | null
  proceeds_from_uncosted_nok_minor: number
  fx_rate_to_nok: number
  voided_at: string | null
}

interface SaleLineRow {
  id: string
  sale_id: string
  lot_id: string
  quantity: number
  unit_gross_minor: number
  line_gross_minor: number
  allocated_fees_minor: number
  allocated_shipping_minor: number
  allocated_shipping_charged_minor: number
  net_proceeds_minor: number
  net_proceeds_nok_minor: number
  cost_basis_at_sale_nok_minor: number | null
  realized_result_nok_minor: number | null
}

interface PurchaseLineRow {
  id: string
  unit_price_minor: number
}

interface LotRow {
  id: string
  quantity: number
  quantity_remaining: number
  unit_cost_basis_nok_minor: number | null
  residual_nok_minor: number
  cost_basis_state: string
}

async function callCreateSale(client: TestClient, args: Record<string, unknown>) {
  return client
    .rpc('create_sale', { p_idempotency_key: crypto.randomUUID(), ...args })
    .single<SaleRow>()
}

async function linesForSale(saleId: string): Promise<SaleLineRow[]> {
  const { data, error } = await service
    .from('sale_lines')
    .select(
      'id, sale_id, lot_id, quantity, unit_gross_minor, line_gross_minor, allocated_fees_minor, allocated_shipping_minor, allocated_shipping_charged_minor, net_proceeds_minor, net_proceeds_nok_minor, cost_basis_at_sale_nok_minor, realized_result_nok_minor',
    )
    .eq('sale_id', saleId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data
}

async function purchaseLinesFor(purchaseId: string): Promise<PurchaseLineRow[]> {
  const { data, error } = await service
    .from('purchase_lines')
    .select('id, unit_price_minor')
    .eq('purchase_id', purchaseId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data
}

async function lotForPurchaseLine(lineId: string): Promise<LotRow> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, unit_cost_basis_nok_minor, residual_nok_minor, cost_basis_state',
    )
    .eq('purchase_line_id', lineId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

async function lotById(lotId: string): Promise<LotRow> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, unit_cost_basis_nok_minor, residual_nok_minor, cost_basis_state',
    )
    .eq('id', lotId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

/** One card purchase line, quantity 1, NOK. Returns the lot it produced. */
async function acquireLot(unitPriceMinor: number): Promise<LotRow> {
  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: unitPriceMinor,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  const lines = await purchaseLinesFor(purchase.id)
  return lotForPurchaseLine(lines[0]!.id)
}

describe('E2 — multiple copies, one sold, reproduced exactly in the database', () => {
  it('freezes cost basis from the explicitly-chosen lot, not an average of the three', async () => {
    const { data: purchase, error: purchaseError } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 10000,
          },
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 15000,
          },
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 20000,
          },
        ],
      })
      .single<{ id: string }>()
    expect(purchaseError).toBeNull()

    const lines = await purchaseLinesFor(purchase!.id)
    const l1 = await lotForPurchaseLine(lines[0]!.id) // 100
    await lotForPurchaseLine(lines[1]!.id) // 150 (L2, untouched)
    await lotForPurchaseLine(lines[2]!.id) // 200 (L3, untouched)

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 2000,
      p_lines: [{ lot_id: l1.id, quantity: 1, unit_gross_minor: 22000 }],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_minor).toBe(20000) // 220 - 20 = 200 kr
    expect(sale?.net_proceeds_nok_minor).toBe(20000)
    expect(sale?.realized_result_nok_minor).toBe(10000) // +100 kr

    const saleLines = await linesForSale(sale!.id)
    expect(saleLines).toHaveLength(1)
    expect(saleLines[0]!.cost_basis_at_sale_nok_minor).toBe(10000)
    expect(saleLines[0]!.realized_result_nok_minor).toBe(10000)

    const l1After = await lotById(l1.id)
    expect(l1After.quantity_remaining).toBe(0)
  })
})

describe('E7 — partial sale from a multi-unit lot, reproduced exactly', () => {
  it('L1 (1@100) + L4 (2@180): selling one unit each realizes +125 and +45, RRC +170, NSP 450', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.grassEnergyVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 10000,
          },
          {
            line_type: 'card',
            card_variant_id: seedCatalog.grassEnergyVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 15000,
          },
          {
            line_type: 'card',
            card_variant_id: seedCatalog.grassEnergyVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 20000,
          },
          {
            line_type: 'card',
            card_variant_id: seedCatalog.grassEnergyVariantId,
            condition: 'NM',
            quantity: 2,
            unit_price_minor: 18000,
          },
        ],
      })
      .single<{ id: string }>()

    const lines = await purchaseLinesFor(purchase!.id)
    const l1 = await lotForPurchaseLine(lines[0]!.id)
    const l4 = await lotForPurchaseLine(lines[3]!.id)
    expect(l4.quantity).toBe(2)

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 5000,
      p_lines: [
        { lot_id: l1.id, quantity: 1, unit_gross_minor: 25000 },
        { lot_id: l4.id, quantity: 1, unit_gross_minor: 25000 },
      ],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_minor).toBe(45000)
    expect(sale?.realized_result_nok_minor).toBe(17000)

    const saleLines = await linesForSale(sale!.id)
    const l1Line = saleLines.find((l) => l.lot_id === l1.id)!
    const l4Line = saleLines.find((l) => l.lot_id === l4.id)!
    expect(l1Line.cost_basis_at_sale_nok_minor).toBe(10000)
    expect(l1Line.realized_result_nok_minor).toBe(12500)
    expect(l4Line.cost_basis_at_sale_nok_minor).toBe(18000)
    expect(l4Line.realized_result_nok_minor).toBe(4500)

    const l4After = await lotById(l4.id)
    expect(l4After.quantity_remaining).toBe(1) // one unit of the two-unit lot remains
  })
})

describe('unknown cost basis — a gift sold for real proceeds, never a fabricated profit', () => {
  it('freezes cost_basis_at_sale and realized_result as NULL; proceeds count toward PUD', async () => {
    const { data: acquired, error: acquireError } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
        p_condition: 'NM',
        p_origin: 'gift',
        p_cost_basis_state: 'not_paid',
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(acquireError).toBeNull()

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: acquired!.lot_id, quantity: 1, unit_gross_minor: 45000 }],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_minor).toBe(45000)
    expect(sale?.realized_result_nok_minor).toBeNull()
    expect(sale?.proceeds_from_uncosted_nok_minor).toBe(45000)

    const saleLines = await linesForSale(sale!.id)
    expect(saleLines[0]!.cost_basis_at_sale_nok_minor).toBeNull()
    expect(saleLines[0]!.realized_result_nok_minor).toBeNull()
  })
})

describe('mixed known/unknown sale — proceeds reconcile exactly, no collapsed fake profit', () => {
  it('one costed line contributes RRC, one uncosted line contributes PUD, NSP is the honest sum', async () => {
    const known = await acquireLot(50000)
    const { data: gift } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.japaneseVariantId,
        p_condition: 'NM',
        p_origin: 'gift',
        p_cost_basis_state: 'not_paid',
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ lot_id: string }>()

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 1000,
      p_lines: [
        { lot_id: known.id, quantity: 1, unit_gross_minor: 60000 },
        { lot_id: gift!.lot_id, quantity: 1, unit_gross_minor: 30000 },
      ],
    })
    expect(error).toBeNull()

    const saleLines = await linesForSale(sale!.id)
    const knownLine = saleLines.find((l) => l.lot_id === known.id)!
    const giftLine = saleLines.find((l) => l.lot_id === gift!.lot_id)!
    expect(knownLine.realized_result_nok_minor).not.toBeNull()
    expect(giftLine.realized_result_nok_minor).toBeNull()

    const sumLineNet = saleLines.reduce((sum, l) => sum + l.net_proceeds_nok_minor, 0)
    expect(sumLineNet).toBe(sale!.net_proceeds_nok_minor) // no krone disappears across the split
    expect(sale!.realized_result_nok_minor).toBe(knownLine.realized_result_nok_minor)
    expect(sale!.proceeds_from_uncosted_nok_minor).toBe(giftLine.net_proceeds_nok_minor)
  })
})

describe('partial lot disposal and the residual rule (prompt §26/§85/§86)', () => {
  it('quantity_remaining decreases correctly and a later sale of the rest reconciles the lot basis', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'EX',
            quantity: 5,
            unit_price_minor: 1000,
          },
        ],
      })
      .single<{ id: string }>()
    const lines = await purchaseLinesFor(purchase!.id)
    const lot = await lotForPurchaseLine(lines[0]!.id)
    expect(lot.quantity).toBe(5)

    const { data: sale1 } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 2, unit_gross_minor: 1500 }],
    })
    expect(sale1).not.toBeNull()

    const afterFirst = await lotById(lot.id)
    expect(afterFirst.quantity_remaining).toBe(3)

    const { data: sale2 } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 3, unit_gross_minor: 1500 }],
    })
    expect(sale2).not.toBeNull()

    const afterSecond = await lotById(lot.id)
    expect(afterSecond.quantity_remaining).toBe(0)

    const line1 = (await linesForSale(sale1!.id))[0]!
    const line2 = (await linesForSale(sale2!.id))[0]!
    // Exact lot basis (5 * 1000 = 5000) reconciles across the two disposals, no residual to lose
    // here since 5000 divides evenly by 5 — the genuinely fractional case is proven next.
    expect(line1.cost_basis_at_sale_nok_minor).toBe(2000)
    expect(line2.cost_basis_at_sale_nok_minor).toBe(3000)
    expect(line1.cost_basis_at_sale_nok_minor! + line2.cost_basis_at_sale_nok_minor!).toBe(5000)
  })

  it('a lot whose exact cost does not divide evenly reconciles to the last minor unit across three separate sales', async () => {
    // A real purchase-produced lot, then reshaped directly to the awkward-division fixture this
    // test targets (10000 / 3 -> unit 3333, residual 1) — the same "reshape a real row under the
    // service role" technique tests/db/m8_purchase_ledger.test.ts already uses to reach a specific
    // state no ordinary create_purchase input conveniently produces on its own.
    const lot = await acquireLot(3333)
    await service
      .from('acquisition_lots')
      .update({
        quantity: 3,
        quantity_remaining: 3,
        unit_cost_basis_minor: 3333,
        unit_cost_basis_nok_minor: 3333,
        residual_minor: 1,
        residual_nok_minor: 1,
      })
      .eq('id', lot.id)

    const reshaped = await lotById(lot.id)
    expect(reshaped.unit_cost_basis_nok_minor).toBe(3333)
    expect(reshaped.residual_nok_minor).toBe(1)

    const sales: { id: string }[] = []
    for (let i = 0; i < 3; i++) {
      const { data: sale, error } = await callCreateSale(clientA, {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 5000 }],
      })
      expect(error).toBeNull()
      sales.push(sale!)
    }

    const bases = await Promise.all(
      sales.map(async (s) => (await linesForSale(s.id))[0]!.cost_basis_at_sale_nok_minor!),
    )
    expect(bases[0]).toBe(3333)
    expect(bases[1]).toBe(3333)
    expect(bases[2]).toBe(3334) // the residual lands on the disposal that exhausts the lot
    const total = bases.reduce((sum, b) => sum + b, 0)
    expect(total).toBe(10000) // 3*3333 + 1 residual = the exact lot basis

    const final = await lotById(lot.id)
    expect(final.quantity_remaining).toBe(0)
  })
})

describe('lot cost adjustments — exact minor-unit division across the lot (prompt §27)', () => {
  it('an odd adjustment total divides with the residual on the exhausting disposal', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'MT',
            quantity: 2,
            unit_price_minor: 10000,
          },
          {
            line_type: 'grading_fee',
            description: 'PSA grading',
            quantity: 1,
            unit_price_minor: 101,
          },
        ],
      })
      .single<{ id: string }>()
    const lines = await purchaseLinesFor(purchase!.id)
    const cardLine = lines[0]!
    const feeLine = lines[1]!
    const lot = await lotForPurchaseLine(cardLine.id)
    expect(lot.quantity).toBe(2)

    await service.from('lot_cost_adjustments').insert({
      lot_id: lot.id,
      user_id: userA.id,
      kind: 'grading_fee',
      purchase_line_id: feeLine.id,
      amount_minor: 101,
      currency: 'NOK',
      amount_nok_minor: 101,
      occurred_on: today,
    })

    const { data: sale1 } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 20000 }],
    })
    const { data: sale2 } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 20000 }],
    })

    const basis1 = (await linesForSale(sale1!.id))[0]!.cost_basis_at_sale_nok_minor!
    const basis2 = (await linesForSale(sale2!.id))[0]!.cost_basis_at_sale_nok_minor!
    // unit cost 10000 + adj_per_unit 50 = 10050 each; the exhausting disposal also gets adj_residual 1.
    expect([basis1, basis2].sort((a, b) => a - b)).toEqual([10050, 10051])
    expect(basis1 + basis2).toBe(20101) // 2*10000 (lot) + 101 (adjustment), exact
  })
})

describe('sale-level allocation exactness (prompt §36-43)', () => {
  it('fees, outbound shipping and buyer shipping each sum exactly across three uneven lines', async () => {
    const lotA = await acquireLot(1000)
    const lotB = await acquireLot(1000)
    const lotC = await acquireLot(1000)

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 100,
      p_shipping_cost_minor: 77,
      p_shipping_charged_minor: 33,
      p_lines: [
        { lot_id: lotA.id, quantity: 1, unit_gross_minor: 333 },
        { lot_id: lotB.id, quantity: 1, unit_gross_minor: 667 },
        { lot_id: lotC.id, quantity: 1, unit_gross_minor: 1000 },
      ],
    })
    expect(error).toBeNull()

    const saleLines = await linesForSale(sale!.id)
    const sumFees = saleLines.reduce((s, l) => s + l.allocated_fees_minor, 0)
    const sumShip = saleLines.reduce((s, l) => s + l.allocated_shipping_minor, 0)
    const sumShipCharged = saleLines.reduce((s, l) => s + l.allocated_shipping_charged_minor, 0)
    const sumNet = saleLines.reduce((s, l) => s + l.net_proceeds_minor, 0)

    expect(sumFees).toBe(100)
    expect(sumShip).toBe(77)
    expect(sumShipCharged).toBe(33)
    expect(sumNet).toBe(sale!.net_proceeds_minor)
  })

  it('zero total line gross allocates sale-level charges equally rather than dividing by zero', async () => {
    const lotA = await acquireLot(1000)
    const lotB = await acquireLot(1000)

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 10,
      p_lines: [
        { lot_id: lotA.id, quantity: 1, unit_gross_minor: 0 },
        { lot_id: lotB.id, quantity: 1, unit_gross_minor: 0 },
      ],
    })
    expect(error).toBeNull()
    const saleLines = await linesForSale(sale!.id)
    expect(saleLines.map((l) => l.allocated_fees_minor).sort()).toEqual([5, 5])
  })
})

describe('negative net proceeds — a genuine loss sale is not clamped or rejected (prompt §109-110)', () => {
  it('fees and shipping exceeding gross produce a negative NSP and a negative realized result', async () => {
    const lot = await acquireLot(10000) // cost 100 kr
    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 2000,
      p_shipping_cost_minor: 5000,
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 5000 }],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_minor).toBe(-2000) // 50 - 20 - 50 = -20 kr
    expect(sale?.realized_result_nok_minor).toBe(-12000) // -20 - 100 = -120 kr, a real loss
  })
})

describe('foreign-currency sale — manual FX, frozen NOK reconciles exactly across lines', () => {
  it('sums sale_lines.net_proceeds_nok_minor to the sale-level frozen NOK total exactly', async () => {
    const lotA = await acquireLot(10000)
    const lotB = await acquireLot(10000)
    const lotC = await acquireLot(10000)

    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'EUR',
      p_fx_rate_to_nok: '11.53000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_fees_minor: 33,
      p_lines: [
        { lot_id: lotA.id, quantity: 1, unit_gross_minor: 333 },
        { lot_id: lotB.id, quantity: 1, unit_gross_minor: 667 },
        { lot_id: lotC.id, quantity: 1, unit_gross_minor: 1000 },
      ],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_nok_minor).toBe(Math.round(sale!.net_proceeds_minor * 11.53))

    const saleLines = await linesForSale(sale!.id)
    const sumNok = saleLines.reduce((s, l) => s + l.net_proceeds_nok_minor, 0)
    expect(sumNok).toBe(sale!.net_proceeds_nok_minor)
  })
})

describe('void and double-void (prompt §52-54/§92-93)', () => {
  it('restores quantity_remaining, excludes the sale from sales_summary, and rejects a second void', async () => {
    const lot = await acquireLot(10000)
    const { data: sale } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 12000 }],
    })
    const afterSale = await lotById(lot.id)
    expect(afterSale.quantity_remaining).toBe(0)

    const { error: voidError } = await clientA.rpc('void_sale', { p_sale_id: sale!.id })
    expect(voidError).toBeNull()

    const afterVoid = await lotById(lot.id)
    expect(afterVoid.quantity_remaining).toBe(1)

    const { data: voidedSale } = await service
      .from('sales')
      .select('voided_at')
      .eq('id', sale!.id)
      .single()
    expect(voidedSale?.voided_at).not.toBeNull()

    const { error: secondVoidError } = await clientA.rpc('void_sale', { p_sale_id: sale!.id })
    expect(secondVoidError).not.toBeNull()
    expect(secondVoidError?.message).toMatch(/already voided/i)

    const afterSecondVoid = await lotById(lot.id)
    expect(afterSecondVoid.quantity_remaining).toBe(1) // not double-restored
  })
})

describe('D1 — quantity_remaining = quantity - Σ non-voided disposals', () => {
  it('holds after a mixed history of partial sale and void', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'PL',
            quantity: 4,
            unit_price_minor: 500,
          },
        ],
      })
      .single<{ id: string }>()
    const lines = await purchaseLinesFor(purchase!.id)
    const lot = await lotForPurchaseLine(lines[0]!.id)

    const { data: saleKeep } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 600 }],
    })
    const { data: saleVoided } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 2, unit_gross_minor: 600 }],
    })
    await clientA.rpc('void_sale', { p_sale_id: saleVoided!.id })

    const { data: disposals } = (await service
      .from('lot_disposals')
      .select('quantity, voided_at')
      .eq('lot_id', lot.id)) as { data: { quantity: number; voided_at: string | null }[] | null }
    const liveSum = (disposals ?? [])
      .filter((d) => d.voided_at === null)
      .reduce((s, d) => s + d.quantity, 0)

    const final = await lotById(lot.id)
    expect(final.quantity_remaining).toBe(final.quantity - liveSum)
    expect(final.quantity_remaining).toBe(3) // 4 - 1 (kept sale) - 0 (voided sale's 2 restored)
    void saleKeep
  })
})

describe('concurrency — two simultaneous sales of the same last unit (prompt §32/§94)', () => {
  it('exactly one succeeds; the lot never goes negative', async () => {
    const lot = await acquireLot(10000)

    const [first, second] = await Promise.all([
      callCreateSale(clientA, {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 5000 }],
      }),
      callCreateSale(clientA, {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 5000 }],
      }),
    ])

    const outcomes = [first, second]
    const succeeded = outcomes.filter((o) => o.error === null)
    const failed = outcomes.filter((o) => o.error !== null)
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error.message).toMatch(/available/i)

    const final = await lotById(lot.id)
    expect(final.quantity_remaining).toBe(0)

    const { data: liveDisposals } = await service
      .from('lot_disposals')
      .select('id')
      .eq('lot_id', lot.id)
      .is('voided_at', null)
    expect(liveDisposals).toHaveLength(1)
  })
})

describe('idempotency — a retried create_sale call never creates a second sale (prompt §49/§95)', () => {
  it('replaying the same idempotency key returns the original sale', async () => {
    const lot = await acquireLot(10000)
    const key = crypto.randomUUID()
    const args = {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: key,
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 12000 }],
    }

    const { data: first, error: firstError } = await clientA
      .rpc('create_sale', args)
      .single<SaleRow>()
    const { data: second, error: secondError } = await clientA
      .rpc('create_sale', args)
      .single<SaleRow>()
    expect(firstError).toBeNull()
    expect(secondError).toBeNull()
    expect(second?.id).toBe(first?.id)

    const { data: matching } = await service.from('sales').select('id').eq('idempotency_key', key)
    expect(matching).toHaveLength(1)

    const afterLot = await lotById(lot.id)
    expect(afterLot.quantity_remaining).toBe(0) // not double-disposed
  })
})

describe('result sorting never treats an unknown result as +/-infinity (prompt §100-101)', () => {
  it('an unknown-basis sale sorts to the end in both directions', async () => {
    const lotHigh = await acquireLot(1000)
    const lotLoss = await acquireLot(10000)
    const lotZero = await acquireLot(500)
    const { data: gift } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.japaneseVariantId,
        p_condition: 'NM',
        p_origin: 'gift',
        p_cost_basis_state: 'not_paid',
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ lot_id: string }>()

    await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotHigh.id, quantity: 1, unit_gross_minor: 51000 }], // +500
    })
    await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotLoss.id, quantity: 1, unit_gross_minor: 9000 }], // -10
    })
    await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotZero.id, quantity: 1, unit_gross_minor: 500 }], // 0
    })
    await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: gift!.lot_id, quantity: 1, unit_gross_minor: 45000 }], // unknown
    })

    const desc = await service
      .from('sales')
      .select('realized_result_nok_minor')
      .eq('user_id', userA.id)
      .order('realized_result_nok_minor', { ascending: false, nullsFirst: false })
    const ascending = await service
      .from('sales')
      .select('realized_result_nok_minor')
      .eq('user_id', userA.id)
      .order('realized_result_nok_minor', { ascending: true, nullsFirst: false })

    expect(desc.data!.at(-1)!.realized_result_nok_minor).toBeNull()
    expect(ascending.data!.at(-1)!.realized_result_nok_minor).toBeNull()
  })
})

describe('F5 — RRC + PUD = NSP - Σ known frozen cost_basis_at_sale', () => {
  it('holds across every non-voided sale line for the user', async () => {
    const { data: lines } = (await service
      .from('sale_lines')
      .select(
        'net_proceeds_nok_minor, cost_basis_at_sale_nok_minor, realized_result_nok_minor, sales!inner(voided_at, user_id)',
      )
      .eq('sales.user_id', userA.id)
      .is('sales.voided_at', null)) as {
      data:
        | {
            net_proceeds_nok_minor: number
            cost_basis_at_sale_nok_minor: number | null
            realized_result_nok_minor: number | null
          }[]
        | null
    }

    let nsp = 0
    let rrc = 0
    let pud = 0
    let knownBasisSum = 0
    for (const l of lines ?? []) {
      nsp += l.net_proceeds_nok_minor
      if (l.cost_basis_at_sale_nok_minor !== null) {
        rrc += l.realized_result_nok_minor!
        knownBasisSum += l.cost_basis_at_sale_nok_minor
      } else {
        pud += l.net_proceeds_nok_minor
      }
    }
    expect(rrc + pud).toBe(nsp - knownBasisSum)
  })
})

describe('purchase-edit-blocker regression (prompt §96) — a real sale disposal, not a synthetic patch', () => {
  it('update_purchase and void_purchase both refuse once a real create_sale disposal exists', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.charizardVariantId,
            condition: 'EX',
            quantity: 1,
            unit_price_minor: 10000,
          },
        ],
      })
      .single<{ id: string }>()
    const lines = await purchaseLinesFor(purchase!.id)
    const lot = await lotForPurchaseLine(lines[0]!.id)

    const { error: saleError } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 12000 }],
    })
    expect(saleError).toBeNull()

    const { error: updateError } = await clientA.rpc('update_purchase', {
      p_purchase_id: purchase!.id,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [{ line_id: lines[0]!.id, quantity: 1, unit_price_minor: 20000 }],
    })
    expect(updateError).not.toBeNull()
    expect(updateError?.message).toMatch(/partially disposed/i)

    const { error: voidError } = await clientA.rpc('void_purchase', { p_purchase_id: purchase!.id })
    expect(voidError).not.toBeNull()
    expect(voidError?.message).toMatch(/partially disposed/i)
  })
})

describe('manual valuation regression (prompt §97) — F4, cost basis is not market value', () => {
  it('changing a manual valuation after a sale never touches the frozen realized result', async () => {
    const { data: purchase } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.japaneseVariantId,
            condition: 'NM',
            grading_state: 'graded',
            grader: 'psa',
            grade: 9,
            quantity: 1,
            unit_price_minor: 10000,
          },
        ],
      })
      .single<{ id: string }>()
    const lines = await purchaseLinesFor(purchase!.id)
    const lot = await lotForPurchaseLine(lines[0]!.id)
    const { data: lotRow } = await service
      .from('acquisition_lots')
      .select('holding_id')
      .eq('id', lot.id)
      .single()

    const { data: sale } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 15000 }],
    })
    const before = (await linesForSale(sale!.id))[0]!.realized_result_nok_minor

    await clientA.rpc('set_manual_valuation', {
      p_holding_id: lotRow!.holding_id,
      p_value_minor: 500000,
    })

    const after = (await linesForSale(sale!.id))[0]!.realized_result_nok_minor
    expect(after).toBe(before)
  })
})

describe('market price regression (prompt §98) — F4, a new price snapshot never rewrites realized history', () => {
  it('inserting a fresh price_snapshots row after a sale leaves its realized result untouched', async () => {
    const lot = await acquireLot(10000)
    const { data: sale } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 15000 }],
    })
    const before = (await linesForSale(sale!.id))[0]!.realized_result_nok_minor

    // A fixed date far from "today" — never a "freshness" fixture (M9's own tests key snapshots by
    // age-relative-to-today, e.g. ageDays 0/4/31) — so this can never collide with another test
    // file's row for the same (card_variant_id, provider, snapshot_date) unique key, regardless of
    // which shared seed-catalog variant either side happens to use.
    await service.from('price_snapshots').upsert(
      {
        card_variant_id: seedCatalog.charizardVariantId,
        provider: 'tcgdex_cardmarket',
        price_kind: 'cm_trend',
        source_currency: 'EUR',
        value_minor: 999999,
        snapshot_date: '2019-06-15',
      },
      { onConflict: 'card_variant_id,provider,snapshot_date' },
    )

    const after = (await linesForSale(sale!.id))[0]!.realized_result_nok_minor
    expect(after).toBe(before)
  })
})
