import { createExactTransportFetch } from './exact-transport-guard'

/**
 * The fetch every request of the spike goes through: a read-only request policy, then the exact
 * transport guard, then a typed error for non-2xx data-API responses.
 *
 * READ-ONLY POLICY. The spike has no feature that writes financial data, so the client refuses to
 * send one: only GETs, the GoTrue token/logout endpoints, and POSTs to an allow-list of READ-ONLY
 * RPCs pass. A future change that made Price Check (or anything else) call an acquisition/purchase
 * RPC would be refused here at the wire, and the request log (`onRequest`) lets tests assert the
 * exact set of calls a flow made. This is a spike guard, NOT a Production security boundary: RLS and
 * the database remain the authority. SPIKE_ONLY.
 *
 * STATUS ERRORS. The shared data wrappers reduce a PostgREST error to `new Error(error.message)`,
 * which loses the HTTP status, so 401 and 500 could not be told apart by the UI. For `/rest/v1/`
 * responses that are not 2xx this fetch therefore throws an {@link HttpStatusError}; postgrest-js
 * turns a thrown fetch error into `{ error: { message: "<name>: <message>" } }` and the wrapper
 * rethrows that message, so {@link classifyFailure} recovers the status from it. `/auth/v1/`
 * responses are passed through untouched (auth-js parses its own error bodies).
 */

export const READ_ONLY_RPCS: ReadonlySet<string> = new Set([
  'list_portfolio',
  'portfolio_counts',
  'search_cards',
  'get_holding_value_provenance',
  'get_card_variant_price_history',
])

export class WriteRefusedError extends Error {
  readonly code = 'write_refused'
  constructor(method: string, path: string) {
    super(`the spike is read-only: refusing ${method} ${path}`)
    this.name = 'WriteRefusedError'
  }
}

export class HttpStatusError extends Error {
  readonly status: number
  readonly path: string
  constructor(status: number, path: string, detail: string) {
    super(`HTTP ${String(status)}${detail === '' ? '' : ` ${detail}`}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.path = path
  }
}

export interface RequestLogEntry {
  method: string
  path: string
}

function pathOf(url: string): string {
  const match = /^[a-z]+:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url)
  return match?.[1] ?? '/'
}

/** Throws {@link WriteRefusedError} unless the request is allowed by the read-only policy. */
export function assertReadOnlyRequest(method: string, url: string): void {
  const upper = method.toUpperCase()
  const path = pathOf(url)
  if (upper === 'GET' || upper === 'HEAD') return
  if (upper === 'POST') {
    if (path === '/auth/v1/token' || path === '/auth/v1/logout') return
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(path)
    if (rpc?.[1] !== undefined && READ_ONLY_RPCS.has(rpc[1])) return
  }
  throw new WriteRefusedError(upper, path)
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (typeof (input as { href?: unknown }).href === 'string') return (input as URL).href
  return (input as Request).url
}

function methodOf(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string {
  if (init?.method !== undefined) return init.method
  if (typeof input !== 'string' && typeof (input as Request).method === 'string') {
    return (input as Request).method
  }
  return 'GET'
}

export interface SpikeFetchOptions {
  /** Called once per request that passed the read-only policy. */
  onRequest?: (entry: RequestLogEntry) => void
}

export function createSpikeFetch(
  base: typeof fetch,
  options: SpikeFetchOptions = {},
): typeof fetch {
  const guarded = createExactTransportFetch(base)
  return async (input, init) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    assertReadOnlyRequest(method, url)
    const path = pathOf(url)
    options.onRequest?.({ method: method.toUpperCase(), path })
    const response = await guarded(input, init)
    if (!response.ok && path.startsWith('/rest/v1/')) {
      let detail = ''
      try {
        const body = JSON.parse(await response.text()) as { code?: unknown; message?: unknown }
        detail = [body.code, body.message].filter((v) => typeof v === 'string').join(' ')
      } catch {
        // a non-JSON error body: the status alone is the signal
      }
      throw new HttpStatusError(response.status, path, detail)
    }
    return response
  }
}
