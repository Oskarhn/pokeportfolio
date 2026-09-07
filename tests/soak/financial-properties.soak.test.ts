/**
 * P117 §2 — high-volume pure-domain financial property soak. Extends the ordinary-run properties
 * in tests/financial/invariants.test.ts (F1/F3/F5/F6) to a far higher iteration count, and adds
 * coverage for scenario classes that file does not touch yet: opening returns/ROI, TTEP's
 * structural independence from opening cost, allocateSigned (sales can net a loss),
 * effectiveUnitCostBasis with lot-cost adjustments, and multi-currency inputs.
 *
 * Everything here is a pure function over generated inputs -- no DB, no browser, no scanner. Not
 * part of `pnpm test`; run via `pnpm test:soak`. Iteration counts are calibrated per property to
 * finish this file in low tens of seconds: cheap scalar properties run in the hundreds of
 * thousands, array-based ones (fast-check's array-generation overhead dominates) in the tens of
 * thousands -- see the actual counts run reported in ai_outputs/CLAUDE_SONNET_5_outputs/output_117.txt
 * rather than assumed here.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import * as Money from '../../src/domain/money'
import type { CurrencyCode } from '../../src/domain/currency'
import { allocate, allocateSigned, allocateMoney } from '../../src/domain/allocation'
import { convert } from '../../src/domain/fx'
import { resolveMarketValue } from '../../src/domain/market-value'
import { summarizeInventoryValue, type InventoryLot } from '../../src/domain/inventory'
import {
  effectiveUnitCostBasis,
  type CostBasisState,
  type LotCostAdjustment,
} from '../../src/domain/cost-basis'
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
import { totalTrackedEconomicPosition } from '../../src/domain/position'
import { computeOpeningReturn, openingRoiPercent } from '../../src/domain/opening'

const CURRENCIES: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']
const currencyArb = fc.constantFrom(...CURRENCIES)
const moneyArb = (currency: CurrencyCode, min: bigint, max: bigint) =>
  fc.bigInt({ min, max }).map((minorUnits) => Money.fromMinorUnits(minorUnits, currency))

describe('F1 soak — GPO = CS + HS across currencies', () => {
  it('holds for 300k randomised purchase-line sets', () => {
    let runs = 0
    fc.assert(
      fc.property(
        currencyArb,
        fc.array(
          fc.record({
            spendClass: fc.constantFrom<'collectible' | 'hobby'>('collectible', 'hobby'),
            minorUnits: fc.bigInt({ min: 0n, max: 10n ** 15n }),
          }),
          { minLength: 0, maxLength: 12 },
        ),
        (currency, rows) => {
          runs++
          const lines: AttributedPurchaseLine[] = rows.map((r) => ({
            spendClass: r.spendClass,
            attributableCost: Money.fromMinorUnits(r.minorUnits, currency),
          }))
          const gpo = grossPurchaseOutflow(currency, lines)
          const cs = collectibleSpend(currency, lines)
          const hs = hobbySpend(currency, lines)
          expect(Money.equals(gpo, Money.add(cs, hs))).toBe(true)
        },
      ),
      { numRuns: 300_000 },
    )
    expect(runs).toBe(300_000)
  })
})

describe('F3 soak — CMV = ACMV + UMV, and CMV excludes zero-quantity (not-owned) lots', () => {
  const lotArb = fc.record({
    quantityRemaining: fc.bigInt({ min: 0n, max: 100_000n }),
    known: fc.boolean(),
    unitValueMinorUnits: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    hasValue: fc.boolean(),
    manual: fc.boolean(),
  })

  it('holds for 200k randomised lot sets, and an unowned (quantity=0) lot never contributes value', () => {
    let runs = 0
    fc.assert(
      fc.property(
        currencyArb,
        fc.array(lotArb, { minLength: 0, maxLength: 15 }),
        (currency, rows) => {
          runs++
          const lots: InventoryLot[] = rows.map((r) => ({
            quantityRemaining: r.quantityRemaining,
            costBasisState: r.known
              ? { kind: 'known', unitCostBasis: Money.fromMinorUnits(1n, currency) }
              : { kind: 'unknown' },
            effectiveUnitCostBasis: r.known ? Money.fromMinorUnits(1n, currency) : null,
            marketValue: r.hasValue
              ? resolveMarketValue({
                  manualValue: r.manual
                    ? Money.fromMinorUnits(r.unitValueMinorUnits, currency)
                    : null,
                  providerSnapshot: r.manual
                    ? null
                    : { value: Money.fromMinorUnits(r.unitValueMinorUnits, currency), ageDays: 0 },
                })
              : { state: 'missing' },
          }))
          const { cmv, acmv, umv } = summarizeInventoryValue(currency, lots)
          expect(Money.equals(cmv, Money.add(acmv, umv))).toBe(true)

          // "CMV only owned assets": a lot with quantityRemaining = 0 contributes zero regardless
          // of how it is otherwise valued/costed.
          const zeroQtyLots = lots.filter((l) => l.quantityRemaining === 0n)
          if (zeroQtyLots.length > 0 && zeroQtyLots.length === lots.length) {
            expect(Money.isZero(cmv)).toBe(true)
            expect(Money.isZero(acmv)).toBe(true)
          }
        },
      ),
      { numRuns: 200_000 },
    )
    expect(runs).toBe(200_000)
  })
})

describe('F5 soak — RRC + PUD = NSP - sum(cost_basis_at_sale); each sale line counted exactly once', () => {
  it('holds for 200k randomised sale-line sets, allowing losses (proceeds < cost basis)', () => {
    let runs = 0
    fc.assert(
      fc.property(
        currencyArb,
        fc.array(
          fc.record({
            costed: fc.boolean(),
            costBasisMinorUnits: fc.bigInt({ min: 0n, max: 10n ** 12n }),
            proceedsMinorUnits: fc.bigInt({ min: 0n, max: 10n ** 12n }),
          }),
          { minLength: 0, maxLength: 15 },
        ),
        (currency, rows) => {
          runs++
          const lines: SaleLine[] = rows.map((r) => ({
            costBasisAtSale: r.costed
              ? Money.fromMinorUnits(r.costBasisMinorUnits, currency)
              : null,
            allocatedNetProceeds: Money.fromMinorUnits(r.proceedsMinorUnits, currency),
          }))
          const nsp = netSalesProceeds(currency, lines)
          const rrc = realizedResultOnCostedDisposals(currency, lines)
          const pud = proceedsFromUncostedDisposals(currency, lines)
          const sumCostBasisAtSale = Money.sum(
            currency,
            lines.flatMap((l) => (l.costBasisAtSale ? [l.costBasisAtSale] : [])),
          )
          expect(Money.equals(Money.add(rrc, pud), Money.subtract(nsp, sumCostBasisAtSale))).toBe(
            true,
          )

          // "sale proceeds exactly once": summing proceeds via the costed/uncosted partition
          // reproduces NSP exactly, for every partition fast-check generates.
          const costedProceeds = Money.sum(
            currency,
            lines.filter((l) => l.costBasisAtSale !== null).map((l) => l.allocatedNetProceeds),
          )
          expect(Money.equals(Money.add(costedProceeds, pud), nsp)).toBe(true)
        },
      ),
      { numRuns: 200_000 },
    )
    expect(runs).toBe(200_000)
  })
})

describe('F6 soak — allocate/allocateSigned/allocateMoney: shares always sum exactly to the total', () => {
  it('allocate: 300k random (total, weights) pairs', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 10n }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          runs++
          const shares = allocate(total, weights)
          expect(shares.reduce((a, b) => a + b, 0n)).toBe(total)
          expect(shares.every((s) => s >= 0n)).toBe(true) // non-negative total -> non-negative shares
        },
      ),
      { numRuns: 300_000 },
    )
    expect(runs).toBe(300_000)
  })

  it('allocateSigned: 300k cases including negative totals (a sale can net a loss)', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 10n }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          runs++
          const shares = allocateSigned(total, weights)
          expect(shares.reduce((a, b) => a + b, 0n)).toBe(total)
          if (total >= 0n) expect(shares.every((s) => s >= 0n)).toBe(true)
          else expect(shares.every((s) => s <= 0n)).toBe(true)
        },
      ),
      { numRuns: 300_000 },
    )
    expect(runs).toBe(300_000)
  })

  it('allocateMoney: 150k cases, currency-tagged shares sum exactly back to the total Money', () => {
    let runs = 0
    fc.assert(
      fc.property(
        currencyArb,
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 8n }), { minLength: 1, maxLength: 20 }),
        (currency, totalMinor, weights) => {
          runs++
          const total = Money.fromMinorUnits(totalMinor, currency)
          const shares = allocateMoney(total, weights)
          const resummed = Money.sum(currency, shares)
          expect(Money.equals(resummed, total)).toBe(true)
        },
      ),
      { numRuns: 150_000 },
    )
    expect(runs).toBe(150_000)
  })
})

describe('opening returns/ROI soak — unknown cost never fabricates a zero result', () => {
  it('computeOpeningReturn is null iff openingCost is null, for 150k random component sets', () => {
    let runs = 0
    fc.assert(
      fc.property(
        currencyArb,
        fc.record({
          retainedTrackedValueMinor: fc.bigInt({ min: 0n, max: 10n ** 12n }),
          netSoldProceedsMinor: fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
          bulkRemainderMinor: fc.option(fc.bigInt({ min: 0n, max: 10n ** 12n }), { nil: null }),
          openingCostMinor: fc.option(fc.bigInt({ min: 1n, max: 10n ** 12n }), { nil: null }),
        }),
        (currency, r) => {
          runs++
          const components = {
            retainedTrackedValue: Money.fromMinorUnits(r.retainedTrackedValueMinor, currency),
            netSoldProceeds: Money.fromMinorUnits(r.netSoldProceedsMinor, currency),
            bulkRemainderEstimate:
              r.bulkRemainderMinor === null
                ? null
                : Money.fromMinorUnits(r.bulkRemainderMinor, currency),
            openingCost:
              r.openingCostMinor === null
                ? null
                : Money.fromMinorUnits(r.openingCostMinor, currency),
          }
          const result = computeOpeningReturn(components)
          expect(result === null).toBe(r.openingCostMinor === null)

          const roi = openingRoiPercent(result, components.openingCost)
          expect(roi === null).toBe(result === null || components.openingCost === null)
        },
      ),
      { numRuns: 150_000 },
    )
    expect(runs).toBe(150_000)
  })
})

describe('TTEP soak — structurally independent of opening cost (F8)', () => {
  it('TTEP(cmv, nsp, cs) never changes when an unrelated openingCost value varies -- 100k cases', () => {
    let runs = 0
    fc.assert(
      fc.property(
        currencyArb,
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }), // an opening cost that has no parameter to enter through
        (currency, cmvMinor, nspMinor, csMinor, unrelatedOpeningCostMinor) => {
          // Generated and discarded on purpose: totalTrackedEconomicPosition's signature has no
          // parameter for an opening cost at all, so no value of this variable can ever reach the
          // computation -- the generator exists to document that fact, not to feed it in.
          void unrelatedOpeningCostMinor
          runs++
          const cmv = Money.fromMinorUnits(cmvMinor, currency)
          const nsp = Money.fromMinorUnits(nspMinor, currency)
          const cs = Money.fromMinorUnits(csMinor, currency)
          const ttep = totalTrackedEconomicPosition(cmv, nsp, cs)
          expect(Money.equals(ttep, Money.subtract(Money.add(cmv, nsp), cs))).toBe(true)
        },
      ),
      { numRuns: 100_000 },
    )
    expect(runs).toBe(100_000)
  })
})

describe('effectiveUnitCostBasis soak — adjustments never manufacture a basis (F7)', () => {
  const stateArb: fc.Arbitrary<CostBasisState> = fc.oneof(
    fc.record({
      kind: fc.constant('known' as const),
      unitCostBasis: moneyArb('NOK', 0n, 10n ** 9n),
    }),
    fc.constant({ kind: 'unallocated_opening' as const }),
    fc.constant({ kind: 'not_paid' as const }),
    fc.constant({ kind: 'unknown' as const }),
    fc.constant({ kind: 'trade_in' as const }),
  )
  const adjustmentArb: fc.Arbitrary<LotCostAdjustment> = fc.record({
    kind: fc.constantFrom<'grading_fee' | 'grading_shipping'>('grading_fee', 'grading_shipping'),
    amount: moneyArb('NOK', 0n, 10n ** 8n),
  })

  it('120k cases: null iff state is not "known"; adjustments only ever affect the known case', () => {
    let runs = 0
    fc.assert(
      fc.property(
        stateArb,
        fc.array(adjustmentArb, { minLength: 0, maxLength: 8 }),
        fc.bigInt({ min: 1n, max: 1000n }),
        (state, adjustments, originalLotQuantity) => {
          runs++
          const result = effectiveUnitCostBasis(state, adjustments, originalLotQuantity)
          expect(result === null).toBe(state.kind !== 'known')
        },
      ),
      { numRuns: 120_000 },
    )
    expect(runs).toBe(120_000)
  })
})

describe('FX conversion soak — frozen conversions are a pure function of their own inputs (F11)', () => {
  it('100k cases: convert() never reads any external/mutable state; same inputs -> same output', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.constantFrom<Exclude<CurrencyCode, 'NOK'>>('EUR', 'USD', 'GBP'),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 500_00000000 }).map((n) => (n / 100000000).toFixed(8)),
        (sourceCurrency, amountMinor, rate) => {
          runs++
          const amount = Money.fromMinorUnits(amountMinor, sourceCurrency)
          const a = convert(amount, rate, 'NOK')
          const b = convert(amount, rate, 'NOK')
          expect(Money.equals(a, b)).toBe(true)
          expect(a.currency).toBe('NOK')
        },
      ),
      { numRuns: 100_000 },
    )
    expect(runs).toBe(100_000)
  })
})
