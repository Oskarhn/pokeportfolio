/**
 * The single write seam's wire policy (P175). Mirrors `net/spike-fetch.ts`'s read-only guard for
 * the OPPOSITE direction: a client built by `write/leased-write-client.ts` may call exactly these
 * RPCs and nothing else. Every other request that client could ever construct — a `.from(...)`
 * table write, a different RPC, a GET — is refused before it reaches the network.
 *
 * This is deliberately its own allow-list, not an extension of `READ_ONLY_RPCS`: the ambient shared
 * client (`seam/supabase-client.ts`) stays exactly as read-only as it was in P173 (mutation #17/#18
 * in the campaign: neither the Add screen nor Price Check may write), and the two policies must
 * never be merged into one "sometimes-write" client that a future screen could reach by accident.
 * `assertWriteRequest` also refuses the auth token/logout endpoints and every GET: a write client
 * built by `createLeasedWriteDb` never touches `client.auth` (its `accessToken` option makes
 * supabase-js throw if anything tries), so a request to `/auth/v1/*` from it would only mean the
 * seam itself has a bug.
 */

export const WRITE_RPCS: ReadonlySet<string> = new Set([
  'add_card_acquisition',
  'set_manual_valuation',
  'clear_manual_valuation',
  'create_purchase',
  'create_sale',
  'create_opening',
])

export class WriteNotAllowedError extends Error {
  readonly code = 'write_not_allowed'
  constructor(method: string, path: string) {
    super(`the write seam refuses ${method} ${path}: not on the finance write allow-list`)
    this.name = 'WriteNotAllowedError'
  }
}

function pathOf(url: string): string {
  const match = /^[a-z]+:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url)
  return match?.[1] ?? '/'
}

/** Throws {@link WriteNotAllowedError} unless the request is exactly one of the allowed RPC calls. */
export function assertWriteRequest(method: string, url: string): void {
  const upper = method.toUpperCase()
  const path = pathOf(url)
  if (upper === 'POST') {
    const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(path)
    if (rpc?.[1] !== undefined && WRITE_RPCS.has(rpc[1])) return
  }
  throw new WriteNotAllowedError(upper, path)
}
