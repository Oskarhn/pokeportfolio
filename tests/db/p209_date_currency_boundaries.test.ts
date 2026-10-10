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
import { rebuildSnapshots } from './lib/rebuild-snapshots'

/**
 * P209 (D): date and currency boundaries. Each case is one of
 *   BUG      a defect fixed in this change (the test fails before it);
 *   POLICY   behaviour that is accepted today and is an open product question - pinned so a change
 *            is a decision, not an accident (docs/DECISIONS.md D-212 lists the questions);
 *   FACT     a boundary that already holds and is now asserted.
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient

const now = new Date()
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return iso(d)
}
const today = iso(now)
const firstOfMonth = (date: string) => `${date.slice(0, 7)}-01`
const lastOfPreviousMonth = (date: string) => addDays(firstOfMonth(date), -1)

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p209-boundaries')
  client = await signInAs(user)
})
afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function buy(
  date: string,
  opts: { currency?: string; unit: number; quantity?: number; fx?: string },
) {
  const args: Record<string, unknown> = {
    p_purchased_on: date,
    p_currency: opts.currency ?? 'NOK',
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: opts.quantity ?? 1,
        unit_price_minor: opts.unit,
      },
    ],
  }
  if (opts.fx) {
    args.p_fx_rate_to_nok = opts.fx
    args.p_fx_rate_date = date
    args.p_fx_source = 'manual'
  }
  const r = await client.rpc('create_purchase', args).single<{ id: string }>()
  if (r.error) throw new Error(r.error.message)
  return r.data.id
}

async function lotOfPurchase(purchaseId: string) {
  const pl = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchaseId)
    .single<{ id: string }>()
  const lot = await service
    .from('acquisition_lots')
    .select('id, holding_id, unit_cost_basis_nok_minor, residual_nok_minor, quantity')
    .eq('purchase_line_id', pl.data!.id)
    .single<{
      id: string
      holding_id: string
      unit_cost_basis_nok_minor: number
      residual_nok_minor: number
      quantity: number
    }>()
  return lot.data!
}

describe('D-212 monthly spend follows the owner calendar', () => {
  it('FACT: the default and an explicit database date give the same window and the same bars', async () => {
    await buy(today, { unit: 1000 })
    const a = await client.rpc('get_monthly_spend', { p_months: 6 })
    const b = await client.rpc('get_monthly_spend', { p_months: 6, p_as_of: today })
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect(b.data).toEqual(a.data)
    expect((a.data as unknown[]).length).toBe(6)
  })

  it('FACT: purchases on the last day and the first day of a month land in their own bars, and the bars sum to spend', async () => {
    const lastPrev = lastOfPreviousMonth(today)
    const firstThis = firstOfMonth(today)
    await buy(lastPrev, { unit: 2000 })
    if (firstThis <= addDays(today, 1)) await buy(firstThis, { unit: 3000 })
    const r = await client.rpc('get_monthly_spend', { p_months: 3 })
    expect(r.error).toBeNull()
    const bars = r.data as { month: string; total_nok_minor: string }[]
    const byMonth = new Map(bars.map((b) => [b.month, BigInt(b.total_nok_minor)]))
    expect(byMonth.get(firstOfMonth(lastPrev))).toBeGreaterThanOrEqual(2000n)
    expect(byMonth.get(firstThis)).toBeGreaterThanOrEqual(1000n)
    const dash = await client.rpc('get_dashboard_summary').single<{ gpo_nok_minor: string }>()
    const total = bars.reduce((s, b) => s + BigInt(b.total_nok_minor), 0n)
    expect(total).toBe(BigInt(dash.data!.gpo_nok_minor)) // every purchase here is inside the 3 bars
  })

  it('BUG: a local date a day ahead of the database date opens the next month, so a purchase dated the 1st is in a bar', async () => {
    const tomorrow = addDays(today, 1)
    if (tomorrow.slice(0, 7) === today.slice(0, 7)) {
      // Not a month boundary in UTC today: the next month cannot be reached within the +/- 1 day the
      // function accepts. The window logic is still exercised by the cases above and below.
      const refused = await client.rpc('get_monthly_spend', {
        p_months: 3,
        p_as_of: addDays(today, 3),
      })
      expect(refused.error?.code).toBe('22023')
      return
    }
    const u = await createSyntheticUser(service, 'p209-rollover')
    const c = await signInAs(u)
    try {
      const p = await c.rpc('create_purchase', {
        p_purchased_on: tomorrow, // the 1st, valid under the P144 contract (UTC today + 1)
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 4200,
          },
        ],
      })
      expect(p.error).toBeNull()
      const withoutAsOf = await c.rpc('get_monthly_spend', { p_months: 2 })
      const bars = (withoutAsOf.data as { month: string; total_nok_minor: string }[]).map(
        (b) => b.month,
      )
      expect(bars).not.toContain(firstOfMonth(tomorrow)) // the old behaviour: the purchase is in no bar
      const local = await c.rpc('get_monthly_spend', { p_months: 2, p_as_of: tomorrow })
      const row = (local.data as { month: string; total_nok_minor: string }[]).find(
        (b) => b.month === firstOfMonth(tomorrow),
      )
      expect(row?.total_nok_minor).toBe('4200')
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('FACT: a date more than a day from the database date is refused, never reinterpreted', async () => {
    for (const bad of [addDays(today, 2), addDays(today, -2)]) {
      const r = await client.rpc('get_monthly_spend', { p_months: 3, p_as_of: bad })
      expect(r.error?.code).toBe('22023')
    }
  })
})

describe('D-212 sales_summary reconciles to NSP', () => {
  it('BUG: gross - fees - outbound shipping + buyer shipping equals NSP when every component rounds on its own', async () => {
    const u = await createSyntheticUser(service, 'p209-nsp')
    const c = await signInAs(u)
    try {
      const p = await c
        .rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity: 1,
              unit_price_minor: 100,
            },
          ],
        })
        .single<{ id: string }>()
      expect(p.error).toBeNull()
      const pl = await service
        .from('purchase_lines')
        .select('id')
        .eq('purchase_id', p.data!.id)
        .single()
      const lot = await service
        .from('acquisition_lots')
        .select('id')
        .eq('purchase_line_id', (pl.data as { id: string }).id)
        .single<{ id: string }>()
      // 3 gross, 1 fee, 1 shipping in EUR at 0.5 NOK: each component is x.5 and rounds up on its own.
      const sale = await c.rpc('create_sale', {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: today,
        p_currency: 'EUR',
        p_fx_rate_to_nok: '0.50000000',
        p_fx_rate_date: today,
        p_fx_source: 'manual',
        p_fees_minor: 1,
        p_shipping_cost_minor: 1,
        p_lines: [{ lot_id: lot.data!.id, quantity: 1, unit_gross_minor: 3 }],
      })
      expect(sale.error).toBeNull()
      const s = await c.rpc('sales_summary').single<{
        gross_nok_minor: string
        fees_nok_minor: string
        outbound_shipping_nok_minor: string
        buyer_shipping_nok_minor: string
        nsp_nok_minor: string
      }>()
      expect(s.error).toBeNull()
      const d = s.data!
      const identity =
        BigInt(d.gross_nok_minor) -
        BigInt(d.fees_nok_minor) -
        BigInt(d.outbound_shipping_nok_minor) +
        BigInt(d.buyer_shipping_nok_minor)
      expect(identity).toBe(BigInt(d.nsp_nok_minor))
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})

describe('JPY and the frozen NOK cost', () => {
  it('FACT: a JPY purchase freezes exact NOK minor units (exponent 0) and later rate changes never move it', async () => {
    // 12345 JPY x 3 at 0.07123456 NOK/JPY: 37035 JPY = 2638.1 NOK -> 263810 ore after rounding.
    const rate = '0.07123456'
    const date = addDays(today, -1)
    const id = await buy(date, { currency: 'JPY', unit: 12345, quantity: 3, fx: rate })
    const lot = await lotOfPurchase(id)
    const total =
      BigInt(lot.quantity) * BigInt(lot.unit_cost_basis_nok_minor) + BigInt(lot.residual_nok_minor)
    const exact = (37035n * 7123456n * 100n + 50_000_000n) / 100_000_000n // round half up, 8 fraction digits
    expect(total).toBe(exact)

    // an FX table row for the same day, inserted later, changes nothing that is frozen
    const fxDate = addDays(today, -400)
    const ins = await service.from('fx_rates').insert({
      base_currency: 'JPY',
      quote_currency: 'NOK',
      rate_date: fxDate,
      rate: '0.09000000',
      source: 'norges_bank',
    })
    expect(ins.error).toBeNull()
    try {
      const again = await lotOfPurchase(id)
      expect(again.unit_cost_basis_nok_minor).toBe(lot.unit_cost_basis_nok_minor)
      expect(again.residual_nok_minor).toBe(lot.residual_nok_minor)
    } finally {
      await service
        .from('fx_rates')
        .delete()
        .eq('base_currency', 'JPY')
        .eq('rate_date', fxDate)
        .eq('source', 'norges_bank')
    }
  })
})

describe('POLICY pins (open product questions, D-212)', () => {
  it('P1: a sale dated before the lot was acquired is accepted today', async () => {
    const id = await buy(today, { unit: 500 })
    const lot = await lotOfPurchase(id)
    const sale = await client.rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: addDays(today, -10),
      p_currency: 'NOK',
      p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 900 }],
    })
    // If this starts failing the rule was introduced: update D-212 and FINANCIAL_MODEL, then this pin.
    expect(sale.error).toBeNull()
  })

  it('P2: a manual valuation dated in the future is the current value today, and history ignores it before its date', async () => {
    const u = await createSyntheticUser(service, 'p209-future-valuation')
    const c = await signInAs(u)
    try {
      const p = await c
        .rpc('create_purchase', {
          p_purchased_on: addDays(today, -5),
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity: 1,
              unit_price_minor: 800,
            },
          ],
        })
        .single<{ id: string }>()
      expect(p.error).toBeNull()
      const lot = await service
        .from('acquisition_lots')
        .select('holding_id')
        .eq('user_id', u.id)
        .single<{ holding_id: string }>()
      const set = await c.rpc('set_manual_valuation', {
        p_holding_id: lot.data!.holding_id,
        p_value_minor: 77700,
        p_effective_from: addDays(today, 20),
      })
      expect(set.error).toBeNull()
      const prov = await c.rpc('get_holding_value_provenance', {
        p_holding_id: lot.data!.holding_id,
      })
      const row = (prov.data as { price_state: string; unit_value_nok_minor: string }[])[0]!
      expect(row.price_state).toBe('manual')
      expect(row.unit_value_nok_minor).toBe('77700') // current although it takes effect in 20 days
      const rb = await rebuildSnapshots(service, u.id, addDays(today, -5), today)
      expect(rb.error).toBeNull()
      const hist = await service
        .from('portfolio_snapshots')
        .select('market_value_nok_minor::text')
        .eq('user_id', u.id)
        .eq('snapshot_date', today)
        .single<{ market_value_nok_minor: string }>()
      // History does not use the valuation before its own date (it falls through to the provider
      // price, or to nothing): live and history disagree on the figure until that date.
      expect(hist.data!.market_value_nok_minor).not.toBe('77700')
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})
