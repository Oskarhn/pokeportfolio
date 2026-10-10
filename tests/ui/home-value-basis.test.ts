import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { valueBasisLines, type ValueBasisInput } from '../../src/domain/dashboard'
import { summaryFromRow, type SummaryRow } from '../../src/data/dashboard'

// home-sections imports the data layer, which imports the real Supabase client; rendering needs none.
vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))
const { DataQualityRow } = await import('../../src/features/home/home-sections')

/**
 * D-211 / FINANCIAL_MODEL.md E9: Home says what the live value is based on, in text, and keeps
 * missing, stale and zero apart. The wire row -> typed summary -> rendered text path is covered
 * end to end here; the RPC itself is covered by tests/db/p209_dashboard_price_disclosure.test.ts.
 */

const base: ValueBasisInput = {
  priced: 0,
  unpriced: 0,
  unpricedManualOnly: 0,
  manualValued: 0,
  autoPriced: 0,
  stalePriced: 0,
  oldestPriceDate: null,
  zeroValued: 0,
  uncostedLots: 0,
}

describe('valueBasisLines', () => {
  it('a fully fresh, fully priced portfolio makes no staleness or zero claim', () => {
    const lines = valueBasisLines({ ...base, priced: 12, autoPriced: 12 })
    expect(lines).toEqual(['12 priced', '12 automatic'])
  })

  it('stale prices are counted and dated; the date is the oldest observation', () => {
    const lines = valueBasisLines({
      ...base,
      priced: 5,
      autoPriced: 5,
      stalePriced: 2,
      oldestPriceDate: '2026-09-12',
    })
    const stale = lines.find((l) => l.includes('older than 3 days'))
    expect(stale).toMatch(/^2 priced from an observation older than 3 days — oldest observation /)
    expect(stale).toMatch(/12\.? sep/i)
  })

  it('a missing price is never described as a value, and manual-only holdings say what they need', () => {
    const lines = valueBasisLines({
      ...base,
      priced: 1,
      autoPriced: 1,
      unpriced: 3,
      unpricedManualOnly: 2,
    })
    expect(lines[0]).toBe('1 priced · 3 without a price')
    expect(lines.join('\n')).toMatch(/2 need a manual value/)
    expect(lines.join('\n')).not.toMatch(/0 kr/)
  })

  it('a recorded zero is stated as a value, apart from "without a price"', () => {
    const lines = valueBasisLines({ ...base, priced: 2, manualValued: 2, zeroValued: 1 })
    expect(lines).toContain('1 valued at 0 kr (a recorded value, not a missing price)')
    expect(lines[0]).toBe('2 priced')
  })

  it('an account with nothing priced says so and nothing else about prices', () => {
    const lines = valueBasisLines({ ...base, unpriced: 4 })
    expect(lines).toEqual(['0 priced · 4 without a price'])
  })
})

describe('RPC row -> summary -> rendered text', () => {
  const row: SummaryRow = {
    pending_recompute: false,
    latest_snapshot_date: '2026-10-09',
    first_tracked_date: '2026-09-01',
    market_value_nok_minor: '1234500',
    market_value_has_coverage: true,
    attributed_value_nok_minor: '1234500',
    cost_basis_nok_minor: '1000000',
    unrealized_result_nok_minor: '234500',
    collectible_spend_to_date_nok_minor: '1000000',
    sales_proceeds_to_date_nok_minor: '0',
    ttep_nok_minor: '234500',
    snapshot_open_lot_count: '9',
    snapshot_unvalued_lot_count: '2',
    physical_card_count: '9',
    unique_holding_count: '9',
    graded_holding_count: '1',
    sealed_holding_count: '1',
    sealed_unit_count: '1',
    manual_entry_count: '0',
    priced_holding_count: '6',
    unpriced_holding_count: '3',
    manual_valued_holding_count: '1',
    auto_priced_holding_count: '5',
    raw_value_nok_minor: '1234500',
    graded_value_nok_minor: '0',
    sealed_value_nok_minor: '0',
    uncosted_open_lot_count: '1',
    gpo_nok_minor: '1000000',
    cs_nok_minor: '1000000',
    hs_nok_minor: '0',
    nsp_nok_minor: '0',
    rrc_nok_minor: '0',
    pud_nok_minor: '0',
    ncco_nok_minor: '1000000',
    thco_nok_minor: '1000000',
    thp_nok_minor: '234500',
    stale_priced_holding_count: '2',
    oldest_price_date: '2026-09-20',
    zero_valued_holding_count: '1',
    unpriced_manual_only_holding_count: '2',
  }

  it('the four disclosure columns survive the mapping as numbers and a date, never as 0 for null', () => {
    const s = summaryFromRow(row)
    expect(s.stalePricedHoldingCount).toBe(2)
    expect(s.oldestPriceDate).toBe('2026-09-20')
    expect(s.zeroValuedHoldingCount).toBe(1)
    expect(s.unpricedManualOnlyHoldingCount).toBe(2)
    expect(summaryFromRow({ ...row, oldest_price_date: null }).oldestPriceDate).toBeNull()
  })

  it('the rendered Home block carries the disclosure as text with an accessible name', () => {
    const s = summaryFromRow(row)
    const html = renderToStaticMarkup(
      createElement(DataQualityRow, {
        priced: s.pricedHoldingCount,
        unpriced: s.unpricedHoldingCount,
        unpricedManualOnly: s.unpricedManualOnlyHoldingCount,
        manualValued: s.manualValuedHoldingCount,
        autoPriced: s.autoPricedHoldingCount,
        stalePriced: s.stalePricedHoldingCount,
        oldestPriceDate: s.oldestPriceDate,
        zeroValued: s.zeroValuedHoldingCount,
        uncostedLots: s.uncostedOpenLotCount,
      }),
    )
    expect(html).toContain('aria-label="What the current value is based on"')
    expect(html).toContain('6 priced · 3 without a price')
    expect(html).toContain('2 need a manual value')
    expect(html).toContain('2 priced from an observation older than 3 days')
    expect(html).toContain('1 valued at 0 kr')
    expect(html).toContain('1 lots without a recorded cost')
  })
})
