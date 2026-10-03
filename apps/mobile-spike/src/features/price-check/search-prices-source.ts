import type { CardPriceResponse } from './p165-domain/price-check/raw-section'
import { PriceLookupError, abortError, type LookupFailureReason } from './model'

/**
 * Transport for the `search-prices` Edge Function, native side. The function is the only provider
 * relay; it persists nothing (a search never becomes price history) and needs a signed-in session
 * (verify_jwt). It is invoked through the ONE native Supabase client (`supabase.functions.invoke`),
 * so every byte passes the client's read-only request policy and exact-transport guard
 * (src/net/spike-fetch.ts): the guard REFUSES a response containing an unquoted integer a JS number
 * cannot hold, before JSON.parse can round it.
 *
 * This is the native counterpart of P165's `fetchCardPriceResponse` (src/data/price-check.ts, which
 * cannot run here: it imports the web client and P149's unreleased exact-json-guard). Same request
 * (ONE card per call, so `providerErrorCount > 0` can only mean this card failed), same result
 * shape (`CardPriceResponse`, consumed by the vendored P165 `buildRawSection`), and the same D-164
 * rule: a response whose numbers were REWRITTEN by an exact-transport guard is refused, not trusted.
 * The native guard never rewrites (it refuses), so the header check only matters once P149's
 * quoting guard replaces it; it is kept so that swap cannot silently weaken this path.
 */

export const SEARCH_PRICES_FUNCTION = 'search-prices'
/** P149 `EXACT_TRANSPORT_REWRITE_HEADER` (src/data/exact-json-guard.ts on the P165 candidate). */
export const EXACT_TRANSPORT_REWRITE_HEADER = 'x-exact-transport-rewritten'

export interface SearchPricesInvoker {
  (
    name: typeof SEARCH_PRICES_FUNCTION,
    options: { body: { cardIds: string[]; useEuPricing: boolean }; signal?: AbortSignal },
  ): Promise<{
    data: unknown
    error: unknown
    response?: { headers: { get(name: string): string | null } } | undefined
  }>
}

/** Same mapping as P165's `reasonForStatus`. */
export function reasonForStatus(status: number): LookupFailureReason {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  return 'provider_error'
}

function nameOf(value: unknown): string {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
    ? (value as { name: string }).name
    : ''
}

/**
 * functions-js reports a failed invoke as a value, not a throw:
 *   FunctionsHttpError  - non-2xx; `context` is the Response (status known)
 *   FunctionsRelayError - the platform relay failed
 *   FunctionsFetchError - fetch itself rejected; `context` is what our fetch threw. That includes
 *                         the exact-transport guard's refusal and the read-only policy's refusal,
 *                         which must NOT be reported as "offline".
 */
export function classifyInvokeError(error: unknown): LookupFailureReason {
  const name = nameOf(error)
  const context = (error as { context?: unknown } | null)?.context
  if (name === 'FunctionsHttpError') {
    const status = (context as { status?: unknown } | null)?.status
    return typeof status === 'number' ? reasonForStatus(status) : 'provider_error'
  }
  if (name === 'FunctionsRelayError') return 'provider_error'
  const inner = name === 'FunctionsFetchError' ? nameOf(context) : name
  if (inner === 'UnsafeNumericResponseError' || inner === 'UnsafeNumericRequestError') {
    return 'malformed_response'
  }
  if (inner === 'WriteRefusedError') return 'write_refused'
  if (name === 'FunctionsFetchError' || inner === 'TypeError') return 'network'
  return 'unknown'
}

/** A function, not an inline `signal?.aborted` test: the flag flips asynchronously and an inline
 *  re-check after an `await` would be narrowed away by the compiler (same helper as P165). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export async function fetchSearchPricesResponse(
  cardId: string,
  options: { invoke: SearchPricesInvoker; signal?: AbortSignal; now: () => number },
): Promise<CardPriceResponse> {
  const { invoke, signal, now } = options
  if (isAborted(signal)) throw abortError()

  let invoked: Awaited<ReturnType<SearchPricesInvoker>>
  try {
    invoked = await invoke(SEARCH_PRICES_FUNCTION, {
      // `useEuPricing` only picks the legacy headline; the observations carry every provider.
      body: { cardIds: [cardId], useEuPricing: true },
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (error) {
    if (isAborted(signal)) throw abortError()
    throw new PriceLookupError(classifyInvokeError(error))
  }
  if (isAborted(signal)) throw abortError()

  if (invoked.error !== null && invoked.error !== undefined) {
    throw new PriceLookupError(classifyInvokeError(invoked.error))
  }
  if (invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER) != null) {
    throw new PriceLookupError('malformed_response', 'response numbers were rewritten in transit')
  }

  const body = invoked.data as {
    ok?: unknown
    results?: unknown
    providerErrorCount?: unknown
  } | null
  if (
    body === null ||
    typeof body !== 'object' ||
    body.ok !== true ||
    !Array.isArray(body.results)
  ) {
    throw new PriceLookupError('malformed_response')
  }
  const errorCount =
    typeof body.providerErrorCount === 'number' && Number.isFinite(body.providerErrorCount)
      ? body.providerErrorCount
      : 0

  return {
    fetchedAt: new Date(now()).toISOString(),
    rows: body.results as unknown[],
    providerErrorCount: errorCount,
  }
}
