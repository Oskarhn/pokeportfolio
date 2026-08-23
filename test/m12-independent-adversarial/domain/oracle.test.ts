import { describe, expect, it } from 'vitest'
import {
  convertMinorToNok,
  daysBetween,
  expectedSnapshotAt,
  firstTrackedDate,
  isOpenAt,
  manualValueAt,
  resolvedUnitValueNok,
  type OracleFacts,
} from '../helpers/oracle'

/**
 * Self-tests for the INDEPENDENT oracle itself (helpers/oracle.ts), runnable against current
 * main with no database: the oracle is pure TypeScript over canonical fact rows.
 *
 * These encode FINANCIAL_MODEL.md section 3 (ownership timeline) and section 6 (market value
 * resolution) directly, including every adversarial reading the M12 implementation will be
 * judged against: no look-ahead, historical freshness measured from D, genuine zero vs missing,
 * F10, sealed manual-only, and the reconstructable manual-valuation interval model.
 */

function emptyFacts(overrides: Partial<OracleFacts> = {}): OracleFacts {
  return {
    euPricing: true,
    holdings: new Map(),
    lots: [],
    disposalsByLot: new Map(),
    collectibleSpendEvents: [],
    proceedsEvents: [],
    manualByHolding: new Map(),
    pricesByVariant: new Map(),
    fxByCurrency: new Map(),
    ...overrides,
  }
}

function rawLotFacts(opts: {
  acquiredOn: string
  variantId?: string | null
  kind?: string
  quantity?: number
}): { facts: OracleFacts; holdingId: string; lotIndex: number } {
  const holdingId = 'h1'
  const lotIndex = 0
  const facts = emptyFacts({
    holdings: new Map([
      [holdingId, { kind: opts.kind ?? 'raw_card', variantId: opts.variantId ?? 'v1' }],
    ]),
    lots: [
      {
        id: 'l1',
        holdingId,
        acquiredOn: opts.acquiredOn,
        quantity: opts.quantity ?? 1,
        unitCostBasisNokMinor: null,
        costBasisState: 'not_paid',
        voidedAt: null,
      },
    ],
  })
  return { facts, holdingId, lotIndex }
}

describe('ownership timeline (FINANCIAL_MODEL ownership rules)', () => {
  it('scenario A: a lot acquired day 30 is not open on days 1-29 even when a price exists', () => {
    const { facts, lotIndex } = rawLotFacts({ acquiredOn: '2026-01-30' })
    for (const d of ['2026-01-01', '2026-01-15', '2026-01-29']) {
      expect(isOpenAt(facts, lotIndex, d)).toBe(false)
    }
    expect(isOpenAt(facts, lotIndex, '2026-01-30')).toBe(true)
  })

  it('scenario B: a sale on day 100 zeroes contribution from day 100 onward; earlier days unchanged', () => {
    const { facts, lotIndex } = rawLotFacts({ acquiredOn: '2026-01-30' })
    facts.disposalsByLot.set('l1', [{ disposedOn: '2026-04-09', quantity: 1, voidedAt: null }])
    expect(isOpenAt(facts, lotIndex, '2026-04-08')).toBe(true)
    expect(isOpenAt(facts, lotIndex, '2026-04-09')).toBe(false)
    expect(isOpenAt(facts, lotIndex, '2026-06-01')).toBe(false)
  })

  it('scenario C: acquire and fully sell on the same date leaves the lot closed ON that date (end-of-day semantics)', () => {
    const { facts, lotIndex } = rawLotFacts({ acquiredOn: '2026-02-10' })
    facts.disposalsByLot.set('l1', [{ disposedOn: '2026-02-10', quantity: 1, voidedAt: null }])
    expect(isOpenAt(facts, lotIndex, '2026-02-09')).toBe(false)
    expect(isOpenAt(facts, lotIndex, '2026-02-10')).toBe(false)
  })

  it('a voided disposal restores ownership from its original date onward', () => {
    const { facts, lotIndex } = rawLotFacts({ acquiredOn: '2026-01-30' })
    facts.disposalsByLot.set('l1', [
      { disposedOn: '2026-03-01', quantity: 1, voidedAt: '2026-03-05T00:00:00Z' },
    ])
    expect(isOpenAt(facts, lotIndex, '2026-03-01')).toBe(true)
    expect(isOpenAt(facts, lotIndex, '2026-06-01')).toBe(true)
  })

  it('first tracked date is the earliest own event, never an implied earlier zero', () => {
    const { facts } = rawLotFacts({ acquiredOn: '2026-01-30' })
    facts.collectibleSpendEvents.push({ date: '2026-01-30', amountNokMinor: 500 })
    expect(firstTrackedDate(facts)).toBe('2026-01-30')
  })
})

describe('provider step function and freshness (FINANCIAL_MODEL market-value rules)', () => {
  it('scenario G: an observation dated D+1 is never used to value snapshot D (no look-ahead)', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.pricesByVariant.set('v1', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-01-11',
        currency: 'EUR',
      },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-10')).toBeNull()
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-11')).not.toBeNull()
  })

  it('scenario H: a price 2 days old as of historical D stays fresh for D even if months old today', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2025-12-01' })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-11-01', rate: 1_150_000_000 }])
    facts.pricesByVariant.set('v1', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-01-25',
        currency: 'EUR',
      },
    ])
    // For historical D = 2026-01-27 the observation is 2 days old: fresh at D, forever.
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-27')).toBe(11500)
    // The same observation ages out only for dates far beyond its own date.
    expect(resolvedUnitValueNok(facts, holdingId, '2026-03-01')).toBeNull() // more than 30 days after obs
  })

  it('freshness boundaries: fresh up to 3 days, stale up to 30 days, missing beyond - all relative to D', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.pricesByVariant.set('v1', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-02-01',
        currency: 'EUR',
      },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-02-04')).toBe(1000) // 3 days: fresh
    expect(resolvedUnitValueNok(facts, holdingId, '2026-02-05')).toBe(1000) // 4 days: stale, still used
    expect(resolvedUnitValueNok(facts, holdingId, '2026-03-03')).toBe(1000) // 30 days: last usable
    expect(resolvedUnitValueNok(facts, holdingId, '2026-03-04')).toBeNull() // 31 days: missing
  })

  it('scenario K: a genuine zero observation values the holding at exactly 0, not missing', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.pricesByVariant.set('v1', [
      { provider: 'tcgdex_cardmarket', valueMinor: 0, snapshotDate: '2026-01-05', currency: 'EUR' },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-07')).toBe(0)

    const row = expectedSnapshotAt(facts, '2026-01-07')
    expect(row.market_value_nok_minor).toBe(0)
    expect(row.unvalued_lot_count).toBe(0)
    expect(row.open_lot_count).toBe(1)
  })

  it('scenario K: an unpriced holding is excluded from value and counted as unvalued, never zero-valued', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    const row = expectedSnapshotAt(facts, '2026-01-07')
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-07')).toBeNull()
    expect(row.market_value_nok_minor).toBe(0)
    expect(row.unvalued_lot_count).toBe(1)
    expect(row.open_lot_count).toBe(1)
  })

  it('provider preference follows use_eu_pricing without comparing freshness across providers', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.fxByCurrency.set('USD', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.pricesByVariant.set('v1', [
      // Cardmarket observation is STALE for D (age 10); TCGplayer is fresh (age 1).
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-01-20',
        currency: 'EUR',
      },
      {
        provider: 'tcgdex_tcgplayer',
        valueMinor: 9999,
        snapshotDate: '2026-01-29',
        currency: 'USD',
      },
    ])
    // EU on: stale Cardmarket still beats fresher TCGplayer.
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-30')).toBe(1000)
    facts.euPricing = false
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-30')).toBe(9999)
  })

  it('FX conversion rounds half-up at the minor unit using the observation-date rate', () => {
    expect(convertMinorToNok(4950, 1_154_000_000)).toBe(57123) // E10's exact figure
    expect(convertMinorToNok(1000, 1_155_555_555)).toBe(11556) // .55555... rounds up
    expect(convertMinorToNok(1000, 1_154_444_444)).toBe(11544) // .44444... rounds down
  })

  it('no FX rate for the observation currency means unvalued - never zero', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.pricesByVariant.set('v1', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-01-05',
        currency: 'EUR',
      },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-07')).toBeNull()
  })

  it('FX observed on/before the observation own-date wins, never a later rate', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.fxByCurrency.set('EUR', [
      { rateDate: '2026-01-10', rate: 2_000_000_000 }, // AFTER the observation below - must be ignored
      { rateDate: '2026-01-02', rate: 100_000_000 },
    ])
    facts.pricesByVariant.set('v1', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-01-05',
        currency: 'EUR',
      },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-20')).toBe(1000)
  })
})

describe('F10 and sealed manual-only', () => {
  it('scenario L: a graded holding resolves missing historically even though its printing has a live raw price', () => {
    const { facts, holdingId } = rawLotFacts({ acquiredOn: '2026-01-01', kind: 'graded_card' })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.pricesByVariant.set('v1', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 1000,
        snapshotDate: '2026-01-05',
        currency: 'EUR',
      },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-20')).toBeNull()
    const row = expectedSnapshotAt(facts, '2026-01-20')
    expect(row.unvalued_lot_count).toBe(1)
  })

  it('scenario M: a sealed holding is valued only through its manual valuation', () => {
    const { facts, holdingId } = rawLotFacts({
      acquiredOn: '2026-01-01',
      kind: 'sealed',
      variantId: null,
    })
    facts.manualByHolding.set(holdingId, [
      {
        valueMinor: 25000,
        effectiveFrom: '2026-01-10',
        supersededAt: null,
        createdAt: '2026-01-10T00:00:00Z',
      },
    ])
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-05')).toBeNull()
    expect(resolvedUnitValueNok(facts, holdingId, '2026-01-10')).toBe(25000)
  })
})

describe('manual valuation interval model (LOCK - reconcile against D-062 on divergence)', () => {
  function intervalFacts() {
    const holdingId = 'h1'
    const facts = emptyFacts({
      holdings: new Map([[holdingId, { kind: 'raw_card', variantId: null }]]),
    })
    return { facts, holdingId }
  }

  it('set D1 then change D2: each interval owns its own dates', () => {
    const { facts, holdingId } = intervalFacts()
    facts.manualByHolding.set(holdingId, [
      {
        valueMinor: 111,
        effectiveFrom: '2026-01-10',
        supersededAt: '2026-01-20T00:00:00Z',
        createdAt: '2026-01-10T00:00:00Z',
      },
      {
        valueMinor: 222,
        effectiveFrom: '2026-01-20',
        supersededAt: null,
        createdAt: '2026-01-20T00:00:00Z',
      },
    ])
    expect(manualValueAt(facts, holdingId, '2026-01-09')).toBeNull()
    expect(manualValueAt(facts, holdingId, '2026-01-10')).toBe(111)
    expect(manualValueAt(facts, holdingId, '2026-01-19')).toBe(111)
    expect(manualValueAt(facts, holdingId, '2026-01-20')).toBe(222)
  })

  it('scenario J: clear at T ends coverage from the clear day; history before it survives', () => {
    const { facts, holdingId } = intervalFacts()
    facts.manualByHolding.set(holdingId, [
      {
        valueMinor: 222,
        effectiveFrom: '2026-01-20',
        supersededAt: '2026-02-05T08:00:00Z',
        createdAt: '2026-01-20T00:00:00Z',
      },
    ])
    expect(manualValueAt(facts, holdingId, '2026-02-04')).toBe(222) // reconstructable history
    expect(manualValueAt(facts, holdingId, '2026-02-05')).toBeNull() // cleared period falls through
    expect(manualValueAt(facts, holdingId, '2026-03-01')).toBeNull()
  })

  it('scenario J: a backdated correction rewrites exactly its own region, nothing else', () => {
    const { facts, holdingId } = intervalFacts()
    facts.manualByHolding.set(holdingId, [
      {
        valueMinor: 111,
        effectiveFrom: '2026-01-10',
        supersededAt: '2026-01-20T00:00:00Z',
        createdAt: '2026-01-10T00:00:00Z',
      },
      {
        valueMinor: 222,
        effectiveFrom: '2026-01-20',
        supersededAt: '2026-02-05T08:00:00Z',
        createdAt: '2026-01-20T00:00:00Z',
      },
      {
        valueMinor: 55,
        effectiveFrom: '2026-01-01',
        supersededAt: null,
        createdAt: '2026-02-01T00:00:00Z',
      },
    ])
    expect(manualValueAt(facts, holdingId, '2026-01-01')).toBe(55) // corrected region
    expect(manualValueAt(facts, holdingId, '2026-01-09')).toBe(55)
    expect(manualValueAt(facts, holdingId, '2026-01-10')).toBe(111) // untouched
    expect(manualValueAt(facts, holdingId, '2026-02-01')).toBe(222) // untouched
    expect(manualValueAt(facts, holdingId, '2026-02-05')).toBeNull()
  })
})

describe('aggregation identity checks', () => {
  it('CMV sums quantity times unit across open lots; DCB counts only known basis at frozen cost', () => {
    const holdingA = 'ha'
    const holdingB = 'hb'
    const facts = emptyFacts({
      holdings: new Map([
        [holdingA, { kind: 'raw_card', variantId: 'va' }],
        [holdingB, { kind: 'raw_card', variantId: 'vb' }],
      ]),
      lots: [
        {
          id: 'la',
          holdingId: holdingA,
          acquiredOn: '2026-01-01',
          quantity: 3,
          unitCostBasisNokMinor: 500,
          costBasisState: 'known',
          voidedAt: null,
        },
        {
          id: 'lb',
          holdingId: holdingB,
          acquiredOn: '2026-01-01',
          quantity: 1,
          unitCostBasisNokMinor: null,
          costBasisState: 'unknown',
          voidedAt: null,
        },
      ],
    })
    facts.fxByCurrency.set('EUR', [{ rateDate: '2025-12-01', rate: 100_000_000 }])
    facts.pricesByVariant.set('va', [
      {
        provider: 'tcgdex_cardmarket',
        valueMinor: 700,
        snapshotDate: '2026-01-05',
        currency: 'EUR',
      },
    ])
    const row = expectedSnapshotAt(facts, '2026-01-10')
    expect(row.market_value_nok_minor).toBe(2100) // 3 x 700; unpriced lot excluded, counted
    expect(row.attributed_value_nok_minor).toBe(2100)
    expect(row.cost_basis_nok_minor).toBe(1500) // frozen cost, independent of market movement
    expect(row.open_lot_count).toBe(2)
    expect(row.unvalued_lot_count).toBe(1)
  })

  it('frozen cumulatives: CS and NSP accumulate by business date and survive later price movement', () => {
    const { facts } = rawLotFacts({ acquiredOn: '2026-01-01' })
    facts.collectibleSpendEvents.push({ date: '2026-01-01', amountNokMinor: 50000 })
    facts.proceedsEvents.push({ date: '2026-02-01', amountNokMinor: 30000 })
    const mid = expectedSnapshotAt(facts, '2026-01-31')
    expect(mid.collectible_spend_to_date_nok_minor).toBe(50000)
    expect(mid.sales_proceeds_to_date_nok_minor).toBe(0)
    const later = expectedSnapshotAt(facts, '2026-02-10')
    expect(later.sales_proceeds_to_date_nok_minor).toBe(30000)
  })

  it('daysBetween counts calendar-day gaps deterministically across month boundaries', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
    expect(daysBetween('2026-01-05', '2026-01-05')).toBe(0)
  })
})
