import { ABSENT, formatMoney } from '../money/format-money'
import { parseMinorUnitsWire } from '../money/wire'
import { findUnsafeIntegerLiteral } from '../net/exact-transport-guard'
import { MONEY_VECTORS } from '../../tests/support/money-vectors'
import {
  fxWriteIsSubmittable,
  nokReferenceForWrite,
  type FxWriteState,
} from '../write/fx-for-write'
import {
  parseNullableMoneyInput,
  parseOptionalChargeInput,
  requireKnownAmount,
} from '../write/money-input'
import { moneyArg, serializeMinorUnits } from '../write/money-wire'
import { generateIdempotencyKey } from '../write/idempotency-key'

/**
 * Exact-money boundary proof that runs INSIDE the app, on whatever engine executes the bundle.
 *
 * The same checks run under Jest (Node/V8, tests/unit/runtime-proof.test.ts) and, when the bundle is
 * built with EXPO_PUBLIC_RUNTIME_PROOF=1, once at app start on the device (index.ts), where the
 * engine is Hermes. Only the device run is evidence about Hermes; the Jest run proves the checks
 * themselves are correct. Output lines start with `P166_PROOF` so they can be filtered from logcat.
 *
 * Covered: the formatter vectors (NOK/EUR/USD 2 decimals, JPY exponent 0, negatives, 2^53+1,
 * 2^58+1, zero), NULL vs zero, the wire parser (decimal string in, exact bigint out; unsafe JSON
 * numbers and '' refused) and the raw-body transport scan (unquoted unsafe integers found, quoted
 * decimal strings passed through JSON.parse byte-for-byte).
 *
 * P177 addition: the WRITE-side boundary (write/money-input.ts, write/money-wire.ts,
 * write/idempotency-key.ts) — P175 proved this exact under Node and compiled to Hermes bytecode,
 * but never EXECUTED it on Hermes (output_175.txt WARNINGS §1). This is that execution.
 */

export interface RuntimeProofResult {
  pass: number
  fail: number
  engine: string
  lines: string[]
}

interface HermesGlobal {
  HermesInternal?: { getRuntimeProperties?: () => Record<string, unknown> }
}

export function describeEngine(): string {
  const hermes = (globalThis as HermesGlobal).HermesInternal
  if (hermes === undefined || hermes === null) return 'not-hermes'
  const props = hermes.getRuntimeProperties?.() ?? {}
  const version = props['OSS Release Version'] ?? props['Build']
  return `hermes ${typeof version === 'string' ? version : 'unknown-version'}`
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

export function runRuntimeProof(): RuntimeProofResult {
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
        `FAIL ${name} expected=${JSON.stringify(expected)} actual=${JSON.stringify(
          typeof actual === 'bigint' ? `${actual}n` : actual,
        )}`,
      )
    }
  }

  for (const v of MONEY_VECTORS) {
    check(
      `format ${v.name}`,
      formatMoney({ minorUnits: v.minor, currency: v.currency }),
      v.expected,
    )
  }
  check('format null is a dash, not zero', formatMoney(null), ABSENT)
  check('format undefined is a dash', formatMoney(undefined), ABSENT)

  check('runtime has BigInt', typeof BigInt, 'function')
  check('2^53+1 exact as bigint', String(2n ** 53n + 1n), '9007199254740993')
  check(
    'Number() loses 2^53+1 (documents why money never uses it)',
    String(Number(2n ** 53n + 1n)),
    '9007199254740992',
  )
  check('3 x (2^58+1) exact', String(3n * (2n ** 58n + 1n)), '864691128455135235')

  // Wire parser: the transport contract is a decimal string; null stays null, "0" stays zero.
  check('wire null -> null', parseMinorUnitsWire(null, 'v'), null)
  check('wire "0" -> 0n (zero is not absence)', parseMinorUnitsWire('0', 'v') === 0n, true)
  check(
    'wire "9007199254740993" exact',
    parseMinorUnitsWire('9007199254740993', 'v') === 2n ** 53n + 1n,
    true,
  )
  check(
    'wire "288230376151711745" exact (2^58+1)',
    parseMinorUnitsWire('288230376151711745', 'v') === 2n ** 58n + 1n,
    true,
  )
  check(
    'wire "-9007199254740993" exact',
    parseMinorUnitsWire('-9007199254740993', 'v') === -(2n ** 53n + 1n),
    true,
  )
  check(
    'wire "" refused (not 0)',
    throws(() => parseMinorUnitsWire('', 'v')),
    true,
  )
  check(
    'wire unsafe JSON number refused',
    throws(() => parseMinorUnitsWire(2 ** 53 + 2, 'v')),
    true,
  )
  check('wire safe JSON number accepted', parseMinorUnitsWire(12345, 'v') === 12345n, true)

  // Raw-body scan before JSON.parse: what JSON.parse would silently round must be found first.
  check(
    'JSON.parse rounds an unquoted 2^53+1',
    String((JSON.parse('{"v":9007199254740993}') as { v: number }).v),
    '9007199254740992',
  )
  check(
    'scan finds unquoted 2^53+1',
    findUnsafeIntegerLiteral('{"v":9007199254740993}'),
    '9007199254740993',
  )
  check(
    'scan finds unquoted negative',
    findUnsafeIntegerLiteral('{"v":-288230376151711745}'),
    '-288230376151711745',
  )
  check('scan passes quoted 2^58+1', findUnsafeIntegerLiteral('{"v":"288230376151711745"}'), null)
  check('scan passes null money', findUnsafeIntegerLiteral('{"v":null,"w":0}'), null)
  const parsed = JSON.parse('{"market_value_minor":"288230376151711745","cost_minor":null}') as {
    market_value_minor: string
    cost_minor: string | null
  }
  check(
    'quoted 2^58+1 survives JSON.parse byte-for-byte',
    parsed.market_value_minor,
    '288230376151711745',
  )
  check('null cost survives JSON.parse as null', parsed.cost_minor, null)
  const yen = parseMinorUnitsWire('9007199254740993', 'v')
  check(
    'JPY 2^53+1 via wire + formatter',
    formatMoney(yen === null ? null : { minorUnits: yen, currency: 'JPY' }),
    '9,007,199,254,740,993 JPY',
  )

  // P177: the WRITE-side boundary, executed for real on this device's engine (see file header).
  check('write: blank nullable amount -> null, not 0', parseNullableMoneyInput('', 'NOK'), null)
  check('write: explicit zero -> known 0n', parseNullableMoneyInput('0', 'NOK'), 0n)
  check(
    'write: 2^53+1 exact via decimal string',
    parseNullableMoneyInput('90071992547409.93', 'NOK'),
    2n ** 53n + 1n,
  )
  check(
    'write: 2^58+1 exact via decimal string',
    parseNullableMoneyInput('2882303761517117.45', 'NOK'),
    2n ** 58n + 1n,
  )
  check('write: NOK 2 decimals', parseNullableMoneyInput('45.67', 'NOK'), 4567n)
  check('write: EUR 2 decimals', parseNullableMoneyInput('45.67', 'EUR'), 4567n)
  check('write: USD 2 decimals', parseNullableMoneyInput('45.67', 'USD'), 4567n)
  check('write: GBP 2 decimals', parseNullableMoneyInput('45.67', 'GBP'), 4567n)
  check('write: JPY has no fractional minor unit', parseNullableMoneyInput('12345', 'JPY'), 12345n)
  check(
    'write: JPY fraction rejected, not rounded',
    throws(() => parseNullableMoneyInput('12345.5', 'JPY')),
    true,
  )
  check(
    'write: string -> minor units exact (comma separator)',
    parseNullableMoneyInput('100,50', 'NOK'),
    10050n,
  )
  check(
    'write: minor units -> wire decimal string exact (2^58+1)',
    serializeMinorUnits(2n ** 58n + 1n),
    '288230376151711745',
  )
  check(
    'write: moneyArg is a decimal string, not a JSON number, and round-trips exactly',
    BigInt(String(moneyArg(2n ** 58n + 1n))),
    2n ** 58n + 1n,
  )
  check(
    'write: requireKnownAmount(blank) throws, never defaults to 0',
    throws(() => requireKnownAmount('', 'NOK', 'required')),
    true,
  )
  check(
    'write: parseOptionalChargeInput(blank) is 0n BY NAME (not the nullable parser)',
    parseOptionalChargeInput('', 'NOK'),
    0n,
  )
  check(
    'write: idempotency key is UUID-shaped, two calls differ',
    /^[0-9a-f-]{36}$/i.test(generateIdempotencyKey()) &&
      generateIdempotencyKey() !== generateIdempotencyKey(),
    true,
  )

  // P180: the FX boundary for a non-NOK write (write/fx-for-write.ts) — the same exact bigint
  // conversion `money_minor_to_nok_minor` performs server-side (P133), executed here on whatever
  // engine runs this proof. `fxRateToNok` is always "NOK per ONE MAJOR unit of the source currency"
  // (FINANCIAL_MODEL.md §7); every expected value below was independently computed once via
  // src/domain/fx.ts's own `convert` under Node and is asserted exactly, not re-derived here.
  const readyState = (rateToNok: string): FxWriteState => ({
    kind: 'ready',
    rateToNok,
    rateDate: '2026-09-27',
    source: 'norges_bank',
    stale: false,
  })
  check(
    'fx: JPY (exponent 0), amount 2^53+1, exact NOK conversion',
    nokReferenceForWrite({ minorUnits: 2n ** 53n + 1n, currency: 'JPY' }, readyState('0.065'))
      ?.minorUnits,
    58546795155816455n,
  )
  check(
    'fx: EUR minor amount 2^53+1, exact NOK conversion',
    nokReferenceForWrite({ minorUnits: 2n ** 53n + 1n, currency: 'EUR' }, readyState('11.5'))
      ?.minorUnits,
    103582791429521420n,
  )
  check(
    'fx: USD minor amount 2^53+1, exact NOK conversion',
    nokReferenceForWrite({ minorUnits: 2n ** 53n + 1n, currency: 'USD' }, readyState('10.5'))
      ?.minorUnits,
    94575592174780427n,
  )
  check(
    'fx: GBP 123.45 at 13.25 -> exact NOK',
    nokReferenceForWrite({ minorUnits: 12345n, currency: 'GBP' }, readyState('13.25'))?.minorUnits,
    163571n,
  )
  check(
    'fx: NOK never needs a rate (not_needed, always submittable)',
    fxWriteIsSubmittable({ kind: 'not_needed' }),
    true,
  )
  check(
    'fx: half-up (away from zero) tie-break, 0.01 EUR @ 0.5 -> 1 øre, not 0',
    nokReferenceForWrite({ minorUnits: 1n, currency: 'EUR' }, readyState('0.5'))?.minorUnits,
    1n,
  )
  check(
    'fx: half-up (away from zero) tie-break, 0.03 EUR @ 0.5 -> 2 øre',
    nokReferenceForWrite({ minorUnits: 3n, currency: 'EUR' }, readyState('0.5'))?.minorUnits,
    2n,
  )
  check(
    'fx: missing rate stays missing — never a fabricated NOK reference',
    nokReferenceForWrite({ minorUnits: 100n, currency: 'EUR' }, { kind: 'missing' }),
    null,
  )
  check(
    'fx: missing state is never submittable — fail closed',
    fxWriteIsSubmittable({ kind: 'missing' }),
    false,
  )

  return { pass, fail, engine: describeEngine(), lines }
}

/** Logs every line with a filterable prefix; the last line is the verdict. */
export function runAndLogRuntimeProof(
  log: (line: string) => void = console.log,
): RuntimeProofResult {
  const result = runRuntimeProof()
  for (const line of result.lines) log(`P166_PROOF ${line}`)
  log(`P166_PROOF RESULT pass=${result.pass} fail=${result.fail} engine=${result.engine}`)
  return result
}
