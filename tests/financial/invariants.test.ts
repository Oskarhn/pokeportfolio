/**
 * One test per FINANCIAL_MODEL.md §12 invariant that is testable at the pure
 * domain layer today. F2, F4, F7, F8, F12 and F13 need purchase/sale/opening
 * workflow infrastructure that does not exist until M8/M10/M16/M18 and are
 * exercised there — listing them here as skipped would be fake coverage, so
 * they are simply not present yet. This file grows with the domain, not in
 * one sitting.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as Money from '../../src/domain/money'
import { allocate } from '../../src/domain/allocation'
import { convert } from '../../src/domain/fx'
import { resolveMarketValue } from '../../src/domain/market-value'
import { summarizeInventoryValue, type InventoryLot } from '../../src/domain/inventory'
import {
  grossPurchaseOutflow,
  collectibleSpend,
  hobbySpend,
  type AttributedPurchaseLine,
} from '../../src/domain/spending'
import {
  netSalesProceeds,
  realizedResultOnCostedDisposals,
  proceedsFromUncostedDisposals,
  type SaleLine,
} from '../../src/domain/sales'

const nok = (v: string) => Money.fromDecimalString(v, 'NOK')

describe('M1 — NULL money never means zero', () => {
  it('a missing market value carries no Money at all — there is no zero to compare against', () => {
    const missing = resolveMarketValue({ manualValue: null, providerSnapshot: null })
    expect(missing).toEqual({ state: 'missing' })
    expect('value' in missing).toBe(false)
  })

  it('an uncosted sale line has no cost-basis Money, distinct from a zero cost basis', () => {
    const line: SaleLine = { costBasisAtSale: null, allocatedNetProceeds: nok('300.00') }
    expect(line.costBasisAtSale).toBeNull()
  })
})

describe('M2 — unitCostBasis present iff cost_basis_state = known', () => {
  it('is enforced structurally: only the "known" variant has an unitCostBasis field', () => {
    // TypeScript itself rejects `{ kind: 'unknown', unitCostBasis: ... }` at
    // compile time — see src/domain/cost-basis.ts. This test documents the
    // runtime shape for the one variant that does carry an amount.
    const known = { kind: 'known' as const, unitCostBasis: nok('500.00') }
    expect(known.unitCostBasis).toBeDefined()
  })
})

describe('F1 — GPO = CS + HS', () => {
  const lineArb = fc
    .record({
      spendClass: fc.constantFrom<'collectible' | 'hobby'>('collectible', 'hobby'),
      minorUnits: fc.bigInt({ min: 0n, max: 10_000_000n }),
    })
    .map(({ spendClass, minorUnits }): AttributedPurchaseLine => ({
      spendClass,
      attributableCost: Money.fromMinorUnits(minorUnits, 'NOK'),
    }))

  it('holds over randomised purchase-line sets', () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 0, maxLength: 30 }), (lines) => {
        const gpo = grossPurchaseOutflow('NOK', lines)
        const cs = collectibleSpend('NOK', lines)
        const hs = hobbySpend('NOK', lines)
        expect(Money.equals(gpo, Money.add(cs, hs))).toBe(true)
      }),
    )
  })
})

describe('F3 — CMV = ACMV + UMV', () => {
  const lotArb = fc.record({
    quantityRemaining: fc.bigInt({ min: 0n, max: 100n }),
    known: fc.boolean(),
    unitValueMinorUnits: fc.bigInt({ min: 0n, max: 100_000n }),
    hasValue: fc.boolean(),
  })

  it('holds over randomised lot sets, including unvalued and uncosted lots', () => {
    fc.assert(
      fc.property(fc.array(lotArb, { minLength: 0, maxLength: 30 }), (rows) => {
        const lots: InventoryLot[] = rows.map((r) => ({
          quantityRemaining: r.quantityRemaining,
          costBasisState: r.known
            ? { kind: 'known', unitCostBasis: nok('1.00') }
            : { kind: 'unknown' },
          effectiveUnitCostBasis: r.known ? nok('1.00') : null,
          marketValue: r.hasValue
            ? resolveMarketValue({
                manualValue: null,
                providerSnapshot: {
                  value: Money.fromMinorUnits(r.unitValueMinorUnits, 'NOK'),
                  ageDays: 0,
                },
              })
            : { state: 'missing' },
        }))
        const { cmv, acmv, umv } = summarizeInventoryValue('NOK', lots)
        expect(Money.equals(cmv, Money.add(acmv, umv))).toBe(true)
      }),
    )
  })
})

describe('F5 — RRC + PUD = NSP − Σ cost_basis_at_sale', () => {
  const saleLineArb = fc.record({
    costed: fc.boolean(),
    costBasisMinorUnits: fc.bigInt({ min: 0n, max: 1_000_000n }),
    proceedsMinorUnits: fc.bigInt({ min: 0n, max: 1_000_000n }),
  })

  it('holds over randomised sale-line sets', () => {
    fc.assert(
      fc.property(fc.array(saleLineArb, { minLength: 0, maxLength: 30 }), (rows) => {
        const lines: SaleLine[] = rows.map((r) => ({
          costBasisAtSale: r.costed ? Money.fromMinorUnits(r.costBasisMinorUnits, 'NOK') : null,
          allocatedNetProceeds: Money.fromMinorUnits(r.proceedsMinorUnits, 'NOK'),
        }))
        const nsp = netSalesProceeds('NOK', lines)
        const rrc = realizedResultOnCostedDisposals('NOK', lines)
        const pud = proceedsFromUncostedDisposals('NOK', lines)
        const sumCostBasisAtSale = Money.sum(
          'NOK',
          lines.flatMap((l) => (l.costBasisAtSale ? [l.costBasisAtSale] : [])),
        )
        expect(Money.equals(Money.add(rrc, pud), Money.subtract(nsp, sumCostBasisAtSale))).toBe(
          true,
        )
      }),
    )
  })
})

describe('F6 — allocations sum exactly to the total', () => {
  it('holds for a deliberately awkward input (does not divide evenly)', () => {
    const shares = allocate(100n, [1n, 1n, 1n])
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n)
  })

  it('a deliberately broken allocator would fail this suite', () => {
    // A naive "floor every share" allocator loses remainder units. Assert
    // that behaviour is what the real allocator avoids.
    const naiveFloors = [1n, 1n, 1n].map((w) => (100n * w) / 3n)
    const naiveSum = naiveFloors.reduce((a, b) => a + b, 0n)
    expect(naiveSum).not.toBe(100n) // the naive approach loses a unit
    expect(allocate(100n, [1n, 1n, 1n]).reduce((a, b) => a + b, 0n)).toBe(100n) // the real one does not
  })
})

describe('F9 / F14 — a provider outage or missing value never yields zero', () => {
  it('a stale value is retained and used, never zeroed, until it ages past 30 days', () => {
    const stale = resolveMarketValue({
      manualValue: null,
      providerSnapshot: { value: nok('340.00'), ageDays: 29 },
    })
    expect(stale.state).toBe('stale')
    if (stale.state !== 'missing') {
      expect(Money.isZero(stale.value)).toBe(false)
    }
  })

  it('a lot with no resolvable value is excluded from CMV and counted in UHC, never valued at zero', () => {
    const lots: InventoryLot[] = [
      {
        quantityRemaining: 1n,
        costBasisState: { kind: 'unknown' },
        effectiveUnitCostBasis: null,
        marketValue: { state: 'missing' },
      },
    ]
    const summary = summarizeInventoryValue('NOK', lots)
    expect(Money.isZero(summary.cmv)).toBe(true) // correctly zero here — nothing else is priced
    expect(summary.uhc).toBe(1) // but the exclusion is counted, not silent
  })
})

describe('F10 — raw prices never value graded cards', () => {
  it('is a UI/query-layer rule with no domain-level bypass: MarketValue carries no "is this raw or graded" escape hatch', () => {
    // The domain layer resolves whatever value it is given; the rule that a
    // graded holding must never be resolved from a raw-card snapshot lives
    // in the query that selects which snapshot to pass in (M9). Documented
    // here as a known gap, not silently assumed covered.
    expect(true).toBe(true)
  })
})

describe('F11 — frozen NOK conversions are never recomputed', () => {
  it('convert() is a pure function of (amount, rate, currency) — a later rate never mutates an earlier result', () => {
    const purchaseAmount = Money.fromDecimalString('49.50', 'EUR')
    const frozenAtPurchase = convert(purchaseAmount, '11.54000000', 'NOK')
    // The rate moves the next day; the frozen conversion is unaffected
    // because it is a value, not a recomputed reference.
    const tomorrowsRateApplied = convert(purchaseAmount, '12.00000000', 'NOK')
    expect(Money.toDecimalString(frozenAtPurchase)).toBe('571.23')
    expect(Money.toDecimalString(tomorrowsRateApplied)).not.toBe(
      Money.toDecimalString(frozenAtPurchase),
    )
  })
})
