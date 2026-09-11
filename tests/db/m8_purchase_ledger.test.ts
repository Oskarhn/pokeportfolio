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
  notes: string | null
}

async function callCreate(client: TestClient, args: Record<string, unknown>) {
  return client.rpc('create_purchase', args).single<PurchaseRow>()
}

interface PurchaseLineRow {
  id: string
  line_type: string
  description: string | null
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
      'id, line_type, description, spend_class, quantity, unit_price_minor, line_total_minor, allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor, attributable_cost_minor, attributable_cost_nok_minor',
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

describe('allocate_largest_remainder: no bigint*bigint overflow at scale (P117)', () => {
  // The original body computed `p_total * v_effective[i]` in plain bigint arithmetic before
  // dividing — once that intermediate product exceeded bigint's ~9.22e18 ceiling, Postgres
  // raised "bigint out of range" even though p_total, every weight and the eventual result are
  // all well inside bigint's range. Reproduced for real via a single-line EUR purchase with a
  // manual FX rate (unit_price_minor 2_147_483_647 -> total_nok_minor ~24.78e9, allocated across
  // one line whose weight is 2_147_483_647 — the product of those two is ~5.3e19). Values are
  // passed as strings so the JS test client's own JSON encoding never rounds them on the way in.
  // Every case here is chosen so each individual RESULT share stays under 2^53-1: PostgREST
  // serializes a `bigint[]` return as plain JSON numbers, so a share at or above 2^53 would
  // silently round on the way back through this JS test client's own JSON.parse — a real, but
  // separate and unrelated, response-side "hidden JS Number conversion" limitation (confirmed by
  // hand: allocate_largest_remainder('922337203685477500', [3,7]) computes the correct shares
  // server-side but the JS client observes them off by a few units). Out of scope here: fixing it
  // would mean re-typing every bigint RPC response app-wide, for a magnitude (single-digit
  // quintillions of minor units) FINANCIAL_MODEL.md's domain never approaches.
  const bigCases: { total: bigint; weights: bigint[] }[] = [
    { total: 24_781_961_286n, weights: [2_147_483_647n] }, // the exact reproduction above
    { total: 9_007_199_254_740_991n, weights: [9_007_199_254_740_991n] }, // 2^53-1, single weight
    {
      total: 9_007_199_254_740_991n,
      weights: [9_007_199_254_740_991n, 9_007_199_254_740_991n],
    }, // two large equal weights: exercises the tie-break path at scale, not just a single-weight passthrough
  ]

  for (const { total, weights } of bigCases) {
    it(`matches allocate(${total}, [${weights.join(',')}]) without overflowing`, async () => {
      const expected = allocate(total, weights).map(String)
      const { data, error } = await clientA.rpc('allocate_largest_remainder', {
        p_total: total.toString(),
        p_weights: weights.map(String),
      })
      expect(error).toBeNull()
      expect((data as string[]).map(String)).toEqual(expected)
      // Invariant F6: the shares sum exactly back to the total, even at this scale.
      const sum = (data as string[]).reduce((acc, v) => acc + BigInt(v), 0n)
      expect(sum).toBe(total)
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

    // Matched by line_type, never by array position: all three lines are created inside one
    // create_purchase transaction and therefore share one identical created_at (Postgres now()
    // is transaction-scoped) — `.order('created_at')` has no tiebreaker among them, so which
    // physical row a query returns first is a query-plan detail, not a guarantee. It flips
    // under enough surrounding data (proven: this exact assertion failed when run inside the
    // full test:db suite and passed in isolation, both against the identical fixture).
    const lines = await linesFor(purchase!.id)
    const etb = lines.find((l) => l.line_type === 'sealed')
    const card = lines.find((l) => l.line_type === 'card')
    const sleeves = lines.find((l) => l.line_type === 'accessory')
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

describe('P117: a large foreign-currency single-line purchase does not overflow the allocator', () => {
  it('unit_price_minor near 2^31 with a real FX rate used to raise "bigint out of range"', async () => {
    // Before the P117 fix, allocate_largest_remainder computed total_nok_minor * weight in plain
    // bigint arithmetic (~5.3e19 here) before dividing, which overflows bigint (~9.22e18 max)
    // even though every actual input and output value is well inside bigint's range. Both values
    // below stay under 2^53, so this is a plain end-to-end assertion, no string/BigInt plumbing
    // needed to dodge JSON precision loss.
    const { data: purchase, error } = await callCreate(clientA, {
      p_purchased_on: today,
      p_currency: 'EUR',
      p_fx_rate_to_nok: '11.54000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 2147483647,
        },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.total_minor).toBe(2147483647)
    // round(2147483647 * 11.54) = round(24781961286.38) = 24781961286.
    expect(purchase?.total_nok_minor).toBe(24781961286)

    const lines = await linesFor(purchase!.id)
    // Single line, no shipping/customs/discount: the whole NOK total is attributed to it exactly.
    expect(lines[0]?.attributable_cost_nok_minor).toBe(24781961286)
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
    // Matched by description, never by array position (see the E3 test above for why
    // `.order('created_at')` cannot recover input order among lines from one transaction).
    // allocate_largest_remainder's tie-break is by array index (FINANCIAL_MODEL.md §4.2): the
    // first line in p_lines wins ties, so "Free sample A" (index 0) gets the extra øre.
    const lines = await linesFor(purchase!.id)
    const sampleA = lines.find((l) => l.description === 'Free sample A')
    const sampleB = lines.find((l) => l.description === 'Free sample B')
    expect(sampleA?.allocated_shipping_minor).toBe(500)
    expect(sampleB?.allocated_shipping_minor).toBe(499)
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

describe('idempotency — create_purchase never double-writes on retry (P108, P107 §17)', () => {
  function sealedArgs(overrides: Record<string, unknown> = {}) {
    return {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: 2,
          unit_price_minor: 5000,
        },
      ],
      ...overrides,
    }
  }

  async function lotsForPurchase(purchaseId: string) {
    const lines = await linesFor(purchaseId)
    if (lines.length === 0) return []
    const { data, error } = await service
      .from('acquisition_lots')
      .select('id, purchase_line_id')
      .in(
        'purchase_line_id',
        lines.map((l) => l.id),
      )
    if (error) throw new Error(error.message)
    return data
  }

  it('exact sequential replay returns the same purchase, no duplicate rows anywhere', async () => {
    const key = crypto.randomUUID()
    const args = sealedArgs({ p_idempotency_key: key })

    const { data: first, error: firstError } = await callCreate(clientA, args)
    const { data: second, error: secondError } = await callCreate(clientA, args)
    expect(firstError).toBeNull()
    expect(secondError).toBeNull()
    expect(second?.id).toBe(first?.id)

    const { data: matching } = await service
      .from('purchases')
      .select('id')
      .eq('idempotency_key', key)
    expect(matching).toHaveLength(1)

    const lines = await linesFor(first!.id)
    expect(lines).toHaveLength(1) // not doubled
    const lots = await lotsForPurchase(first!.id)
    expect(lots).toHaveLength(1)
  })

  it('a third replay after editing notes still replays cleanly AND preserves the edit (D-122)', async () => {
    const key = crypto.randomUUID()
    const { data: first, error: firstError } = await callCreate(
      clientA,
      sealedArgs({ p_idempotency_key: key, p_notes: 'first attempt' }),
    )
    expect(firstError).toBeNull()

    // notes is deliberately NOT material (prompt §10: don't compare irrelevant operational
    // metadata) — a retry that only changed the annotation text must still replay, not refuse.
    const { data: second, error: secondError } = await callCreate(
      clientA,
      sealedArgs({ p_idempotency_key: key, p_notes: 'edited after the fact' }),
    )
    expect(secondError).toBeNull()
    expect(second?.id).toBe(first?.id)

    // D-122: a legitimate replay must not silently discard the caller's edited notes — the
    // returned row AND the stored row must both reflect the LATEST submitted notes, not the
    // first attempt's. Only the notes annotation may move; everything else about the purchase
    // (financial rows) is untouched by the replay.
    expect(second?.notes).toBe('edited after the fact')
    const { data: stored } = await service
      .from('purchases')
      .select('notes')
      .eq('id', first!.id)
      .single()
    expect(stored?.notes).toBe('edited after the fact')
  })

  it.each([
    ['quantity', { p_lines: [{ ...sealedArgs().p_lines[0], quantity: 3 }] }],
    ['unit price / cost', { p_lines: [{ ...sealedArgs().p_lines[0], unit_price_minor: 6000 }] }],
    [
      'card identity',
      {
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.charizardVariantId,
            condition: 'NM',
            quantity: 2,
            unit_price_minor: 5000,
          },
        ],
      },
    ],
    ['purchase date', { p_purchased_on: '2020-01-01' }],
    [
      'currency/FX',
      {
        p_currency: 'EUR',
        p_fx_rate_to_nok: '11.00000000',
        p_fx_rate_date: today,
        p_fx_source: 'manual',
      },
    ],
  ])(
    'a same-key replay with a different %s is refused, not silently replayed',
    async (_label, overrides) => {
      const key = crypto.randomUUID()
      const { error: firstError } = await callCreate(
        clientA,
        sealedArgs({ p_idempotency_key: key }),
      )
      expect(firstError).toBeNull()

      const { data: second, error: secondError } = await callCreate(
        clientA,
        sealedArgs({ p_idempotency_key: key, ...overrides }),
      )
      expect(second).toBeNull()
      expect(secondError).not.toBeNull()
      expect(secondError?.message).toMatch(/idempotency-key-reuse/i)

      // The refused replay must not have written anything of its own.
      const { data: matching } = await service
        .from('purchases')
        .select('id')
        .eq('idempotency_key', key)
      expect(matching).toHaveLength(1)
    },
  )

  it('same-key concurrent double-submit commits exactly one purchase (race-safe)', async () => {
    const key = crypto.randomUUID()
    const args = sealedArgs({ p_idempotency_key: key })

    const [a, b] = await Promise.all([callCreate(clientA, args), callCreate(clientA, args)])
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect(a.data?.id).toBe(b.data?.id)

    const { data: matching } = await service
      .from('purchases')
      .select('id')
      .eq('idempotency_key', key)
    expect(matching).toHaveLength(1)

    const lines = await linesFor(a.data!.id)
    expect(lines).toHaveLength(1)
    const lots = await lotsForPurchase(a.data!.id)
    expect(lots).toHaveLength(1)
  })

  it('omitting the key behaves exactly as before: two calls create two separate purchases', async () => {
    const args = sealedArgs()
    const { data: first, error: firstError } = await callCreate(clientA, args)
    const { data: second, error: secondError } = await callCreate(clientA, args)
    expect(firstError).toBeNull()
    expect(secondError).toBeNull()
    expect(second?.id).not.toBe(first?.id)
  })

  it('P111 (prompt §10): an UNRELATED unique_violation with a key present is re-raised, never mistaken for an idempotency race', async () => {
    // First purchase: a sealed line with a manual valuation. Creates a new sealed holding plus
    // its one active `manual_valuations` row.
    const firstKey = crypto.randomUUID()
    const { data: first, error: firstError } = await callCreate(
      clientA,
      sealedArgs({
        p_idempotency_key: firstKey,
        p_lines: [
          {
            ...sealedArgs().p_lines[0],
            manual_value_minor: 9000,
          },
        ],
      }),
    )
    expect(firstError).toBeNull()

    // Second purchase: the SAME sealed_product_id (holdings-dedup reuses the SAME holding, since
    // condition/grading_state/grader/grade are all forced identical for a sealed line) and ALSO
    // sets a manual_value_minor — its `manual_valuations` INSERT collides with
    // `manual_valuations_one_active` (one active valuation per holding), a unique_violation with
    // NOTHING to do with `purchases_user_idempotency_key_idx`. This second call uses its OWN
    // fresh idempotency key, one that was never (and — because the whole transaction rolls back —
    // never will be) stored on any purchases row.
    const secondKey = crypto.randomUUID()
    const { data: second, error: secondError } = await callCreate(
      clientA,
      sealedArgs({
        p_idempotency_key: secondKey,
        p_lines: [
          {
            ...sealedArgs().p_lines[0],
            manual_value_minor: 15000,
          },
        ],
      }),
    )

    // Must surface as a real error — NOT silently treated as a replay of `first`, and NOT
    // silently swallowed. The handler can only conclude "this is a legitimate replay" by finding
    // an existing purchases row under `secondKey`; since that INSERT rolled back with everything
    // else in the same transaction, no such row exists, so it must re-raise the real error.
    expect(second).toBeNull()
    expect(secondError).not.toBeNull()
    expect(secondError?.message).not.toMatch(/idempotency-key-reuse/i)
    expect(secondError?.message).toMatch(/manual_valuations_one_active|duplicate key/i)

    // The failed second attempt must not have committed a purchase under its own key, and must
    // not have disturbed the first purchase's own valuation.
    const { data: matchingSecond } = await service
      .from('purchases')
      .select('id')
      .eq('idempotency_key', secondKey)
    expect(matchingSecond).toHaveLength(0)

    const firstLines = await linesFor(first!.id)
    const { data: firstLots } = await service
      .from('acquisition_lots')
      .select('holding_id')
      .in(
        'purchase_line_id',
        firstLines.map((l) => l.id),
      )
    const { data: valuations } = await service
      .from('manual_valuations')
      .select('value_minor')
      .eq('holding_id', firstLots?.[0]?.holding_id ?? '')
    expect(valuations).toHaveLength(1)
    expect(valuations?.[0]?.value_minor).toBe(9000)
  })
})
