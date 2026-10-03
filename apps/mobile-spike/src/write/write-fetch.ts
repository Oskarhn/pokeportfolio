import { createExactTransportFetch } from '../net/exact-transport-guard'
import { HttpStatusError } from '../net/spike-fetch'
import { assertWriteRequest } from './write-policy'

/**
 * The fetch every request from a {@link import('./leased-write-client').LeasedWriteDb} goes
 * through: the write allow-list, then the exact transport guard, then a typed status error for a
 * non-2xx response — the write-seam counterpart of `net/spike-fetch.ts`. A write client's fetch
 * NEVER also carries the read-only policy: the two are separate instances bound to separate
 * `SupabaseClient`s (see `write/leased-write-client.ts`), so nothing can widen the ambient reading
 * client's own allow-list by editing this file.
 */

export interface RequestLogEntry {
  method: string
  path: string
}

function pathOf(url: string): string {
  const match = /^[a-z]+:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url)
  return match?.[1] ?? '/'
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

export interface WriteFetchOptions {
  /** Called once per request that passed the write allow-list. Tests assert the exact set of RPCs
   *  one logical write actually sent. */
  onRequest?: (entry: RequestLogEntry) => void
}

export function createWriteFetch(
  base: typeof fetch,
  options: WriteFetchOptions = {},
): typeof fetch {
  const guarded = createExactTransportFetch(base)
  return async (input, init) => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    assertWriteRequest(method, url)
    const path = pathOf(url)
    options.onRequest?.({ method: method.toUpperCase(), path })
    const response = await guarded(input, init)
    if (!response.ok) {
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
