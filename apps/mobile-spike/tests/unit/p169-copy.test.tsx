import { render, screen } from '@testing-library/react-native'
import {
  CONTRACT_COPY,
  UNAVAILABLE_COPY,
  nokText,
  observedText,
} from '../../src/features/price-check/price-copy'
import { ExactMoney } from '../../src/features/ui/kit'

/** The words that carry honesty: freshness, FX provenance, absence. */

describe('P169 copy', () => {
  it('freshness is always named, and an old price is never presented as current', () => {
    expect(observedText('2026-09-15T12:00:00Z', 10, 'stale')).toBe(
      'Provider updated 2026-09-15 (10 days ago) · Stale',
    )
    expect(observedText('2026-08-11T12:00:00Z', 45, 'outdated')).toMatch(
      /Outdated — not a current price$/,
    )
    expect(observedText(null, null, 'unknown')).toBe(
      'Provider did not say when this was observed · Age unknown',
    )
  })

  it('a NOK reference names its rate and date; without a rate it says so', () => {
    const converted = {
      nok: {
        status: 'converted' as const,
        nok: { minorUnits: 4830n, currency: 'NOK' as const },
        rate: { rateToNok: '11.5', rateDate: '2026-09-25' },
      },
      fxRateStale: true,
      fxReadFailed: false,
    }
    expect(nokText(converted)).toBe(
      'NOK reference at 11.5 NOK per unit (Norges Bank, 2026-09-25) — the rate is more than a week old',
    )
    expect(
      nokText({
        nok: { status: 'unavailable', reason: 'fx_missing' },
        fxRateStale: false,
        fxReadFailed: false,
      }),
    ).toMatch(/no exchange rate is available/)
    expect(
      nokText({
        nok: { status: 'unavailable', reason: 'fx_missing' },
        fxRateStale: false,
        fxReadFailed: true,
      }),
    ).toMatch(/could not be read/)
  })

  it('failures and partial coverage say what they are', () => {
    expect(UNAVAILABLE_COPY.provider_error).toMatch(/not a price of zero/)
    expect(UNAVAILABLE_COPY.no_variant_price).toMatch(/not a price of zero/)
    expect(UNAVAILABLE_COPY.graded_source_not_configured).toBe(
      'No verified graded market data available.',
    )
    expect(CONTRACT_COPY.search_prices_headline_only).toMatch(/^Partial/)
  })

  it('an absent amount renders as the dash, never as a zero', async () => {
    await render(<ExactMoney testID="m" value={null} />)
    expect(screen.getByTestId('m').props.children).toBe('—')
    expect(screen.getByTestId('m').props.accessibilityLabel).toBe('No value')
  })
})
