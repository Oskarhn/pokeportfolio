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
import { allocate } from '../../src/domain/allocation'

/**
 * M8: the multi-line purchase ledger (FINANCIAL_MODEL.md §1-4/§7, DATA_MODEL.md §5.3).
 * Every RPC call derives ownership from the caller's own session — there is no user_id argument
 * to forge, so cross-tenant attacks live in tests/authorization/m8_purchases.test.ts. This file
 * proves the accounting itself: E3 and E10 reproduced exactly against real stored rows, F1
 * (GPO = CS + HS) over a real aggregate, the SQL allocator's parity with the TypeScript reference,
 * the zero-subtotal edge case, deterministic tie-breaking, a zero-decimal currency, and the
 * edit/void lifecycle including the void_acquisition_lot correction (M8 prompt §62).
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm8-ledger-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface PurchaseRow {
  id: string
  currency: string
  subtotal_minor: number
  shipping_minor: number
  customs_minor: number
  discount_minor: number
  total_minor: number
  total_nok_minor: number
  fx_rate_to_nok: number
  voided_at: string | null
}

async function callCreate(client: TestClient, args: Record<string, unknown>) {
  return client.rpc('create_purchase', args).single<PurchaseRow>()
}

interface PurchaseLineRow {
  id: string
  line_type: string
  spend_class: string
  quantity: number
  unit_price_minor: number
  line_total_minor: number
  allocated_shipping_minor: number
  allocated_customs_minor: number
  allocated_discount_minor: number
  attributable_cost_minor: number
  attributable_cost_nok_minor: number
}

async function linesFor(purchaseId: string): Promise<PurchaseLineRow[]> {
  const { data, error } = await service
    .from('purchase_lines')
    .select(
      'id, line_type, spend_class, quantity, unit_price_minor, line_total_minor, allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor, attributable_cost_minor, attributable_cost_nok_minor',
    )
    .eq('purchase_id', purchaseId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data
}

describe('allocate_largest_remainder: SQL/TypeScript parity', () => {
  const cases: { total: number; weights: number[] }[] = [
    { total: 10000, weights: [70000, 50000, 10000] }, // E3 shipping
    { total: 57123, weights: [4950] }, // E10 single line
    { total: 999, weights: [0, 0] }, // zero-subtotal edge
    { total: 101, weights: [100, 100] }, // exact tie
    { total: 0, weights: [500, 300, 200] }, // nothing to allocate
    { total: 1, weights: [1, 1, 1, 1, 1] }, // one unit, five equal claimants
  ]

  for (const { total, weights } of cases) {
    it(`matches allocate(${total}, [${weights.join(',')}])`, async () => {
      const expected = allocate(BigInt(total), weights.map(BigInt)).map(String)
      const { data, error } = await clientA.rpc('allocate_largest_remainder', {
        p_total: total,
        p_weights: weights,
      })
      expect(error).toBeNull()
      expect((data as number[]).map(String)).toEqual(expected)
    })
  }
})

describe('E3 — mixed receipt with shipping, reproduced exactly in the database', () => {
  it('GPO = CS + HS and every allocated share matches FINANCIAL_MODEL.md §8 to the øre', async () => {
    const { data: purchase, error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: 10000,
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: 1,
          unit_price_minor: 70000,
        },
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 50000,
        },
        { line_type: 'accessory', description: 'Sleeves', quantity: 1, unit_price_minor: 10000 },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.total_minor).toBe(140000)
    expect(purchase?.total_nok_minor).toBe(140000)

    const lines = await linesFor(purchase!.id)
    const [etb, card, sleeves] = lines
    expect(etb?.allocated_shipping_minor).toBe(5385)
    expect(card?.allocated_shipping_minor).toBe(3846)
    expect(sleeves?.allocated_shipping_minor).toBe(769)
    expect(etb?.attributable_cost_minor).toBe(75385)
    expect(card?.attributable_cost_minor).toBe(53846)
    expect(sleeves?.attributable_cost_minor).toBe(10769)

    const cs = (etb?.attributable_cost_nok_minor ?? 0) + (card?.attributable_cost_nok_minor ?? 0)
    const hs = sleeves?.attributable_cost_nok_minor ?? 0
    expect(cs).toBe(129231)
    expect(hs).toBe(10769)
    expect(cs + hs).toBe(purchase!.total_nok_minor) // invariant F1

    // The card and sealed lines each produced a real holding + known-cost lot.
    const { data: cardLot } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor, cost_basis_state, origin')
      .eq('purchase_line_id', card!.id)
      .single()
    expect(cardLot?.unit_cost_basis_minor).toBe(53846)
    expect(cardLot?.cost_basis_state).toBe('known')
    expect(cardLot?.origin).toBe('purchase')

    // Sleeves (accessory) created no holding/lot at all.
    const { data: sleevesLots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', sleeves!.id)
    expect(sleevesLots).toEqual([])
  })
})

describe('E10 — foreign-currency purchase, frozen NOK conversion', () => {
  it('total_nok_minor is exactly 57123 (571.23 NOK) and stays frozen', async () => {
    const { data: purchase, error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'EUR',
      p_shipping_minor: 450,
      p_fx_rate_to_nok: '11.54000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 4500,
        },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.total_minor).toBe(4950)
    expect(purchase?.total_nok_minor).toBe(57123)
    expect(Number(purchase?.fx_rate_to_nok)).toBeCloseTo(11.54, 8)

    const lines = await linesFor(purchase!.id)
    expect(lines[0]?.attributable_cost_minor).toBe(4950)
    expect(lines[0]?.attributable_cost_nok_minor).toBe(57123)
  })
})

describe('a zero-decimal currency (JPY) is never treated as if it had cents', () => {
  it('stores exact JPY minor units, not ×100', async () => {
    const { data: purchase, error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.09000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        { line_type: 'accessory', description: 'Playmat', quantity: 1, unit_price_minor: 1500 },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.currency).toBe('JPY')
    expect(purchase?.total_minor).toBe(1500)
    expect(purchase?.total_nok_minor).toBe(135) // round(1500 * 0.09)
  })
})

describe('zero-subtotal edge: a shipping-only purchase splits equally', () => {
  it('allocates 999 equally-with-tiebreak across two zero-price lines', async () => {
    const { data: purchase, error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: 999,
      p_lines: [
        { line_type: 'accessory', description: 'Free sample A', quantity: 1, unit_price_minor: 0 },
        { line_type: 'accessory', description: 'Free sample B', quantity: 1, unit_price_minor: 0 },
      ],
    })
    expect(error).toBeNull()
    const lines = await linesFor(purchase!.id)
    expect(lines.map((l) => l.allocated_shipping_minor)).toEqual([500, 499])
    expect(purchase?.total_minor).toBe(999)
  })
})

describe('spend class: dominant-inherited default for standalone/other lines', () => {
  it('a shipping_standalone line with no override follows the larger classified total', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'accessory', description: 'Binder', quantity: 1, unit_price_minor: 1000 },
        {
          line_type: 'shipping_standalone',
          description: 'Postage line item',
          quantity: 1,
          unit_price_minor: 200,
        },
      ],
    })
    const lines = await linesFor(purchase!.id)
    expect(lines[0]?.spend_class).toBe('hobby')
    expect(lines[1]?.spend_class).toBe('hobby') // inherits the dominant (only) classified class
  })

  it('with no other classified line, defaults to collectible', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'other', description: 'Unclear charge', quantity: 1, unit_price_minor: 100 },
      ],
    })
    const lines = await linesFor(purchase!.id)
    expect(lines[0]?.spend_class).toBe('collectible')
  })

  it('an explicit override is respected over the default', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'accessory',
          description: 'Storage box',
          quantity: 1,
          unit_price_minor: 100,
          spend_class: 'collectible',
        },
      ],
    })
    const lines = await linesFor(purchase!.id)
    expect(lines[0]?.spend_class).toBe('collectible')
  })
})

describe('validation', () => {
  it('rejects a purchase with zero lines', async () => {
    const { error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [],
    })
    expect(error).not.toBeNull()
  })

  it('rejects a discount larger than the purchase total', async () => {
    const { error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_discount_minor: 100000,
      p_lines: [
        { line_type: 'accessory', description: 'Sleeves', quantity: 1, unit_price_minor: 1000 },
      ],
    })
    expect(error).not.toBeNull()
  })

  it('rejects a card line with neither a catalog variant nor a manual card', async () => {
    const { error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [{ line_type: 'card', condition: 'NM', quantity: 1, unit_price_minor: 1000 }],
    })
    expect(error).not.toBeNull()
  })

  it('rejects an accessory line with no description', async () => {
    const { error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [{ line_type: 'accessory', quantity: 1, unit_price_minor: 1000 }],
    })
    expect(error).not.toBeNull()
  })

  it('rejects a non-NOK purchase with no FX rate', async () => {
    const { error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'EUR',
      p_lines: [
        { line_type: 'accessory', description: 'Sleeves', quantity: 1, unit_price_minor: 1000 },
      ],
    })
    expect(error).not.toBeNull()
  })
})

describe('purchase_spending_summary: F1 over a real aggregate', () => {
  it('GPO = CS + HS across several purchases, and a void removes its contribution', async () => {
    const before = await clientA.rpc('purchase_spending_summary').single<{
      gpo_nok_minor: string
      cs_nok_minor: string
      hs_nok_minor: string
      purchase_count: number
    }>()

    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: 50,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.grassEnergyVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 950,
        },
      ],
    })

    const after = await clientA.rpc('purchase_spending_summary').single<{
      gpo_nok_minor: string
      cs_nok_minor: string
      hs_nok_minor: string
      purchase_count: number
    }>()
    expect(Number(after.data?.gpo_nok_minor) - Number(before.data?.gpo_nok_minor)).toBe(1000)
    expect(Number(after.data?.gpo_nok_minor)).toBe(
      Number(after.data?.cs_nok_minor) + Number(after.data?.hs_nok_minor),
    )
    expect(after.data?.purchase_count).toBe((before.data?.purchase_count ?? 0) + 1)

    await clientA.rpc('void_purchase', { p_purchase_id: purchase!.id })

    const afterVoid = await clientA.rpc('purchase_spending_summary').single<{
      gpo_nok_minor: string
    }>()
    expect(afterVoid.data?.gpo_nok_minor).toBe(before.data?.gpo_nok_minor)
  })
})

describe('void_purchase', () => {
  it('voids the purchase and every lot it produced, coherently', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 5000,
        },
        { line_type: 'accessory', description: 'Toploader', quantity: 1, unit_price_minor: 200 },
      ],
    })
    const lines = await linesFor(purchase!.id)
    const cardLine = lines.find((l) => l.line_type === 'card')!

    const { error } = await clientA.rpc('void_purchase', { p_purchase_id: purchase!.id })
    expect(error).toBeNull()

    const { data: voided } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase!.id)
      .single()
    expect(voided?.voided_at).not.toBeNull()

    const { data: lot } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('purchase_line_id', cardLine.id)
      .single()
    expect(lot?.voided_at).not.toBeNull()
  })

  it('is blocked, naming the line, when a produced lot has been disposed elsewhere', async () => {
    // No disposal-producing milestone (sales/openings/grading/trades) has shipped yet, so this
    // simulates the future case directly at the database level, as the migration header for
    // update_purchase/void_purchase documents.
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 2,
          unit_price_minor: 1000,
        },
      ],
    })
    const lines = await linesFor(purchase!.id)
    await service
      .from('acquisition_lots')
      .update({ quantity_remaining: 1 })
      .eq('purchase_line_id', lines[0]!.id)

    const { error } = await clientA.rpc('void_purchase', { p_purchase_id: purchase!.id })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/disposed/i)

    const { data: stillLive } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase!.id)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })
})

describe('update_purchase', () => {
  it('recomputes allocations and the lot cost basis atomically', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: 0,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.grassEnergyVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 1000,
        },
      ],
    })
    const [line] = await linesFor(purchase!.id)

    const { data: updated, error } = await clientA
      .rpc('update_purchase', {
        p_purchase_id: purchase!.id,
        p_purchased_on: today,
        p_currency: 'NOK',
        p_shipping_minor: 200,
        p_lines: [{ line_id: line!.id, quantity: 1, unit_price_minor: 1000 }],
      })
      .single<PurchaseRow>()
    expect(error).toBeNull()
    expect(updated?.total_minor).toBe(1200)

    const [updatedLine] = await linesFor(purchase!.id)
    expect(updatedLine?.attributable_cost_minor).toBe(1200)

    const { data: lot } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor')
      .eq('purchase_line_id', line!.id)
      .single()
    expect(lot?.unit_cost_basis_minor).toBe(1200)
  })

  it('rejects an attempt to add or remove lines', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'accessory', description: 'Deck box', quantity: 1, unit_price_minor: 500 },
      ],
    })

    const { error } = await clientA.rpc('update_purchase', {
      p_purchase_id: purchase!.id,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_id: crypto.randomUUID(), quantity: 1, unit_price_minor: 500 }, // not a real line
      ],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/add or remove lines/i)
  })
})

describe('void_acquisition_lot: parent-purchase scope corrected for multi-line purchases (M8 prompt §62)', () => {
  it('does not void the whole purchase while another line still has a live lot', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 1000,
        },
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 500,
        },
      ],
    })
    const lines = await linesFor(purchase!.id)
    const { data: lotA } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', lines[0]!.id)
      .single()
    const { data: lotB } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', lines[1]!.id)
      .single()

    await clientA.rpc('void_acquisition_lot', { p_lot_id: lotA!.id })

    const { data: stillLive } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase!.id)
      .single()
    expect(stillLive?.voided_at).toBeNull() // the fix: line B's lot is still live

    await clientA.rpc('void_acquisition_lot', { p_lot_id: lotB!.id })

    const { data: nowVoided } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase!.id)
      .single()
    expect(nowVoided?.voided_at).not.toBeNull() // last live lot gone: the whole receipt voids
  })

  // M8.1 (prompt §6): the M8-era check above only ever counted *other live lots*, which happened
  // to be correct for the two-card case (both lines produce a lot) but is wrong the moment a
  // receipt has a line that never produces one at all — the exact regression this proves fixed.
  it('never auto-voids a purchase while an accessory line still represents real spend (M8.1 fix)', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 1000,
        },
        { line_type: 'accessory', description: 'Deck box', quantity: 1, unit_price_minor: 500 },
      ],
    })
    const lines = await linesFor(purchase!.id)
    const cardLine = lines.find((l) => l.line_type === 'card')!
    const { data: cardLot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', cardLine.id)
      .single()

    const { error } = await clientA.rpc('void_acquisition_lot', { p_lot_id: cardLot!.id })
    expect(error).toBeNull()

    const { data: afterPurchase } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase!.id)
      .single()
    // The bug: this used to be non-null (the accessory's 500 øre silently vanished from CS/HS).
    expect(afterPurchase?.voided_at).toBeNull()

    const { data: accessoryLine } = await service
      .from('purchase_lines')
      .select('line_total_minor, spend_class')
      .eq('purchase_id', purchase!.id)
      .eq('line_type', 'accessory')
      .single()
    expect(accessoryLine?.line_total_minor).toBe(500)
    expect(accessoryLine?.spend_class).toBe('hobby')
  })

  it('refuses to void a lot that has already been partially disposed elsewhere', async () => {
    const { data: purchase } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 3,
          unit_price_minor: 200,
        },
      ],
    })
    const lines = await linesFor(purchase!.id)
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', lines[0]!.id)
      .single()

    // No disposal-producing milestone ships yet (M10 sales, M16 openings, ...) — simulated the same
    // way update_purchase/void_purchase's own blocker tests already do, directly under service role.
    await service.from('acquisition_lots').update({ quantity_remaining: 1 }).eq('id', lot!.id)

    const { error } = await clientA.rpc('void_acquisition_lot', { p_lot_id: lot!.id })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/partially disposed/i)

    const { data: stillLive } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('id', lot!.id)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })
})

describe('fx_rates: market data, service-role writes only', () => {
  it('authenticated can read but not write the shared FX cache', async () => {
    const { error: insertError } = await clientA.from('fx_rates').insert({
      base_currency: 'EUR',
      quote_currency: 'NOK',
      rate_date: today,
      rate: 99.99,
      source: 'norges_bank',
    })
    expect(insertError).not.toBeNull()

    await service.from('fx_rates').insert({
      base_currency: 'USD',
      quote_currency: 'NOK',
      rate_date: today,
      rate: 10.5,
      source: 'norges_bank',
    })
    const { data: read, error: readError } = await clientA
      .from('fx_rates')
      .select('rate')
      .eq('base_currency', 'USD')
      .eq('rate_date', today)
      .maybeSingle()
    expect(readError).toBeNull()
    expect(read).not.toBeNull()
  })
})
