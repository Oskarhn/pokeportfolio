import { describe, expect, it } from 'vitest'
import {
  convertToNokMinorUnits,
  divideRoundHalfUp,
  normalizeNorgesBankRate,
  NORGES_BANK_UNIT_MULT,
  parseDecimalToScaledBigInt,
} from './fx-oracle'

/**
 * P135 §4/§12/§13/§14 — sanity, adversarial and metamorphic tests for the independent oracle
 * itself (not the product). Cross-checked against the real Postgres reproduction in
 * scripts/p135/repro_p130_02.sql, run against an isolated postgres:17 container — see
 * output_135.txt for that run's captured output. This file proves the ORACLE is internally
 * consistent; fx-oracle-as-p136-acceptance.test.ts below is the fixture table P136 must satisfy.
 */
describe('fx-oracle: parseDecimalToScaledBigInt / divideRoundHalfUp', () => {
  it('parses a plain decimal to the expected scaled bigint', () => {
    expect(parseDecimalToScaledBigInt('0.060375', 8)).toBe(6037500n)
    expect(parseDecimalToScaledBigInt('6.0375', 8)).toBe(603750000n)
    expect(parseDecimalToScaledBigInt('11.54', 8)).toBe(1154000000n)
  })

  it('rejects exponent notation, locale separators, and over-precise input', () => {
    expect(() => parseDecimalToScaledBigInt('6.0375e0', 8)).toThrow()
    expect(() => parseDecimalToScaledBigInt('6,0375', 8)).toThrow()
    expect(() => parseDecimalToScaledBigInt('0.123456789', 8)).toThrow()
  })

  it("rounds half-up, not banker's rounding, at the .5 boundary", () => {
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n) // 2.5 -> 3 (not 2, ruling out round-half-even)
    expect(divideRoundHalfUp(15n, 10n)).toBe(2n) // 1.5 -> 2
    expect(divideRoundHalfUp(-5n, 2n)).toBe(-3n)
  })
})

describe('fx-oracle: convertToNokMinorUnits — CANONICAL_FX_CONTRACT', () => {
  it('E10 control from FINANCIAL_MODEL.md §8 (EUR, exponent gap 0)', () => {
    // 45.00 EUR line at 11.54 NOK/EUR -> 519.30 NOK -> 51930 øre.
    expect(
      convertToNokMinorUnits({
        sourceCurrency: 'EUR',
        sourceMinorUnits: 4500n,
        fxRateToNokPerMajorUnit: '11.54',
      }),
    ).toBe(51930n)
  })

  it('manual JPY at a true per-unit rate: 10000 JPY @ 0.060375 -> 60375 øre', () => {
    expect(
      convertToNokMinorUnits({
        sourceCurrency: 'JPY',
        sourceMinorUnits: 10000n,
        fxRateToNokPerMajorUnit: '0.060375',
      }),
    ).toBe(60375n)
  })

  it('NOK is an identity (exponent gap 0, rate always 1)', () => {
    expect(
      convertToNokMinorUnits({
        sourceCurrency: 'NOK',
        sourceMinorUnits: 12345n,
        fxRateToNokPerMajorUnit: '1',
      }),
    ).toBe(12345n)
  })

  it('tiny JPY amount: 1 JPY at a small rate rounds rather than truncating to 0 silently', () => {
    // 1 JPY * 0.060375 NOK = 0.060375 NOK = 6.0375 øre -> half-up -> 6 øre.
    expect(
      convertToNokMinorUnits({
        sourceCurrency: 'JPY',
        sourceMinorUnits: 1n,
        fxRateToNokPerMajorUnit: '0.060375',
      }),
    ).toBe(6n)
  })

  it('large JPY amount does not overflow ordinary bigint arithmetic', () => {
    const large = 999_999_999_999n // ~1 trillion JPY
    const result = convertToNokMinorUnits({
      sourceCurrency: 'JPY',
      sourceMinorUnits: large,
      fxRateToNokPerMajorUnit: '0.060375',
    })
    expect(result).toBe(divideRoundHalfUp(large * 6037500n * 100n, 100000000n))
  })

  it('rounding boundary: exact .5 øre rounds up, not down or to even', () => {
    // Choose a rate/amount pair landing exactly on a half-øre boundary.
    // 1 JPY * 0.5 NOK/JPY = 50 øre exactly -> no ambiguity; use a genuinely fractional case:
    // 1 JPY * 0.005 NOK = 0.5 øre -> half-up -> 1 øre (never 0).
    expect(
      convertToNokMinorUnits({
        sourceCurrency: 'JPY',
        sourceMinorUnits: 1n,
        fxRateToNokPerMajorUnit: '0.005',
      }),
    ).toBe(1n)
  })
})

describe('fx-oracle: normalizeNorgesBankRate — UNIT_MULT normalization', () => {
  it('JPY (UNIT_MULT=2): a raw "6.0375" (NOK per 100 JPY) normalizes to "0.06037500" (NOK per 1 JPY)', () => {
    expect(normalizeNorgesBankRate('6.0375', NORGES_BANK_UNIT_MULT.JPY)).toBe('0.06037500')
  })

  it('EUR/USD/GBP (UNIT_MULT=0): normalization is a no-op', () => {
    expect(normalizeNorgesBankRate('11.5400', NORGES_BANK_UNIT_MULT.EUR)).toBe('11.5400')
    expect(normalizeNorgesBankRate('9.5000', NORGES_BANK_UNIT_MULT.USD)).toBe('9.5000')
  })
})

describe('fx-oracle: §13 metamorphic invariant — representation independence', () => {
  it('the same economic amount, expressed under an artificial higher-exponent currency, converts to the same NOK result', () => {
    // Real case: 10,000 JPY (exponent 0) at 0.060375 NOK/JPY.
    const real = convertToNokMinorUnits({
      sourceCurrency: 'JPY',
      sourceMinorUnits: 10000n,
      fxRateToNokPerMajorUnit: '0.060375',
    })

    // Metamorphic transform: represent the SAME economic amount (10,000 major units) as if the
    // source currency had exponent 2 instead of 0 (minor units scaled ×100, so the represented
    // major-unit amount is unchanged) and scale the rate consistently (rate is always "per ONE
    // major unit" regardless of exponent, so it must NOT change under this transform).
    const artificialExp2 = convertToNokMinorUnits({
      // NOK itself has exponent 2, so borrowing its exponent gives the "amount ×100 minor units,
      // same major-unit amount, same per-major-unit rate" transform without inventing a sixth
      // currency in the oracle's table.
      sourceCurrency: 'NOK',
      sourceMinorUnits: 10000n * 100n, // 10,000 major units at exponent 2 = 1,000,000 minor units
      fxRateToNokPerMajorUnit: '0.060375', // NOK->NOK "rate" standing in for the JPY rate; both express NOK per 1 major unit of source
    })

    // Both conversions represent "10,000 major units of a currency worth 0.060375 NOK each",
    // just under different minor-unit exponents (0 vs 2) — the NOK result must be identical
    // regardless of which exponent the source currency happens to use.
    expect(real).toBe(artificialExp2)
  })

  it('scaling source minor units by 10 and the source exponent by +1 together is a no-op on the NOK result', () => {
    const base = convertToNokMinorUnits({
      sourceCurrency: 'JPY', // exponent 0
      sourceMinorUnits: 12345n,
      fxRateToNokPerMajorUnit: '0.073',
    })
    // Represent the identical major-unit amount under exponent 2 instead of 0: minor units ×100.
    const rescaled = convertToNokMinorUnits({
      sourceCurrency: 'NOK', // borrowed purely for its exponent=2 in this oracle's table
      sourceMinorUnits: 12345n * 100n,
      fxRateToNokPerMajorUnit: '0.073',
    })
    expect(rescaled).toBe(base)
  })
})

describe('fx-oracle §14 — mutation sensitivity (against THIS reference only, never the product)', () => {
  it('MUTANT: forcing JPY exponent to 2 (matching the P130-02 root cause) breaks the E10-shaped and manual-JPY fixtures', () => {
    const mutantExponents = { NOK: 2, EUR: 2, USD: 2, GBP: 2, JPY: 2 } // mutated: JPY was 0
    function mutantConvert(sourceExp: number, sourceMinor: bigint, rate: string): bigint {
      const targetExp = 2
      const rateScaled = parseDecimalToScaledBigInt(rate, 8)
      const shift = targetExp - sourceExp
      const num =
        shift >= 0 ? sourceMinor * rateScaled * 10n ** BigInt(shift) : sourceMinor * rateScaled
      const den = shift >= 0 ? 10n ** 8n : 10n ** 8n * 10n ** BigInt(-shift)
      return divideRoundHalfUp(num, den)
    }
    const correct = convertToNokMinorUnits({
      sourceCurrency: 'JPY',
      sourceMinorUnits: 10000n,
      fxRateToNokPerMajorUnit: '0.060375',
    })
    const mutant = mutantConvert(mutantExponents.JPY, 10000n, '0.060375')
    expect(mutant).not.toBe(correct) // mutant collapses the exponent shift to 0, exactly reproducing the released SQL bug
    expect(mutant).toBe(604n) // matches the real Postgres repro of the released formula (scripts/p135/repro_p130_02.sql, case A)
  })

  it('MUTANT: ignoring UNIT_MULT (treating every raw Norges Bank number as already per-unit) breaks the JPY normalization fixture', () => {
    function mutantNormalize(raw: string, _unitMult: number): string {
      void _unitMult // mutated: UNIT_MULT parameter ignored entirely, matching the released parser
      return raw
    }
    const correct = normalizeNorgesBankRate('6.0375', NORGES_BANK_UNIT_MULT.JPY)
    const mutant = mutantNormalize('6.0375', NORGES_BANK_UNIT_MULT.JPY)
    expect(mutant).not.toBe(correct)
    expect(mutant).toBe('6.0375') // the raw, un-normalized figure — matches the released parser's actual output
  })

  it('MUTANT: EUR/USD/GBP fixtures are NOT sensitive to either mutation above (exponent gap 0, UNIT_MULT 0) — this is why the released tests never caught it', () => {
    const mutantExponents = { NOK: 2, EUR: 2, USD: 2, GBP: 2, JPY: 2 }
    function mutantConvert(sourceExp: number, sourceMinor: bigint, rate: string): bigint {
      const targetExp = 2
      const rateScaled = parseDecimalToScaledBigInt(rate, 8)
      const shift = targetExp - sourceExp
      const num =
        shift >= 0 ? sourceMinor * rateScaled * 10n ** BigInt(shift) : sourceMinor * rateScaled
      const den = shift >= 0 ? 10n ** 8n : 10n ** 8n * 10n ** BigInt(-shift)
      return divideRoundHalfUp(num, den)
    }
    const correct = convertToNokMinorUnits({
      sourceCurrency: 'EUR',
      sourceMinorUnits: 4500n,
      fxRateToNokPerMajorUnit: '11.54',
    })
    const mutant = mutantConvert(mutantExponents.EUR, 4500n, '11.54')
    expect(mutant).toBe(correct) // mutant survives on EUR — proves the JPY-only blind spot, not a generic weakness
  })
})
