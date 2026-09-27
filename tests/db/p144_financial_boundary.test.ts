import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { allocatePurchaseCharges } from '../../src/domain/allocation'
import { rawSqlAvailable, runRawSqlAsync } from './raw-sql'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P144 (the P130 audit report (output_130.txt) P130-16, P130-17, P130-18 date dimension). Each
 * describe block reproduces one finding against the real RPC surface exactly as the released client
 * reaches it — the assertions describe the CORRECT behaviour and therefore FAIL on the pre-P144
 * schema (20260916121000) and pass once 20260918120000_p144_financial_boundary_semantics.sql is
 * applied. P130-25 (blank price) is a client-side finding, covered in tests/ui and the
 * authenticated E2E suite. See docs/DECISIONS.md D-135.
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p144-boundary')
  client = await signInAs(user)
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

const utcToday = new Date().toISOString().slice(0, 10)

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

interface PurchaseRow {
  id: string
  subtotal_minor: number
  shipping_minor: number
  customs_minor: number
  discount_minor: number
  total_minor: number
  total_nok_minor: number
}

interface PurchaseLineRow {
  description: string
  line_total_minor: number
  allocated_shipping_minor: number
  allocated_customs_minor: number
  allocated_discount_minor: number
  attributable_cost_minor: number
  attributable_cost_nok_minor: number
}

/** One accessory line per entry, described `line-<index>` so the stored rows can be read back in
 *  submission order even when every line has the identical price (created_at ties within one
 *  transaction, so ordering by it is not deterministic). Accessory lines create no holding/lot,
 *  which keeps these allocation cases independent of inventory state. */
function accessoryLines(unitPrices: number[]) {
  return unitPrices.map((unit, index) => ({
    line_type: 'accessory',
    description: `line-${index}`,
    quantity: 1,
    unit_price_minor: unit,
  }))
}

async function readLines(purchaseId: string): Promise<PurchaseLineRow[]> {
  const { data, error } = await service
    .from('purchase_lines')
    .select(
      'description, line_total_minor, allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor, attributable_cost_minor, attributable_cost_nok_minor',
    )
    .eq('purchase_id', purchaseId)
    .order('description')
  if (error) throw new Error(error.message)
  return data
}

function createPurchase(args: Record<string, unknown>) {
  return client.rpc('create_purchase', { p_idempotency_key: crypto.randomUUID(), ...args })
}

describe('P130-16 — a valid receipt whose discount also consumes shipping/customs is accepted', () => {
  // The minimal reproduced receipt (output_130 T8-alloc): goods 1 + 2, shipping 1, customs 1,
  // discount 5. Gross = 3 + 1 + 1 = 5, so the receipt total is exactly 0 — a legitimate free
  // order (100% discount code). Before P144 the discount was allocated by goods weight alone,
  // ([1,2] -> [2,3]) which pushed line 0's attributable cost to 1 + 0 + 0 - 2 = -1 and
  // allocate_largest_remainder(total_nok, attributable) raised "weights must be non-negative".
  it('accepts goods [1,2] + shipping 1 + customs 1 - discount 5 (total 0), every line >= 0', async () => {
    const { data, error } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_lines: accessoryLines([1, 2]),
      p_shipping_minor: 1,
      p_customs_minor: 1,
      p_discount_minor: 5,
    }).single<PurchaseRow>()
    expect(error).toBeNull()
    expect(data?.total_minor).toBe(0)
    expect(data?.total_nok_minor).toBe(0)
    const lines = await readLines(data!.id)
    for (const line of lines) {
      expect(line.attributable_cost_minor).toBeGreaterThanOrEqual(0)
      expect(line.attributable_cost_nok_minor).toBeGreaterThanOrEqual(0)
    }
    // Conservation: every cent of the discount is placed, and the lines sum to the receipt total.
    expect(lines.reduce((s, l) => s + l.allocated_discount_minor, 0)).toBe(5)
    expect(lines.reduce((s, l) => s + l.attributable_cost_minor, 0)).toBe(0)
  })

  // Zero-value goods lines make the equal-split fallback shipping/customs allocation tie-break
  // to line 0 twice while an equal-split discount ties differently, so the pre-P144 formula
  // produced attributable [1, -1] here.
  it('accepts an all-zero-priced receipt paying shipping+customs 10 fully discounted', async () => {
    const { data, error } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_lines: accessoryLines([0, 0]),
      p_shipping_minor: 3,
      p_customs_minor: 7,
      p_discount_minor: 10,
    }).single<PurchaseRow>()
    expect(error).toBeNull()
    expect(data?.total_minor).toBe(0)
    const lines = await readLines(data!.id)
    expect(lines.map((l) => l.attributable_cost_minor)).toEqual([0, 0])
  })

  it('update_purchase accepts the same receipt on an existing purchase', async () => {
    const { data: created, error: createError } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_lines: accessoryLines([1, 2]),
    }).single<PurchaseRow>()
    expect(createError).toBeNull()
    const stored = await service
      .from('purchase_lines')
      .select('id, description')
      .eq('purchase_id', created!.id)
      .order('description')
    const { data, error } = await client
      .rpc('update_purchase', {
        p_purchase_id: created!.id,
        p_purchased_on: utcToday,
        p_currency: 'NOK',
        p_lines: (stored.data ?? []).map((row, index) => ({
          line_id: row.id,
          quantity: 1,
          unit_price_minor: index + 1,
        })),
        p_shipping_minor: 1,
        p_customs_minor: 1,
        p_discount_minor: 5,
      })
      .single<PurchaseRow>()
    expect(error).toBeNull()
    expect(data?.total_minor).toBe(0)
  })

  // A receipt that cannot be allocated under the accounting model — the discount exceeds the
  // whole receipt — is still refused, with the stable domain message, never clipped silently.
  it('still refuses a discount larger than subtotal + shipping + customs', async () => {
    const { error } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_lines: accessoryLines([1, 2]),
      p_shipping_minor: 1,
      p_customs_minor: 1,
      p_discount_minor: 6,
    }).single()
    expect(error?.message).toContain('discount cannot exceed the purchase subtotal plus shipping')
  })
})

interface SaleRow {
  id: string
  net_proceeds_minor: number
  net_proceeds_nok_minor: number
  realized_result_nok_minor: number | null
  proceeds_from_uncosted_nok_minor: number
}

interface SaleLineRow {
  net_proceeds_nok_minor: number
  cost_basis_at_sale_nok_minor: number | null
  realized_result_nok_minor: number | null
}

async function knownBasisLot(unitPriceMinor: number): Promise<string> {
  const { data: purchase, error } = await createPurchase({
    p_purchased_on: utcToday,
    p_currency: 'NOK',
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: unitPriceMinor,
      },
    ],
  }).single<PurchaseRow>()
  if (error) throw new Error(error.message)
  const { data: line } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', line!.id)
    .single()
  if (lotError) throw new Error(lotError.message)
  return lot.id
}

async function unknownBasisLot(): Promise<string> {
  const { data, error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: utcToday,
      p_client_request_key: crypto.randomUUID(),
    })
    .single<{ lot_id: string }>()
  if (error) throw new Error(error.message)
  return data.lot_id
}

function sell(lotId: string, gross: number, fees: number, shipping: number) {
  return client
    .rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: utcToday,
      p_currency: 'NOK',
      p_fees_minor: fees,
      p_shipping_cost_minor: shipping,
      p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: gross }],
    })
    .single<SaleRow>()
}

async function saleLine(saleId: string): Promise<SaleLineRow> {
  const { data, error } = await service
    .from('sale_lines')
    .select('net_proceeds_nok_minor, cost_basis_at_sale_nok_minor, realized_result_nok_minor')
    .eq('sale_id', saleId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

describe('P130-17 — net proceeds sign never decides whether a sale is representable', () => {
  // gross 500.00 - fees/shipping 800.00 = -300.00 (output_130's "gross 50, fees/shipping 80, net
  // -30" class). Net proceeds are a cash flow, independent of whether the lot's cost is known.
  const CASES = [
    { name: 'positive', gross: 20000, fees: 1000, shipping: 0, net: 19000 },
    { name: 'zero', gross: 5000, fees: 3000, shipping: 2000, net: 0 },
    { name: 'negative', gross: 5000, fees: 3000, shipping: 5000, net: -3000 },
  ] as const

  for (const basis of ['known', 'unknown'] as const) {
    for (const c of CASES) {
      it(`${basis} basis + ${c.name} net proceeds is recorded exactly`, async () => {
        const lotId = basis === 'known' ? await knownBasisLot(10000) : await unknownBasisLot()
        const { data: sale, error } = await sell(lotId, c.gross, c.fees, c.shipping)
        expect(error).toBeNull()
        expect(sale?.net_proceeds_minor).toBe(c.net)
        expect(sale?.net_proceeds_nok_minor).toBe(c.net)
        const line = await saleLine(sale!.id)
        expect(line.net_proceeds_nok_minor).toBe(c.net)
        if (basis === 'known') {
          expect(line.cost_basis_at_sale_nok_minor).toBe(10000)
          expect(line.realized_result_nok_minor).toBe(c.net - 10000)
          expect(sale?.realized_result_nok_minor).toBe(c.net - 10000)
          expect(sale?.proceeds_from_uncosted_nok_minor).toBe(0)
        } else {
          // Unknown basis: the basis-derived result stays NULL — never a fabricated 0 — while the
          // cash flow is kept in full, including its sign.
          expect(line.cost_basis_at_sale_nok_minor).toBeNull()
          expect(line.realized_result_nok_minor).toBeNull()
          expect(sale?.realized_result_nok_minor).toBeNull()
          expect(sale?.proceeds_from_uncosted_nok_minor).toBe(c.net)
        }
      })
    }
  }
})

describe('P130-18 (date dimension) — completed-event dates outside the contract are refused', () => {
  const BAD_DATES = ['0001-01-01', '1996-10-19', '2099-01-01', '9999-12-31']

  // The contract is a closed range: [1996-10-20, UTC-today + 1]. Both edges are asserted exactly,
  // one day on either side, because an off-by-one on either edge is the realistic regression.
  // 1996-10-20 is the release date of the first Pokemon Trading Card Game product (Base Set,
  // Japan); no ledger event can predate the product it records. UTC-today + 1 is the latest
  // calendar date that exists anywhere on Earth right now (UTC+14), so a completed event entered
  // "today" in any timezone is accepted without the server having to know the user's timezone.
  for (const good of ['1996-10-20', addDays(utcToday, 1)]) {
    it(`create_purchase accepts the boundary date ${good}`, async () => {
      const { error } = await createPurchase({
        p_purchased_on: good,
        p_currency: 'NOK',
        p_lines: accessoryLines([100]),
      }).single()
      expect(error).toBeNull()
    })
  }

  it(`create_purchase refuses the first date past the upper edge (${addDays(utcToday, 2)})`, async () => {
    const { error } = await createPurchase({
      p_purchased_on: addDays(utcToday, 2),
      p_currency: 'NOK',
      p_lines: accessoryLines([100]),
    }).single()
    expect(error?.message).toContain('invalid-event-date')
  })

  for (const bad of BAD_DATES) {
    it(`create_purchase refuses purchased_on ${bad}`, async () => {
      const { error } = await createPurchase({
        p_purchased_on: bad,
        p_currency: 'NOK',
        p_lines: accessoryLines([100]),
      }).single()
      expect(error?.message).toContain('invalid-event-date')
    })

    it(`create_sale refuses sold_on ${bad}`, async () => {
      const lotId = await knownBasisLot(10000)
      const { error } = await client
        .rpc('create_sale', {
          p_idempotency_key: crypto.randomUUID(),
          p_sold_on: bad,
          p_currency: 'NOK',
          p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: 12000 }],
        })
        .single()
      expect(error?.message).toContain('invalid-event-date')
    })

    it(`add_card_acquisition refuses acquired_on ${bad}`, async () => {
      const { error } = await client
        .rpc('add_card_acquisition', {
          p_card_variant_id: seedCatalog.pikachuVariantId,
          p_condition: 'NM',
          p_origin: 'pre_tracking',
          p_cost_basis_state: 'unknown',
          p_quantity: 1,
          p_acquired_on: bad,
          p_client_request_key: crypto.randomUUID(),
        })
        .single()
      expect(error?.message).toContain('invalid-event-date')
    })
  }
})

// ── P130-16, deeper: the SQL allocator against its TypeScript twin, and end to end ───────────────

describe('allocate_purchase_discount — the SQL twin of allocatePurchaseDiscount', () => {
  const lineTotal = fc.oneof(
    fc.constant(0n),
    fc.bigInt({ min: 0n, max: 1_000n }),
    fc.bigInt({ min: 0n, max: 10n ** 12n }),
    fc.bigInt({ min: 0n, max: 2n ** 58n }),
  )
  const charge = fc.oneof(
    fc.constant(0n),
    fc.bigInt({ min: 0n, max: 1_000n }),
    fc.bigInt({ min: 0n, max: 2n ** 58n }),
  )
  const receipt = fc
    .record({
      totals: fc.array(lineTotal, { minLength: 1, maxLength: 8 }),
      shipping: charge,
      customs: charge,
      fraction: fc.bigInt({ min: 0n, max: 1_000n }),
      whole: fc.boolean(),
    })
    .map(({ totals, shipping, customs, fraction, whole }) => {
      const gross = totals.reduce((a, b) => a + b, 0n) + shipping + customs
      return { totals, shipping, customs, discount: whole ? gross : (gross * fraction) / 1000n }
    })

  // The full 2^58-scale domain goes through ONE raw psql session and comes back as text: PostgREST
  // serialises bigint[] as JSON numbers, which JavaScript silently rounds above 2^53 (finding
  // P130-19, still open and deliberately out of scope here), so an RPC round trip cannot be an
  // exact oracle at that magnitude.
  it.skipIf(!rawSqlAvailable())(
    'agrees exactly with the TypeScript allocator on 300 generated receipts (incl. 2^58-scale amounts)',
    async () => {
      const receipts = fc.sample(receipt, { numRuns: 300, seed: 144 })
      const arr = (xs: readonly bigint[]) => `array[${xs.join(',')}]::bigint[]`
      const statements = receipts.map(({ totals, shipping, customs, discount }, i) => {
        const ts = allocatePurchaseCharges(totals, shipping, customs, discount)
        return `select ${i} || '|' || array_to_string(public.allocate_purchase_discount(${discount}::bigint, ${arr(totals)}, ${arr(ts.shipping)}, ${arr(ts.customs)}), ',');`
      })
      const result = await runRawSqlAsync(statements.join('\n'))
      expect(result.code, result.output).toBe(0)
      const rows = result.output.trim().split('\n')
      expect(rows).toHaveLength(receipts.length)
      rows.forEach((row, i) => {
        const [index, values] = row.split('|') as [string, string]
        const { totals, shipping, customs, discount } = receipts[Number(index)]!
        const ts = allocatePurchaseCharges(totals, shipping, customs, discount)
        expect(
          values.split(',').map((x) => BigInt(x)),
          `receipt ${i}`,
        ).toEqual(ts.discount)
      })
    },
    120_000,
  )

  it('agrees with the TypeScript allocator through the authenticated RPC surface (JSON-safe amounts)', async () => {
    const safe = fc
      .record({
        totals: fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 6 }),
        shipping: fc.bigInt({ min: 0n, max: 10n ** 9n }),
        customs: fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fraction: fc.bigInt({ min: 0n, max: 1_000n }),
      })
      .map(({ totals, shipping, customs, fraction }) => {
        const gross = totals.reduce((a, b) => a + b, 0n) + shipping + customs
        return { totals, shipping, customs, discount: (gross * fraction) / 1000n }
      })
    for (const { totals, shipping, customs, discount } of fc.sample(safe, {
      numRuns: 40,
      seed: 145,
    })) {
      const ts = allocatePurchaseCharges(totals, shipping, customs, discount)
      const { data, error } = await client.rpc('allocate_purchase_discount', {
        p_discount: Number(discount),
        p_line_totals: totals.map(Number),
        p_alloc_shipping: ts.shipping.map(Number),
        p_alloc_customs: ts.customs.map(Number),
      })
      expect(error).toBeNull()
      expect((data as number[]).map((x) => BigInt(x))).toEqual(ts.discount)
    }
  })

  it('refuses a discount above subtotal + shipping + customs with the stable domain message', async () => {
    const { error } = await client.rpc('allocate_purchase_discount', {
      p_discount: 11,
      p_line_totals: [4, 4],
      p_alloc_shipping: [1, 0],
      p_alloc_customs: [0, 1],
    })
    expect(error?.message).toContain('discount cannot exceed the purchase subtotal plus shipping')
  })

  it('refuses malformed arrays and a negative discount', async () => {
    const bad = [
      { p_discount: -1, p_line_totals: [1], p_alloc_shipping: [0], p_alloc_customs: [0] },
      { p_discount: 0, p_line_totals: [], p_alloc_shipping: [], p_alloc_customs: [] },
      { p_discount: 0, p_line_totals: [1, 2], p_alloc_shipping: [0], p_alloc_customs: [0, 0] },
      { p_discount: 0, p_line_totals: [-1], p_alloc_shipping: [0], p_alloc_customs: [0] },
    ]
    for (const args of bad) {
      const { error } = await client.rpc('allocate_purchase_discount', args)
      expect(error).not.toBeNull()
    }
  })

  it('is not callable by anon (only authenticated holds EXECUTE)', async () => {
    const anon = createAnonClient()
    const { error } = await anon.rpc('allocate_purchase_discount', {
      p_discount: 0,
      p_line_totals: [1],
      p_alloc_shipping: [0],
      p_alloc_customs: [0],
    })
    expect(error).not.toBeNull()
  })
})

describe('P130-16 end to end — create_purchase stores exactly what the TypeScript allocator computes', () => {
  const smallReceipt = fc
    .record({
      totals: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 50_000 })), {
        minLength: 1,
        maxLength: 5,
      }),
      shipping: fc.integer({ min: 0, max: 20_000 }),
      customs: fc.integer({ min: 0, max: 20_000 }),
      fraction: fc.integer({ min: 0, max: 1000 }),
      whole: fc.boolean(),
    })
    .map(({ totals, shipping, customs, fraction, whole }) => {
      const gross = totals.reduce((a, b) => a + b, 0) + shipping + customs
      return {
        totals,
        shipping,
        customs,
        discount: whole ? gross : Math.floor((gross * fraction) / 1000),
      }
    })

  it('40 generated NOK receipts (discount anywhere up to the whole receipt) are accepted and match', async () => {
    for (const r of fc.sample(smallReceipt, { numRuns: 40, seed: 1440 })) {
      const { data, error } = await createPurchase({
        p_purchased_on: utcToday,
        p_currency: 'NOK',
        p_lines: accessoryLines(r.totals),
        p_shipping_minor: r.shipping,
        p_customs_minor: r.customs,
        p_discount_minor: r.discount,
      }).single<PurchaseRow>()
      expect(error).toBeNull()
      const ts = allocatePurchaseCharges(
        r.totals.map(BigInt),
        BigInt(r.shipping),
        BigInt(r.customs),
        BigInt(r.discount),
      )
      const lines = await readLines(data!.id)
      expect(lines.map((l) => BigInt(l.allocated_discount_minor))).toEqual(ts.discount)
      expect(lines.map((l) => BigInt(l.attributable_cost_minor))).toEqual(ts.attributable)
      expect(lines.reduce((s, l) => s + l.attributable_cost_nok_minor, 0)).toBe(
        data!.total_nok_minor,
      )
    }
  }, 120_000)

  it('a foreign-currency (EUR) receipt with a discount over the goods allocates in NOK without a negative line', async () => {
    const { data, error } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'EUR',
      p_fx_rate_to_nok: '11.5',
      p_fx_rate_date: utcToday,
      p_fx_source: 'manual',
      p_lines: accessoryLines([1000, 2000]),
      p_shipping_minor: 500,
      p_customs_minor: 200,
      p_discount_minor: 3400, // goods 3000 + 400 of the 700 shipping/customs
    }).single<PurchaseRow>()
    expect(error).toBeNull()
    expect(data?.total_minor).toBe(300)
    const lines = await readLines(data!.id)
    expect(lines.reduce((s, l) => s + l.attributable_cost_minor, 0)).toBe(300)
    expect(lines.reduce((s, l) => s + l.attributable_cost_nok_minor, 0)).toBe(data!.total_nok_minor)
    for (const l of lines) expect(l.attributable_cost_nok_minor).toBeGreaterThanOrEqual(0)
  })

  it('a zero-exponent (JPY) receipt whose discount consumes shipping is accepted', async () => {
    const { data, error } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.0699',
      p_fx_rate_date: utcToday,
      p_fx_source: 'manual',
      p_lines: accessoryLines([3, 5]),
      p_shipping_minor: 1,
      p_discount_minor: 9,
    }).single<PurchaseRow>()
    expect(error).toBeNull()
    expect(data?.total_minor).toBe(0)
    const lines = await readLines(data!.id)
    expect(lines.map((l) => l.attributable_cost_minor)).toEqual([0, 0])
  })

  const cardLines = [
    {
      line_type: 'card',
      card_variant_id: seedCatalog.pikachuVariantId,
      condition: 'NM',
      quantity: 3,
      unit_price_minor: 333,
    },
    {
      line_type: 'card',
      card_variant_id: seedCatalog.charizardVariantId,
      condition: 'NM',
      quantity: 1,
      unit_price_minor: 2001,
    },
  ]

  it('an impossible receipt (discount above goods + shipping + customs = 4000) is refused, not clipped', async () => {
    const { data, error } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_shipping_minor: 700,
      p_customs_minor: 300,
      p_discount_minor: 4001,
      p_lines: cardLines,
    }).single<PurchaseRow>()
    expect(error?.message).toContain('discount cannot exceed the purchase subtotal plus shipping')
    expect(data).toBeNull()
  })

  it('card lines: the lot basis still sums to the attributable cost when the discount consumes shipping', async () => {
    const ok = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_shipping_minor: 700,
      p_customs_minor: 300,
      p_discount_minor: 3900, // goods 3000 + 900 of the 1000 shipping/customs
      p_lines: cardLines,
    }).single<PurchaseRow>()
    expect(ok.error).toBeNull()
    expect(ok.data?.total_minor).toBe(100)
    const { data: lineData } = await service
      .from('purchase_lines')
      .select('id, attributable_cost_minor')
      .eq('purchase_id', ok.data!.id)
    const lines = (lineData ?? []) as { id: string; attributable_cost_minor: number }[]
    expect(lines.reduce((s, l) => s + l.attributable_cost_minor, 0)).toBe(100)
    for (const line of lines) {
      expect(line.attributable_cost_minor).toBeGreaterThanOrEqual(0)
      const { data: lotData } = await service
        .from('acquisition_lots')
        .select('quantity, unit_cost_basis_minor, residual_minor')
        .eq('purchase_line_id', line.id)
      const lots = (lotData ?? []) as {
        quantity: number
        unit_cost_basis_minor: number
        residual_minor: number
      }[]
      const basis = lots.reduce(
        (s, l) => s + l.unit_cost_basis_minor * l.quantity + l.residual_minor,
        0,
      )
      expect(basis).toBe(line.attributable_cost_minor)
    }
  })
})

// ── P130-17, deeper: summaries, edits, voids and idempotency around a negative uncosted sale ─────

describe('P130-17 — summaries and lifecycle around a negative uncosted sale', () => {
  let summaryUser: SyntheticUser
  let summaryClient: TestClient

  beforeAll(async () => {
    summaryUser = await createSyntheticUser(service, 'p144-summary')
    summaryClient = await signInAs(summaryUser)
  })

  afterAll(async () => {
    await deleteSyntheticUser(service, summaryUser.id)
  })

  async function lotFor(c: TestClient, unknown: boolean): Promise<string> {
    if (unknown) {
      const { data, error } = await c
        .rpc('add_card_acquisition', {
          p_card_variant_id: seedCatalog.pikachuVariantId,
          p_condition: 'NM',
          p_origin: 'pre_tracking',
          p_cost_basis_state: 'unknown',
          p_quantity: 1,
          p_acquired_on: utcToday,
          p_client_request_key: crypto.randomUUID(),
        })
        .single<{ lot_id: string }>()
      if (error) throw new Error(error.message)
      return data.lot_id
    }
    const { data: purchase, error } = await c
      .rpc('create_purchase', {
        p_purchased_on: utcToday,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.charizardVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 10000,
          },
        ],
      })
      .single<{ id: string }>()
    if (error) throw new Error(error.message)
    const { data: line } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .single()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', line!.id)
      .single()
    return lot!.id
  }

  function saleArgs(lines: unknown[], fees = 0, shipping = 0, key = crypto.randomUUID()) {
    return {
      p_idempotency_key: key,
      p_sold_on: utcToday,
      p_currency: 'NOK',
      p_fees_minor: fees,
      p_shipping_cost_minor: shipping,
      p_lines: lines,
    }
  }

  it('sales_summary carries the negative PUD and F5 (RRC + PUD = NSP - basis) still holds', async () => {
    const known = await lotFor(summaryClient, false)
    const unknown = await lotFor(summaryClient, true)
    // known: net 19000, basis 10000 -> RRC +9000. unknown: net -3000 -> PUD -3000.
    const a = await summaryClient
      .rpc('create_sale', saleArgs([{ lot_id: known, quantity: 1, unit_gross_minor: 20000 }], 1000))
      .single<SaleRow>()
    expect(a.error).toBeNull()
    const b = await summaryClient
      .rpc(
        'create_sale',
        saleArgs([{ lot_id: unknown, quantity: 1, unit_gross_minor: 5000 }], 3000, 5000),
      )
      .single<SaleRow>()
    expect(b.error).toBeNull()

    const { data, error } = await summaryClient.rpc('sales_summary').single<{
      nsp_nok_minor: string
      rrc_nok_minor: string
      pud_nok_minor: string
    }>()
    expect(error).toBeNull()
    expect(BigInt(data!.nsp_nok_minor)).toBe(16000n)
    expect(BigInt(data!.rrc_nok_minor)).toBe(9000n)
    expect(BigInt(data!.pud_nok_minor)).toBe(-3000n)
    expect(BigInt(data!.rrc_nok_minor) + BigInt(data!.pud_nok_minor)).toBe(16000n - 10000n)
  })

  it('a mixed sale (one costed + one uncosted line) with negative total net: PUD negative, RRC exact, NSP the honest sum', async () => {
    const known = await lotFor(summaryClient, false)
    const unknown = await lotFor(summaryClient, true)
    const { data: sale, error } = await summaryClient
      .rpc(
        'create_sale',
        saleArgs(
          [
            { lot_id: known, quantity: 1, unit_gross_minor: 3000 },
            { lot_id: unknown, quantity: 1, unit_gross_minor: 1000 },
          ],
          0,
          9000, // net = 4000 - 9000 = -5000, split by gross 3:1 -> -3750 / -1250
        ),
      )
      .single<SaleRow>()
    expect(error).toBeNull()
    expect(sale?.net_proceeds_nok_minor).toBe(-5000)
    expect(sale?.proceeds_from_uncosted_nok_minor).toBe(-1250)
    expect(sale?.realized_result_nok_minor).toBe(-3750 - 10000)
    // F5 at sale level: RRC + PUD = NSP - basis
    expect(
      (sale!.realized_result_nok_minor as number) + sale!.proceeds_from_uncosted_nok_minor,
    ).toBe(sale!.net_proceeds_nok_minor - 10000)
  })

  it('update_sale can move an uncosted sale from positive to negative net, and back', async () => {
    const unknown = await lotFor(summaryClient, true)
    const { data: sale, error } = await summaryClient
      .rpc(
        'create_sale',
        saleArgs([{ lot_id: unknown, quantity: 1, unit_gross_minor: 9000 }], 1000),
      )
      .single<SaleRow>()
    expect(error).toBeNull()
    expect(sale?.proceeds_from_uncosted_nok_minor).toBe(8000)
    const { data: lineRow } = await service
      .from('sale_lines')
      .select('id')
      .eq('sale_id', sale!.id)
      .single()

    const negative = await summaryClient
      .rpc('update_sale', {
        p_sale_id: sale!.id,
        p_sold_on: utcToday,
        p_currency: 'NOK',
        p_lines: [{ line_id: lineRow!.id, unit_gross_minor: 1000 }],
        p_fees_minor: 4000,
        p_shipping_cost_minor: 0,
        p_shipping_charged_minor: 0,
      })
      .single<SaleRow>()
    expect(negative.error).toBeNull()
    expect(negative.data?.proceeds_from_uncosted_nok_minor).toBe(-3000)
    expect(negative.data?.realized_result_nok_minor).toBeNull()

    const back = await summaryClient
      .rpc('update_sale', {
        p_sale_id: sale!.id,
        p_sold_on: utcToday,
        p_currency: 'NOK',
        p_lines: [{ line_id: lineRow!.id, unit_gross_minor: 9000 }],
        p_fees_minor: 1000,
        p_shipping_cost_minor: 0,
        p_shipping_charged_minor: 0,
      })
      .single<SaleRow>()
    expect(back.error).toBeNull()
    expect(back.data?.proceeds_from_uncosted_nok_minor).toBe(8000)
  })

  it('an identical replay of a negative uncosted sale returns the original; a modified replay is refused (P138 unchanged)', async () => {
    const unknown = await lotFor(summaryClient, true)
    const key = crypto.randomUUID()
    const lines = [{ lot_id: unknown, quantity: 1, unit_gross_minor: 2000 }]
    const first = await summaryClient
      .rpc('create_sale', saleArgs(lines, 0, 6000, key))
      .single<SaleRow>()
    expect(first.error).toBeNull()
    expect(first.data?.proceeds_from_uncosted_nok_minor).toBe(-4000)

    const replay = await summaryClient
      .rpc('create_sale', saleArgs(lines, 0, 6000, key))
      .single<SaleRow>()
    expect(replay.error).toBeNull()
    expect(replay.data?.id).toBe(first.data?.id)

    const modified = await summaryClient
      .rpc('create_sale', saleArgs(lines, 0, 7000, key))
      .single<SaleRow>()
    expect(modified.error?.message).toContain('idempotency-key-reuse')
  })

  it('voiding a negative uncosted sale removes it from the summary', async () => {
    const unknown = await lotFor(summaryClient, true)
    const before = await summaryClient.rpc('sales_summary').single<{ pud_nok_minor: string }>()
    const { data: sale } = await summaryClient
      .rpc(
        'create_sale',
        saleArgs([{ lot_id: unknown, quantity: 1, unit_gross_minor: 500 }], 0, 2500),
      )
      .single<SaleRow>()
    const during = await summaryClient.rpc('sales_summary').single<{ pud_nok_minor: string }>()
    expect(BigInt(during.data!.pud_nok_minor) - BigInt(before.data!.pud_nok_minor)).toBe(-2000n)
    const voided = await summaryClient.rpc('void_sale', { p_sale_id: sale!.id })
    expect(voided.error).toBeNull()
    const after = await summaryClient.rpc('sales_summary').single<{ pud_nok_minor: string }>()
    expect(after.data!.pud_nok_minor).toBe(before.data!.pud_nok_minor)
  })

  it('the gross/fees/shipping components are still individually non-negative at the table level', async () => {
    const unknown = await lotFor(summaryClient, true)
    const { data: sale } = await summaryClient
      .rpc('create_sale', saleArgs([{ lot_id: unknown, quantity: 1, unit_gross_minor: 500 }]))
      .single<SaleRow>()
    const { error } = await service.from('sales').update({ fees_minor: -1 }).eq('id', sale!.id)
    expect(error?.message).toContain('sales_amounts_non_negative')
  })
})

// ── P130-18 date dimension, deeper ───────────────────────────────────────────────────────────────

describe('P130-18 (date dimension) — every writer, edits, and timezone independence', () => {
  it('update_purchase refuses a new out-of-contract date and still accepts a valid one', async () => {
    const { data: created } = await createPurchase({
      p_purchased_on: utcToday,
      p_currency: 'NOK',
      p_lines: accessoryLines([100]),
    }).single<PurchaseRow>()
    const { data: lineRow } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', created!.id)
      .single()
    const edit = (date: string) =>
      client
        .rpc('update_purchase', {
          p_purchase_id: created!.id,
          p_purchased_on: date,
          p_currency: 'NOK',
          p_lines: [{ line_id: lineRow!.id, quantity: 1, unit_price_minor: 100 }],
        })
        .single<PurchaseRow>()
    expect((await edit('0001-01-01')).error?.message).toContain('invalid-event-date')
    expect((await edit(addDays(utcToday, 2))).error?.message).toContain('invalid-event-date')
    expect((await edit('2005-05-05')).error).toBeNull()
  })

  it('update_sale refuses an out-of-contract sold_on', async () => {
    const lotId = await knownBasisLot(10000)
    const { data: sale } = await sell(lotId, 12000, 0, 0)
    const { data: lineRow } = await service
      .from('sale_lines')
      .select('id')
      .eq('sale_id', sale!.id)
      .single()
    const { error } = await client
      .rpc('update_sale', {
        p_sale_id: sale!.id,
        p_sold_on: '2099-01-01',
        p_currency: 'NOK',
        p_lines: [{ line_id: lineRow!.id, unit_gross_minor: 12000 }],
      })
      .single()
    expect(error?.message).toContain('invalid-event-date')
  })

  it('the released client direct acquired_on column update is covered too', async () => {
    const lotId = await unknownBasisLot()
    const bad = await client
      .from('acquisition_lots')
      .update({ acquired_on: '0001-01-01' })
      .eq('id', lotId)
    expect(bad.error?.message).toContain('invalid-event-date')
    const future = await client
      .from('acquisition_lots')
      .update({ acquired_on: '2099-01-01' })
      .eq('id', lotId)
    expect(future.error?.message).toContain('invalid-event-date')
    const good = await client
      .from('acquisition_lots')
      .update({ acquired_on: '2010-06-15' })
      .eq('id', lotId)
    expect(good.error).toBeNull()
  })

  it('a sealed acquisition and create_opening_from_provisional refuse bad dates', async () => {
    const sealed = await client
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_sealed_intent: 'undecided',
        p_client_request_key: crypto.randomUUID(),
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 1,
        p_acquired_on: '9999-12-31',
      })
      .single()
    expect(sealed.error?.message).toContain('invalid-event-date')

    const opening = await client
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 1,
        p_total_paid_minor: 29900,
        p_purchased_on: utcToday,
        p_opened_on: '2099-01-01',
        p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
      })
      .single()
    expect(opening.error?.message).toContain('invalid-event-date')
  })

  it('infinity and -infinity are refused (the date type accepts them)', async () => {
    for (const bad of ['infinity', '-infinity']) {
      const { error } = await createPurchase({
        p_purchased_on: bad,
        p_currency: 'NOK',
        p_lines: accessoryLines([100]),
      }).single()
      expect(error?.message).toContain('invalid-event-date')
    }
  })

  it('a refused date leaves no purchase behind (the whole RPC rolls back)', async () => {
    const marker = 7_777_001
    const { error } = await createPurchase({
      p_purchased_on: '0001-01-01',
      p_currency: 'NOK',
      p_lines: accessoryLines([marker]),
    }).single()
    expect(error).not.toBeNull()
    const { count } = await service
      .from('purchase_lines')
      .select('id', { count: 'exact', head: true })
      .eq('unit_price_minor', marker)
    expect(count).toBe(0)
  })

  // Timezone safety. The bound is computed from `now() at time zone 'UTC'`, so it cannot move with
  // the session's TimeZone setting: a session at UTC-12 (where the local date is a day BEHIND UTC)
  // and one at UTC+14 (a day AHEAD) must both accept exactly UTC-today+1 and refuse +2. Dates are
  // compared as calendar dates and never pass through a timestamp.
  const zones = ['UTC', 'Etc/GMT+12', 'Pacific/Kiritimati', 'Europe/Oslo', 'America/Los_Angeles']
  it.skipIf(!rawSqlAvailable())(
    'accepts UTC-today+1 and refuses UTC-today+2 identically under every session timezone',
    async () => {
      for (const zone of zones) {
        const result = await runRawSqlAsync(`
          begin;
          set local timezone = '${zone}';
          create temp table t_event (d date) on commit drop;
          create trigger t_event_contract before insert or update of d on t_event
            for each row execute function public.enforce_completed_event_date('d');
          insert into t_event values ((now() at time zone 'UTC')::date + 1);
          insert into t_event values (date '1996-10-20');
          insert into t_event values (date '2000-01-01');
          do $$ begin
            begin
              insert into t_event values ((now() at time zone 'UTC')::date + 2);
              raise exception 'NOT REFUSED';
            exception when sqlstate '22008' then null;
            end;
          end $$;
          do $$ begin
            begin
              insert into t_event values (date '1996-10-19');
              raise exception 'NOT REFUSED';
            exception when sqlstate '22008' then null;
            end;
          end $$;
          select 'ok:' || count(*) from t_event;
          commit;
        `)
        expect(result.output, `timezone ${zone}`).toContain('ok:3')
        expect(result.code, `timezone ${zone}`).toBe(0)
      }
    },
    60_000,
  )

  it.skipIf(!rawSqlAvailable())(
    'a legacy row that predates the contract stays editable for unrelated columns; only a date change is validated',
    async () => {
      const { data: created } = await createPurchase({
        p_purchased_on: utcToday,
        p_currency: 'NOK',
        p_lines: accessoryLines([100]),
      }).single<PurchaseRow>()
      const id = created!.id
      // Simulate a pre-contract row (triggers bypassed, as only a superuser can).
      const seeded = await runRawSqlAsync(`
        begin;
        set local session_replication_role = replica;
        update public.purchases set purchased_on = date '0001-01-01' where id = '${id}';
        commit;
      `)
      expect(seeded.code).toBe(0)

      const notes = await service
        .from('purchases')
        .update({ notes: 'legacy row edit' })
        .eq('id', id)
      expect(notes.error).toBeNull()
      const stillBad = await service
        .from('purchases')
        .update({ purchased_on: '0001-01-02' })
        .eq('id', id)
      expect(stillBad.error?.message).toContain('invalid-event-date')
      const fixed = await service
        .from('purchases')
        .update({ purchased_on: '2001-02-03' })
        .eq('id', id)
      expect(fixed.error).toBeNull()
    },
  )
})
