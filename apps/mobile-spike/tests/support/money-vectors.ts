import type { CurrencyCode } from '@shared/domain/currency'

/**
 * Hand-written expectations for the native money formatter. ONE source, two consumers: the Jest test
 * (tests/unit/format-money.test.ts) and the engine-neutral proof bundle (scripts/hermes-money-proof.mjs),
 * which compiles the same formatter with hermesc and can be run under Hermes once a runtime exists.
 */
export const NB_SPACE = ' '
export const MINUS = '−'
export const P53 = 2n ** 53n

/** Hand-written expectations: the formatter is checked against literals, not against itself. */
export const MONEY_VECTORS: {
  name: string
  minor: bigint
  currency: CurrencyCode
  expected: string
}[] = [
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
