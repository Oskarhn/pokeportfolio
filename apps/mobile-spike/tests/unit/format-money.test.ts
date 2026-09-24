import { formatMoney, formatMoneyBody, ABSENT } from '../../src/money/format-money'
import { formatCurrencyMinor, formatNokMinor } from '@shared/ui/money-format'
import type { CurrencyCode } from '@shared/domain/currency'

const NB_SPACE = ' '
const MINUS = '−'
const P53 = 2n ** 53n

/** Hand-written expectations: the formatter is checked against literals, not against itself. */
const VECTORS: { name: string; minor: bigint; currency: CurrencyCode; expected: string }[] = [
  { name: 'zero NOK', minor: 0n, currency: 'NOK', expected: '0,00 kr' },
  { name: 'one krone', minor: 100n, currency: 'NOK', expected: '1,00 kr' },
  { name: 'NOK two decimals', minor: 123456n, currency: 'NOK', expected: `1${NB_SPACE}234,56 kr` },
  { name: 'minus one øre', minor: -1n, currency: 'NOK', expected: `${MINUS}0,01 kr` },
  {
    name: 'negative 2^53+1',
    minor: -(P53 + 1n),
    currency: 'NOK',
    expected: `${MINUS}90${NB_SPACE}071${NB_SPACE}992${NB_SPACE}547${NB_SPACE}409,93 kr`,
  },
  {
    name: 'positive 2^53+1',
    minor: P53 + 1n,
    currency: 'NOK',
    expected: `90${NB_SPACE}071${NB_SPACE}992${NB_SPACE}547${NB_SPACE}409,93 kr`,
  },
  {
    name: '2^58+1 scale',
    minor: 2n ** 58n + 1n,
    currency: 'NOK',
    expected: `2${NB_SPACE}882${NB_SPACE}303${NB_SPACE}761${NB_SPACE}517${NB_SPACE}117,45 kr`,
  },
  { name: 'EUR two decimals', minor: 123456n, currency: 'EUR', expected: '€1,234.56' },
  { name: 'USD two decimals', minor: 5n, currency: 'USD', expected: '$0.05' },
  { name: 'negative EUR', minor: -100n, currency: 'EUR', expected: '-€1.00' },
  { name: 'JPY zero decimals', minor: 12345n, currency: 'JPY', expected: '12,345 JPY' },
  { name: 'JPY 1 is one yen, not 0.01', minor: 1n, currency: 'JPY', expected: '1 JPY' },
  {
    name: 'JPY above 2^53',
    minor: P53 + 1n,
    currency: 'JPY',
    expected: '9,007,199,254,740,993 JPY',
  },
  { name: 'JPY zero', minor: 0n, currency: 'JPY', expected: '0 JPY' },
]

describe('formatMoney', () => {
  it.each(VECTORS)('$name', ({ minor, currency, expected }) => {
    expect(formatMoney({ minorUnits: minor, currency })).toBe(expected)
  })

  it('renders an ABSENT amount as a dash, never as zero', () => {
    expect(formatMoney(null)).toBe(ABSENT)
    expect(formatMoney(undefined)).toBe(ABSENT)
    expect(formatMoney(null)).not.toContain('0')
    expect(formatMoney({ minorUnits: 0n, currency: 'NOK' })).toBe('0,00 kr')
  })

  it('does not lose the digits of an amount above 2^53 (the Number() failure this replaces)', () => {
    const exact = formatMoney({ minorUnits: P53 + 1n, currency: 'NOK' })
    const viaNumber = (Number(P53 + 1n) / 100).toFixed(2)
    expect(exact.replace(/[^0-9]/g, '')).toBe('9007199254740993' + '')
    expect(viaNumber.replace(/[^0-9]/g, '')).not.toBe('9007199254740993')
  })
})

/** Deterministic PRNG so a failure is reproducible. */
function* randoms(seed: bigint): Generator<bigint> {
  let s = seed
  for (;;) {
    s = (s * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n
    yield s
  }
}

describe('parity with the web app Intl-based formatter (src/ui/money-format.ts)', () => {
  const values: bigint[] = [
    0n,
    1n,
    -1n,
    99n,
    100n,
    101n,
    P53 - 1n,
    P53,
    P53 + 1n,
    -(P53 + 1n),
    2n ** 58n,
    2n ** 62n - 1n,
    -(2n ** 62n),
  ]
  const gen = randoms(158n)
  for (let i = 0; i < 2000; i += 1) {
    const raw = gen.next().value as bigint
    const width = BigInt((i % 19) + 1)
    const v = raw % 10n ** width
    values.push(i % 2 === 0 ? v : -v)
  }

  it('NOK digits, grouping and signs equal formatNokMinor for 2000+ values', () => {
    for (const v of values) expect(formatMoneyBody(v, 'NOK', 'nb-NO')).toBe(formatNokMinor(v))
  })

  it.each(['EUR', 'USD', 'GBP', 'JPY'] as const)(
    '%s digits equal formatCurrencyMinor for 2000+ values',
    (currency) => {
      for (const v of values) {
        const web = formatCurrencyMinor(v, currency)
        const ours = formatMoney({ minorUnits: v, currency })
        const bodyWeb = web.replace(/^[€$£]/, '').replace(new RegExp(` ${currency}$`), '')
        const bodyOurs = ours.replace(/^-?[€$£]/, '').replace(new RegExp(` ${currency}$`), '')
        // The web output puts the minus after the symbol ("€-1.00"); ours before ("-€1.00"). The
        // magnitude and the sign are compared separately.
        expect(bodyOurs.replace('-', '')).toBe(bodyWeb.replace('-', ''))
        expect(ours.includes('-')).toBe(web.includes('-'))
      }
    },
  )
})
