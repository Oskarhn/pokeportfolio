import { sum } from '@shared/domain/money'
import { formatMoney } from '../../money/format-money'
import { findUnsafeIntegerLiteral } from '../../net/exact-transport-guard'
import { describeEngine } from '../../diagnostics/runtime-proof'
import { classifyFreshness } from '../price-check/p165-domain/price-check/freshness'
import { nokReference } from '../price-check/p165-domain/price-check/fx'
import { cardsSharingAName, resolveVariant } from '../price-check/p165-domain/price-check/identity'
import { buildRawSection } from '../price-check/p165-domain/price-check/raw-section'

/**
 * P169 in-app proof: runs the VENDORED P165 price-check domain (unchanged web code) on whatever
 * engine executes the bundle. Under Jest this proves the checks are right; only the device run
 * (harness built with EXPO_PUBLIC_RUNTIME_PROOF=1, logcat lines `P169_PROOF`) is evidence about
 * Hermes. Expected values are written out literally, never recomputed with the code under test.
 */

export interface P169ProofResult {
  pass: number
  fail: number
  engine: string
  lines: string[]
}

const V = 'variant-1'
const NOW = Date.parse('2026-09-25T12:00:00Z')

function section(observations: unknown[]) {
  return buildRawSection(
    {
      fetchedAt: '2026-09-25T12:00:00.000Z',
      providerErrorCount: 0,
      rows: [{ cardVariantId: V, observations }],
    },
    { variantId: V, finish: 'normal' },
  ).section
}

export function runP169Proof(): P169ProofResult {
  const lines: string[] = []
  let pass = 0
  let fail = 0
  const check = (name: string, actual: unknown, expected: unknown): void => {
    if (actual === expected) {
      pass += 1
      lines.push(`PASS ${name}`)
    } else {
      fail += 1
      lines.push(
        `FAIL ${name} expected=${String(expected)} actual=${typeof actual === 'bigint' ? `${String(actual)}n` : String(actual)}`,
      )
    }
  }

  check('Object.hasOwn exists (used by the P165 wire guard)', typeof Object.hasOwn, 'function')
  check("'constructor' is not an own entry", Object.hasOwn({}, 'constructor'), false)

  const big = section([
    {
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: '288230376151711744',
      providerUpdatedAt: '2026-09-25T10:00:00Z',
    },
    {
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      sourceCurrency: 'USD',
      valueMinor: '9007199254740993',
      providerUpdatedAt: null,
    },
  ])
  check(
    '2^58 EUR observation kept exactly',
    big.observations[0]?.price.minorUnits === 288230376151711744n,
    true,
  )
  check(
    '2^53+1 USD observation kept exactly',
    big.observations[1]?.price.minorUnits === 9007199254740993n,
    true,
  )
  check(
    '2^58 EUR formats exactly',
    formatMoney(big.observations[0]?.price ?? null),
    '€2,882,303,761,517,117.44',
  )

  const refused = section([
    {
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: '-9007199254740993',
      providerUpdatedAt: null,
    },
    {
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: Number('9007199254740993'),
      providerUpdatedAt: null,
    },
    {
      provider: 'constructor',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: '1',
      providerUpdatedAt: null,
    },
  ])
  check('negative / numeric / prototype-named values all dropped', refused.dropped.length, 3)
  check(
    'all-dropped response is malformed, not "no price"',
    refused.unavailable,
    'malformed_response',
  )

  const zero = section([
    {
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      valueMinor: '0',
      providerUpdatedAt: null,
    },
  ])
  check('explicit provider zero is a real 0', zero.observations[0]?.price.minorUnits === 0n, true)
  check('zero formats as zero', formatMoney(zero.observations[0]?.price ?? null), '€0.00')
  check('absent formats as a dash', formatMoney(null), '—')
  check(
    'no observations -> no_variant_price (never zero)',
    section([]).unavailable,
    'no_variant_price',
  )

  const eur = nokReference(
    { minorUnits: 987654321098765n, currency: 'EUR' },
    { ok: true, rate: { rateToNok: '11.5', rateDate: '2026-09-25' } },
  )
  check(
    'EUR -> NOK above 2^53, half-up',
    eur.status === 'converted' ? eur.nok.minorUnits === 11358024692635798n : false,
    true,
  )
  const jpy = nokReference(
    { minorUnits: 1000000n, currency: 'JPY' },
    { ok: true, rate: { rateToNok: '0.0712', rateDate: '2026-09-25' } },
  )
  check(
    'JPY (exponent 0) -> NOK (exponent 2)',
    jpy.status === 'converted' ? jpy.nok.minorUnits === 7120000n : false,
    true,
  )
  check(
    'JPY formats with no decimals',
    formatMoney({ minorUnits: 12345n, currency: 'JPY' }),
    '12,345 JPY',
  )
  const noRate = nokReference(
    { minorUnits: 100n, currency: 'USD' },
    { ok: false, reason: 'missing' },
  )
  check('no FX rate -> unavailable, never invented', noRate.status, 'unavailable')

  check(
    'large sum exact',
    String(
      sum('NOK', [
        { minorUnits: 288230376151711745n, currency: 'NOK' },
        { minorUnits: 288230376151711745n, currency: 'NOK' },
        { minorUnits: 9007199254740993n, currency: 'NOK' },
      ]).minorUnits,
    ),
    '585467951558164483',
  )
  check(
    'unquoted +(2^53+1) found before JSON.parse',
    findUnsafeIntegerLiteral('{"v":9007199254740993}'),
    '9007199254740993',
  )
  check(
    'unquoted -(2^53+1) found before JSON.parse',
    findUnsafeIntegerLiteral('{"v":-9007199254740993}'),
    '-9007199254740993',
  )
  check(
    'quoted "9007199254740993" is not a violation',
    findUnsafeIntegerLiteral('{"v":"9007199254740993"}'),
    null,
  )

  check('10-day-old observation is stale', classifyFreshness('2026-09-15T12:00:00Z', NOW), 'stale')
  check(
    '45-day-old observation is outdated',
    classifyFreshness('2026-08-11T12:00:00Z', NOW),
    'outdated',
  )
  check('missing timestamp is unknown, not fresh', classifyFreshness(null, NOW), 'unknown')

  const two = [
    {
      variantId: 'a',
      finish: 'normal' as const,
      stamp: '',
      subtype: '',
      size: 'standard' as const,
      isActive: true,
    },
    {
      variantId: 'b',
      finish: 'reverse' as const,
      stamp: '',
      subtype: '',
      size: 'standard' as const,
      isActive: true,
    },
  ]
  check(
    'two active printings -> choice required',
    resolveVariant(two, undefined).status,
    'choice_required',
  )
  check('foreign variant id -> mismatch', resolveVariant(two, 'zzz').status, 'mismatch')
  check(
    'same-name detection (toLocaleLowerCase)',
    cardsSharingAName([
      { cardId: '1', name: 'P169  Pikachu' },
      { cardId: '2', name: 'p169 pikachu' },
      { cardId: '3', name: 'P169 Charizard' },
    ]).size,
    2,
  )

  return { pass, fail, engine: describeEngine(), lines }
}

export function runAndLogP169Proof(log: (line: string) => void = console.log): P169ProofResult {
  const result = runP169Proof()
  for (const line of result.lines) log(`P169_PROOF ${line}`)
  log(
    `P169_PROOF RESULT pass=${String(result.pass)} fail=${String(result.fail)} engine=${result.engine}`,
  )
  return result
}
