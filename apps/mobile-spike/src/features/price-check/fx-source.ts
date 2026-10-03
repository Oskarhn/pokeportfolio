import { isSupportedCurrencyCode, type CurrencyCode } from '@shared/domain/currency'
import { parseFxRate, type FxRateParse } from './p165-domain/price-check/fx'
import { PriceLookupError } from './model'

/**
 * Latest cached Norges Bank rate for a currency -> NOK, read with a plain SELECT on the shared
 * `fx_rates` market-data table (a GET: allowed by the read-only policy). Semantics are P165's
 * `getLatestFxRate` (src/data/price-check.ts): NOK per ONE major unit (P136); a currency without a
 * cached rate is `missing`, a value that is not a plain positive decimal is `malformed`, and a read
 * error THROWS so "no rate exists" and "the rate could not be read" stay distinguishable. No rate is
 * ever invented: without one the source currency is shown and the NOK reference is unavailable.
 */

export interface FxRateReader {
  (currency: CurrencyCode): Promise<{
    data: { rate: unknown; rate_date: unknown } | null
    error: { message: string } | null
  }>
}

/** Deliberately minimal: the full SupabaseClient<Database> type is too deep to match structurally. */
interface FxQueryClient {
  from(table: 'fx_rates'): unknown
}

interface FxChain {
  eq(column: string, value: string): FxChain
  order(column: string, options: { ascending: boolean }): FxChain
  limit(n: number): FxChain
  maybeSingle(): PromiseLike<{
    data: { rate: unknown; rate_date: unknown } | null
    error: { message: string } | null
  }>
}

/** The reader over a Supabase client (the app's one native client, or a test's real client). */
export function fxRateReaderFor(client: FxQueryClient): FxRateReader {
  return async (currency) => {
    const chain = (client.from('fx_rates') as { select(columns: string): FxChain }).select(
      'rate, rate_date',
    )
    return chain
      .eq('base_currency', currency)
      .eq('quote_currency', 'NOK')
      .eq('source', 'norges_bank')
      .order('rate_date', { ascending: false })
      .limit(1)
      .maybeSingle()
  }
}

export async function readLatestFxRate(
  currency: CurrencyCode,
  read: FxRateReader,
): Promise<FxRateParse> {
  if (currency === 'NOK' || !isSupportedCurrencyCode(currency))
    return { ok: false, reason: 'missing' }
  const { data, error } = await read(currency)
  if (error !== null) throw new PriceLookupError('provider_error', 'fx rate read failed')
  if (data === null) return { ok: false, reason: 'missing' }
  return parseFxRate(data.rate, data.rate_date)
}
