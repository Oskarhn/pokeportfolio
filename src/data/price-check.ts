import { supabase } from './supabase-client'
import { EXACT_TRANSPORT_REWRITE_HEADER } from './exact-json-guard'
import { isSupportedCurrencyCode, type CurrencyCode } from '../domain/currency'
import { parseFxRate, type FxRateParse } from '../domain/price-check/fx'
import type { CardPriceResponse } from '../domain/price-check/raw-section'
import type { UnavailableReason } from '../domain/price-check/types'

/**
 * How long a price lookup may take before the client gives up on it. The function's own provider
 * budget is 12 s; anything past this is a stuck request, and without a bound the page shows its
 * loading state until the platform closes the connection (minutes). The caller's own abort signal
 * still wins and is never reported as a timeout.
 */
export const PRICE_LOOKUP_TIMEOUT_MS = 20_000

/**
 * Read-only data access for Price Check (P153). The ONLY things this module talks to are:
 *   - the `search-prices` Edge Function (non-persisting: a search never becomes history, see
 *     src/data/pricing.ts and DATA_MODEL.md §4.2), and
 *   - the shared `fx_rates` market-data table (a plain SELECT).
 * Nothing here calls an RPC, inserts, updates or deletes; `tests/ui/price-check-read-only.test.ts`
 * fails if a write-capable call, or an import of a ledger data module, ever appears in Price Check
 * code. Catalog reads (search, card, variants) reuse `./catalog` unchanged.
 *
 * Unlike `searchPrices` in ./pricing.ts — which deliberately swallows every failure into an empty
 * map because pricing there is a secondary enhancement — Price Check IS the price feature, so a
 * failure must be told apart from "the provider has no price": every failure mode is a typed
 * `PriceCheckError` carrying the reason the UI names.
 */

export class PriceCheckError extends Error {
  readonly reason: UnavailableReason

  constructor(reason: UnavailableReason, message?: string) {
    super(message ?? reason)
    this.name = 'PriceCheckError'
    this.reason = reason
  }
}

/** A function, not an inline `signal?.aborted` test: the flag flips asynchronously, and inline
 *  re-checks after an `await` would be narrowed away by the compiler. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortError(): Error {
  const error = new Error('Price lookup was cancelled')
  error.name = 'AbortError'
  return error
}

/** Same reasons the edge function's platform can return, mapped from an HTTP status. */
export function reasonForStatus(status: number): UnavailableReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  return 'provider_error'
}

/**
 * Invocation seam. Production passes the real `supabase.functions.invoke`; tests inject a fake so
 * the classification of every failure mode is exercised without a network.
 */
export interface SearchPricesInvoker {
  (
    name: 'search-prices',
    options: { body: { cardIds: string[]; useEuPricing: boolean }; signal?: AbortSignal },
  ): Promise<{
    data: unknown
    error: unknown
    /** supabase-js hands the (guard-produced) Response back; only its headers are read here. */
    response?: { headers: { get(name: string): string | null } }
  }>
}

const realInvoker: SearchPricesInvoker = (name, options) => supabase.functions.invoke(name, options)

/**
 * Fetches the provider prices for ONE catalog card (all of its variants come back in one
 * response). One card per call keeps the failure accounting exact: `providerErrorCount > 0`
 * can only mean this card's lookup failed.
 */
export async function fetchCardPriceResponse(
  cardId: string,
  options: {
    signal?: AbortSignal
    invoke?: SearchPricesInvoker
    now?: () => number
    timeoutMs?: number
  } = {},
): Promise<CardPriceResponse> {
  const {
    signal,
    invoke = realInvoker,
    now = Date.now,
    timeoutMs = PRICE_LOOKUP_TIMEOUT_MS,
  } = options
  if (isAborted(signal)) throw abortError()

  // One controller for the request: it aborts when the caller aborts OR when the lookup times out.
  // Which of the two happened is tracked explicitly, because the caller's cancellation must stay a
  // silent AbortError and only a timeout is a user-visible failure.
  const controller = new AbortController()
  const lookup = { timedOut: false }
  const onCallerAbort = () => {
    controller.abort()
  }
  signal?.addEventListener('abort', onCallerAbort)
  const timer = setTimeout(() => {
    lookup.timedOut = true
    controller.abort()
  }, timeoutMs)

  let invoked: Awaited<ReturnType<SearchPricesInvoker>>
  try {
    invoked = await invoke('search-prices', {
      // `useEuPricing` only picks the legacy headline; Price Check reads `observations`, which
      // carries both providers regardless.
      body: { cardIds: [cardId], useEuPricing: true },
      signal: controller.signal,
    })
  } catch (error) {
    if (isAborted(signal)) throw abortError()
    if (lookup.timedOut) throw new PriceCheckError('timeout')
    throw new PriceCheckError('network', error instanceof Error ? error.message : undefined)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
  if (isAborted(signal)) throw abortError()
  if (lookup.timedOut) throw new PriceCheckError('timeout')

  if (invoked.error !== null && invoked.error !== undefined) {
    const context = (invoked.error as { context?: unknown } | null)?.context
    const status =
      typeof context === 'object' && context !== null && 'status' in context
        ? Number(context.status)
        : null
    if (status !== null && Number.isFinite(status))
      throw new PriceCheckError(reasonForStatus(status))
    throw new PriceCheckError('network')
  }

  // The exact-transport guard (D-137) quotes any bare JSON integer a JavaScript number cannot hold,
  // and a quoted 16-18 digit string is a valid `valueMinor`. A price must arrive as a string ON THE
  // WIRE: a rewrite means the function (or a provider behind it) emitted a rounded number, and the
  // digits that reach the parser are no longer evidence of what the source said. Refuse the whole
  // response rather than choose which fields to trust (D-164).
  if (invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER) != null) {
    throw new PriceCheckError('malformed_response')
  }

  const body = invoked.data as {
    ok?: unknown
    results?: unknown
    providerErrorCount?: unknown
    providerFailures?: unknown
  } | null
  if (
    body === null ||
    typeof body !== 'object' ||
    body.ok !== true ||
    !Array.isArray(body.results)
  ) {
    throw new PriceCheckError('malformed_response')
  }
  const errorCount =
    typeof body.providerErrorCount === 'number' && Number.isFinite(body.providerErrorCount)
      ? body.providerErrorCount
      : 0

  return {
    fetchedAt: new Date(now()).toISOString(),
    rows: body.results as unknown[],
    providerErrorCount: errorCount,
    providerFailures: parseProviderFailures(body.providerFailures),
  }
}

/** The failure classes the function reports: own, finite, non-negative integer counts only. */
export function parseProviderFailures(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) out[key] = count
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Minimal shape of the `fx_rates` query so it can be faked in tests. */
export interface FxRateReader {
  (currency: string): Promise<{
    data: { rate: unknown; rate_date: unknown } | null
    error: { message: string } | null
  }>
}

const realFxReader: FxRateReader = async (currency) => {
  const { data, error } = await supabase
    .from('fx_rates')
    .select('rate, rate_date')
    .eq('base_currency', currency)
    .eq('quote_currency', 'NOK')
    .eq('source', 'norges_bank')
    .order('rate_date', { ascending: false })
    .limit(1)
    .maybeSingle()
  return { data, error }
}

/**
 * Latest cached Norges Bank rate for `currency` → NOK (NOK per ONE major unit, P136 canonical
 * semantics). A currency with no cached rate is `{ ok: false, reason: 'missing' }` — the caller
 * shows the original source currency and never invents a NOK figure. A read error throws so the
 * UI can distinguish "no rate exists" from "rate lookup failed".
 */
export async function getLatestFxRate(
  currency: CurrencyCode,
  read: FxRateReader = realFxReader,
): Promise<FxRateParse> {
  if (currency === 'NOK' || !isSupportedCurrencyCode(currency)) {
    return { ok: false, reason: 'missing' }
  }
  const { data, error } = await read(currency)
  if (error !== null) throw new PriceCheckError('provider_error', error.message)
  if (data === null) return { ok: false, reason: 'missing' }
  return parseFxRate(data.rate, data.rate_date)
}

/**
 * Query keys. Every key is built from stable catalog ids and the exact provider/currency it is
 * about — never a card name (many cards share one) and never anything account-specific. The whole
 * react-query cache is cleared on every identity change (src/auth/query-cache-boundary.ts), so
 * even this account-independent market data cannot cross an account switch.
 *
 * The raw key is per CARD + provider relay, not per variant: one upstream response covers every
 * variant of a card, and a per-variant key would multiply provider calls for the same payload.
 * The variant, price metric and currency dimensions live inside the cached value, keyed exactly.
 */
export const priceCheckKeys = {
  raw: (cardId: string) => ['price-check', 'raw', 'tcgdex-relay', cardId] as const,
  fx: (currency: string) => ['price-check', 'fx', currency, 'NOK'] as const,
}

/** Bounded freshness of the client cache: the provider itself refreshes about daily, so five
 *  minutes never hides a real update — and a cached hit keeps the ORIGINAL `fetchedAt`. */
export const PRICE_CHECK_STALE_TIME_MS = 5 * 60 * 1000
export const PRICE_CHECK_GC_TIME_MS = 10 * 60 * 1000
export const FX_STALE_TIME_MS = 60 * 60 * 1000
