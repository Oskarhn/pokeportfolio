import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { rawSqlAvailable, runRawSqlAsync } from './raw-sql'
import { convert } from '../../src/domain/fx'
import { fromMinorUnits } from '../../src/domain/money'
import type { CurrencyCode } from '../../src/domain/currency'

/**
 * P133 (docs/DECISIONS.md D-132, ai_outputs/Claude_outputs/output_130.txt P130-02): every SQL FX
 * conversion assumed the source currency shared NOK's minor-unit exponent (2). Invisible for
 * NOK/EUR/USD/GBP (all exponent 2); a 100x error for JPY (exponent 0). This file proves the fix —
 * the canonical `public.money_minor_to_nok_minor` helper and the RPCs/CHECK constraints that now
 * call it — at three levels: the helper in isolation (raw SQL, no RPC/auth overhead), a property
 * test proving exact parity with the independent client-side reference (`src/domain/fx.ts`
 * `convert()`) across thousands of generated values, and full end-to-end RPC coverage for
 * create_purchase/update_purchase/create_sale/update_sale so a regression in the wiring — not just
 * the helper — would be caught too.
 *
 * The raw-SQL sections need a direct postgres session (see tests/db/raw-sql.ts) and are skipped,
 * not failed, when one is unavailable — same convention as p132a/p132b's held-lock harnesses.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p133-fx-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

interface PurchaseRow {
  id: string
  currency: string
  total_minor: number
  total_nok_minor: number
  fx_rate_to_nok: number
}

interface PurchaseLineRow {
  id: string
  attributable_cost_minor: number
  attributable_cost_nok_minor: number
}

interface SaleRow {
  id: string
  currency: string
  net_proceeds_minor: number
  net_proceeds_nok_minor: number
  realized_result_nok_minor: number | null
}

async function callCreatePurchase(client: TestClient, args: Record<string, unknown>) {
  return client.rpc('create_purchase', args).single<PurchaseRow>()
}

async function linesFor(purchaseId: string): Promise<PurchaseLineRow[]> {
  const { data, error } = await service
    .from('purchase_lines')
    .select('id, attributable_cost_minor, attributable_cost_nok_minor')
    .eq('purchase_id', purchaseId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data
}

async function callCreateSale(client: TestClient, args: Record<string, unknown>) {
  return client
    .rpc('create_sale', { p_idempotency_key: crypto.randomUUID(), ...args })
    .single<SaleRow>()
}

interface LotRow {
  id: string
  quantity_remaining: number
}

/** One card purchase line, quantity 1, in the given currency. Returns the lot it produced. */
async function acquireLot(args: {
  unitPriceMinor: number
  currency?: string
  fxRateToNok?: string
}): Promise<LotRow> {
  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: args.currency ?? 'NOK',
      p_fx_rate_to_nok: args.fxRateToNok,
      p_fx_rate_date: args.fxRateToNok ? today : undefined,
      p_fx_source: args.fxRateToNok ? 'manual' : undefined,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.grassEnergyVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: args.unitPriceMinor,
        },
      ],
    })
    .single<PurchaseRow>()
  if (error) throw new Error(error.message)
  const { data: line, error: lineError } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  if (lineError) throw new Error(lineError.message)
  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select('id, quantity_remaining')
    .eq('purchase_line_id', line.id)
    .single()
  if (lotError) throw new Error(lotError.message)
  return lot
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 1. The canonical helper in isolation (raw SQL — no RPC/auth overhead needed)
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!rawSqlAvailable())('money_minor_to_nok_minor — currency exponent matrix', () => {
  it('NOK/EUR/USD/GBP (exponent 2, same as NOK): identical to the pre-P133 formula', async () => {
    const result = await runRawSqlAsync(`
      select 'NOK', public.money_minor_to_nok_minor(69900, 'NOK', 1)
      union all select 'EUR', public.money_minor_to_nok_minor(4950, 'EUR', 11.54)
      union all select 'USD', public.money_minor_to_nok_minor(10000, 'USD', 10.50)
      union all select 'GBP', public.money_minor_to_nok_minor(2500, 'GBP', 13.20);
    `)
    expect(result.code).toBe(0)
    expect(result.output.trim().split('\n')).toEqual([
      'NOK|69900',
      'EUR|57123', // matches FINANCIAL_MODEL.md §8 E10 exactly
      'USD|105000',
      'GBP|33000',
    ])
  })

  it('JPY (exponent 0): the P130-02 case — 10000 JPY @ 0.060375 NOK/JPY = 60375 øre, not 604', async () => {
    const result = await runRawSqlAsync(
      `select public.money_minor_to_nok_minor(10000, 'JPY', 0.060375);`,
    )
    expect(result.code).toBe(0)
    expect(result.output.trim()).toBe('60375')
  })

  it('JPY: 1 yen, 100 yen, odd values', async () => {
    const result = await runRawSqlAsync(`
      select public.money_minor_to_nok_minor(1, 'JPY', 0.06)
      union all select public.money_minor_to_nok_minor(100, 'JPY', 0.06)
      union all select public.money_minor_to_nok_minor(333, 'JPY', 0.0612345);
    `)
    expect(result.code).toBe(0)
    // 1 * 0.06 * 100 = 6; 100 * 0.06 * 100 = 600; 333 * 0.0612345 * 100 = 2039.0...  -> round
    expect(result.output.trim().split('\n')).toEqual(['6', '600', '2039'])
  })

  it('JPY: fractional-NOK rounding boundary — half-away-from-zero, both signs', async () => {
    // 1 JPY * 0.005 NOK/JPY * 100 = 0.5 exactly -> rounds away from zero, not to even.
    const result = await runRawSqlAsync(`
      select public.money_minor_to_nok_minor(1, 'JPY', 0.005)
      union all select public.money_minor_to_nok_minor(-1, 'JPY', 0.005);
    `)
    expect(result.code).toBe(0)
    expect(result.output.trim().split('\n')).toEqual(['1', '-1'])
  })

  it('JPY: a large but valid amount stays exact', async () => {
    // 92 trillion yen at a plausible rate — nowhere near bigint overflow even after the ×100 shift.
    const result = await runRawSqlAsync(
      `select public.money_minor_to_nok_minor(92000000000000, 'JPY', 0.07);`,
    )
    expect(result.code).toBe(0)
    // 92e12 * 0.07 * 100 = 644e12 exactly, no rounding needed
    expect(result.output.trim()).toBe('644000000000000')
  })

  it('negative amounts (a loss sale) round the same way as positive ones', async () => {
    const result = await runRawSqlAsync(`
      select public.money_minor_to_nok_minor(-2000, 'NOK', 1)
      union all select public.money_minor_to_nok_minor(-10000, 'JPY', 0.060375);
    `)
    expect(result.code).toBe(0)
    expect(result.output.trim().split('\n')).toEqual(['-2000', '-60375'])
  })

  it('zero amount converts to exact zero, not null', async () => {
    const result = await runRawSqlAsync(`select public.money_minor_to_nok_minor(0, 'JPY', 0.06);`)
    expect(result.code).toBe(0)
    expect(result.output.trim()).toBe('0')
  })

  it('NULL amount, currency or rate propagates NULL — never a fake zero (M1)', async () => {
    const result = await runRawSqlAsync(`
      select coalesce(public.money_minor_to_nok_minor(NULL, 'JPY', 0.06)::text, 'NULL')
      union all select coalesce(public.money_minor_to_nok_minor(100, NULL, 0.06)::text, 'NULL')
      union all select coalesce(public.money_minor_to_nok_minor(100, 'JPY', NULL)::text, 'NULL');
    `)
    expect(result.code).toBe(0)
    expect(result.output.trim().split('\n')).toEqual(['NULL', 'NULL', 'NULL'])
  })

  it('an unsupported currency fails closed with a clear error, not a wrong number', async () => {
    const result = await runRawSqlAsync(`select public.money_minor_to_nok_minor(1000, 'XXX', 1.0);`)
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/unsupported currency code: XXX/)
  })

  it('overflow fails closed (bigint range), the same way the pre-P133 formula already did', async () => {
    const result = await runRawSqlAsync(
      `select public.money_minor_to_nok_minor(9223372036854775807, 'JPY', 1);`,
    )
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/out of range|overflow/i)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Property test: SQL parity with the independent client-side reference (src/domain/fx.ts)
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!rawSqlAvailable())(
  'money_minor_to_nok_minor — parity with src/domain/fx.ts convert()',
  () => {
    it('matches convert() exactly for thousands of generated (currency, amount, rate) triples', async () => {
      const currencyArb: fc.Arbitrary<CurrencyCode> = fc.oneof(
        { weight: 4, arbitrary: fc.constant<CurrencyCode>('JPY') }, // heavy on the currency that was wrong
        { weight: 1, arbitrary: fc.constant<CurrencyCode>('NOK') },
        { weight: 1, arbitrary: fc.constant<CurrencyCode>('EUR') },
        { weight: 1, arbitrary: fc.constant<CurrencyCode>('USD') },
        { weight: 1, arbitrary: fc.constant<CurrencyCode>('GBP') },
      )
      // Amounts up to ±1e11 minor units and rates up to 1000.00000000 keep every product safely
      // inside bigint range even in the worst case (JPY's ×100 shift, both bounds maxed at once:
      // 1e11 * 1000 * 100 = 1e16, two orders of magnitude under bigint's ~9.22e18 ceiling) — large
      // enough to actually exercise the bigint-relevant domain (P130's own warning: never omit it by
      // generating only small values) while staying clear of the DEDICATED overflow test above.
      const amountArb = fc.bigInt({ min: -100_000_000_000n, max: 100_000_000_000n })
      const rateScaledArb = fc.bigInt({ min: 1n, max: 100_000_000_000n }) // scaled by 1e8: up to 1000.0
      // A cluster of generated values pinned exactly at the *.5 rounding boundary, so the property
      // isn't only exercising "generic" values (P130's warning about generators missing edge cases).
      const boundaryAmountArb = fc.constantFrom(1n, -1n, 3n, -3n, 7n, -7n, 11n, -11n)
      const boundaryRateArb = fc.constantFrom(5000000n, 15000000n, 25000000n) // 0.05 / 0.15 / 0.25

      const cases: { amount: bigint; currency: CurrencyCode; rateScaled: bigint }[] = []
      for (const sample of fc.sample(
        fc.record({ amount: amountArb, currency: currencyArb, rateScaled: rateScaledArb }),
        { numRuns: 2000, seed: 133133 },
      )) {
        cases.push(sample)
      }
      for (const sample of fc.sample(
        fc.record({
          amount: boundaryAmountArb,
          currency: fc.constant<CurrencyCode>('JPY'),
          rateScaled: boundaryRateArb,
        }),
        { numRuns: 50, seed: 133134 },
      )) {
        cases.push(sample)
      }

      function formatRate(scaled: bigint): string {
        const whole = scaled / 100_000_000n
        const frac = (scaled % 100_000_000n).toString().padStart(8, '0')
        return `${whole.toString()}.${frac}`
      }

      const rows = cases.map(({ amount, currency, rateScaled }) => {
        const rateStr = formatRate(rateScaled)
        const reference = convert(fromMinorUnits(amount, currency), rateStr, 'NOK').minorUnits
        return `(${amount.toString()}, '${currency}', ${rateStr}, ${reference.toString()})`
      })

      // One round trip: every row's SQL result must equal its independently-computed reference.
      const sql = `
      select count(*) from (
        values ${rows.join(',\n               ')}
      ) as t(amount_minor, currency, rate, expected)
      where public.money_minor_to_nok_minor(amount_minor, currency, rate) is distinct from expected;
    `
      const result = await runRawSqlAsync(sql)
      expect(result.code).toBe(0)
      expect(result.output.trim()).toBe('0')
    })
  },
)

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 3. End-to-end RPC coverage — proves the wiring, not just the helper
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('create_purchase — JPY end-to-end', () => {
  it('1 JPY, 100 JPY, and a receipt total all convert exponent-aware', async () => {
    const { data: purchase, error } = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.06037500',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        { line_type: 'accessory', description: 'Sleeves', quantity: 1, unit_price_minor: 1 },
        { line_type: 'accessory', description: 'Playmat', quantity: 1, unit_price_minor: 9999 },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.total_minor).toBe(10000)
    // round(10000 * 0.060375 * 100) = 60375 — the exact P130-02 worked example (E10b).
    expect(purchase?.total_nok_minor).toBe(60375)

    const lines = await linesFor(purchase!.id)
    const sumNok = lines.reduce((s, l) => s + l.attributable_cost_nok_minor, 0)
    expect(sumNok).toBe(purchase!.total_nok_minor) // F6: parts still sum exactly to the whole
  })

  it('a card line (the path that also writes an acquisition lot) gets the same corrected basis', async () => {
    const lot = await acquireLot({ unitPriceMinor: 5000, currency: 'JPY', fxRateToNok: '0.06' })
    const { data: lotRow, error } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_nok_minor')
      .eq('id', lot.id)
      .single()
    expect(error).toBeNull()
    // 5000 JPY * 0.06 * 100 = 30000 øre (300.00 NOK), not 300 øre (3.00 NOK).
    expect(lotRow?.unit_cost_basis_nok_minor).toBe(30000)
  })
})

describe('update_purchase — JPY correction path', () => {
  it('recomputes the exponent-aware NOK total when the rate is corrected', async () => {
    const { data: purchase } = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.06000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        { line_type: 'accessory', description: 'Playmat', quantity: 1, unit_price_minor: 2000 },
      ],
    })
    const [line] = await linesFor(purchase!.id)
    expect(purchase?.total_nok_minor).toBe(12000) // 2000 * 0.06 * 100

    const { data: updated, error } = await clientA
      .rpc('update_purchase', {
        p_purchase_id: purchase!.id,
        p_purchased_on: today,
        p_currency: 'JPY',
        p_fx_rate_to_nok: '0.06037500',
        p_fx_rate_date: today,
        p_fx_source: 'manual',
        p_lines: [{ line_id: line!.id, quantity: 1, unit_price_minor: 2000 }],
      })
      .single<PurchaseRow>()
    expect(error).toBeNull()
    // 2000 * 0.060375 * 100 = 12075
    expect(updated?.total_nok_minor).toBe(12075)
  })
})

describe('create_sale — JPY end-to-end', () => {
  it('proceeds convert exponent-aware, including a genuine JPY loss sale', async () => {
    const lot = await acquireLot({ unitPriceMinor: 100000 }) // 1000.00 NOK cost basis
    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.06037500',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 10000 }],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_minor).toBe(10000)
    // round(10000 * 0.060375 * 100) = 60375 (603.75 NOK) < 1000.00 NOK cost basis -> a real loss.
    expect(sale?.net_proceeds_nok_minor).toBe(60375)
    expect(sale?.realized_result_nok_minor).toBe(60375 - 100000)
  })

  it('fees exceeding gross produce a negative JPY-sourced net proceeds, converted the same way', async () => {
    const lot = await acquireLot({ unitPriceMinor: 5000 })
    const { data: sale, error } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.06',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_fees_minor: 500,
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 300 }],
    })
    expect(error).toBeNull()
    expect(sale?.net_proceeds_minor).toBe(-200) // 300 - 500
    // round(-200 * 0.06 * 100) = -1200 (-12.00 NOK)
    expect(sale?.net_proceeds_nok_minor).toBe(-1200)
  })
})

describe('update_sale — JPY correction path', () => {
  it('recomputes exponent-aware proceeds when the rate is corrected, without touching lot_id/quantity', async () => {
    const lot = await acquireLot({ unitPriceMinor: 5000 })
    const { data: sale } = await callCreateSale(clientA, {
      p_sold_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.06000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 10000 }],
    })
    const { data: saleLine, error: lineError } = await service
      .from('sale_lines')
      .select('id')
      .eq('sale_id', sale!.id)
      .single()
    expect(lineError).toBeNull()
    expect(sale?.net_proceeds_nok_minor).toBe(60000) // 10000 * 0.06 * 100

    const { data: updated, error } = await clientA
      .rpc('update_sale', {
        p_sale_id: sale!.id,
        p_sold_on: today,
        p_currency: 'JPY',
        p_fx_rate_to_nok: '0.06037500',
        p_fx_rate_date: today,
        p_fx_source: 'manual',
        p_lines: [{ line_id: saleLine?.id, unit_gross_minor: 10000 }],
      })
      .single<SaleRow>()
    expect(error).toBeNull()
    expect(updated?.net_proceeds_nok_minor).toBe(60375) // 10000 * 0.060375 * 100
  })
})

describe('standard currencies (NOK/EUR/USD/GBP) — no regression from P133', () => {
  it('reproduces FINANCIAL_MODEL.md §8 E10 exactly through create_purchase', async () => {
    const { data: purchase, error } = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'EUR',
      p_shipping_minor: 450,
      p_fx_rate_to_nok: '11.54000000',
      p_fx_rate_date: today,
      p_fx_source: 'norges_bank',
      p_lines: [
        {
          line_type: 'accessory',
          description: 'German seller card',
          quantity: 1,
          unit_price_minor: 4500,
        },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.total_minor).toBe(4950)
    expect(purchase?.total_nok_minor).toBe(57123) // round(4950 * 11.54) — unchanged by P133
  })

  it('USD and GBP purchases convert exactly as they did before P133 (exponent shift is zero)', async () => {
    const usd = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'USD',
      p_fx_rate_to_nok: '10.50000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        {
          line_type: 'accessory',
          description: 'Booster box',
          quantity: 1,
          unit_price_minor: 10000,
        },
      ],
    })
    expect(usd.error).toBeNull()
    expect(usd.data?.total_nok_minor).toBe(105000)

    const gbp = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'GBP',
      p_fx_rate_to_nok: '13.20000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        { line_type: 'accessory', description: 'Binder', quantity: 1, unit_price_minor: 2500 },
      ],
    })
    expect(gbp.error).toBeNull()
    expect(gbp.data?.total_nok_minor).toBe(33000)
  })

  it('a plain NOK purchase is untouched (v_fx_rate hardcoded 1, shift is zero)', async () => {
    const { data: purchase, error } = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'accessory', description: 'Deck box', quantity: 1, unit_price_minor: 12345 },
      ],
    })
    expect(error).toBeNull()
    expect(purchase?.total_nok_minor).toBe(12345)
  })
})

describe('an unsupported currency fails closed through the RPC, not just the raw helper', () => {
  it('create_purchase refuses currency XXX with a clear error instead of a silently-wrong total', async () => {
    const { error } = await callCreatePurchase(clientA, {
      p_purchased_on: today,
      p_currency: 'XXX',
      p_fx_rate_to_nok: '1.00000000',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        {
          line_type: 'accessory',
          description: 'Unknown-currency item',
          quantity: 1,
          unit_price_minor: 100,
        },
      ],
    })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/unsupported currency code: XXX/)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 4. The CHECK constraints enforce this too, independent of the RPCs going through them
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!rawSqlAvailable())(
  'purchases_total_nok_matches_rate — enforces the exponent-aware formula directly',
  () => {
    it('rejects a JPY row whose total_nok_minor was computed with the pre-P133 (exponent-2) formula', async () => {
      // 10000 JPY at 0.060375: the OLD formula gives 604 (what this insert supplies); the constraint
      // now requires 60375 and must reject the row outright, independent of any RPC.
      const sql = `
      insert into public.purchases (
        user_id, purchased_on, currency, subtotal_minor, total_minor, fx_rate_to_nok, fx_rate_date, total_nok_minor
      ) values (
        '${userA.id}', '${today}', 'JPY', 10000, 10000, 0.060375, '${today}', 604
      );
    `
      const result = await runRawSqlAsync(sql)
      expect(result.code).not.toBe(0)
      expect(result.output).toMatch(/purchases_total_nok_matches_rate/)
    })

    it('accepts the same row with the correct exponent-aware total', async () => {
      const sql = `
      insert into public.purchases (
        user_id, purchased_on, currency, subtotal_minor, total_minor, fx_rate_to_nok, fx_rate_date, total_nok_minor
      ) values (
        '${userA.id}', '${today}', 'JPY', 10000, 10000, 0.060375, '${today}', 60375
      ) returning total_nok_minor;
    `
      const result = await runRawSqlAsync(sql)
      expect(result.code).toBe(0)
      expect(result.output).toMatch(/^60375/)
    })
  },
)
