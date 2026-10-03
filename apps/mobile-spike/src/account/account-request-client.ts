import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@shared/data/database.types'
import type { AccountDeletionPorts } from './account-deletion-controller'

/**
 * The wire seam of the ACCOUNT LIFECYCLE (P189): one more client with one more allow-list, on purpose.
 *
 * The native app has two deliberately separate wire policies — the shared reading client stays
 * read-only (`net/spike-fetch.ts`: Price Check and browsing can never write) and the finance write
 * client may call exactly the finance RPCs (`write/write-policy.ts`) — and the two must never be
 * merged into one "sometimes-write" client. Account deletion is a third kind of request (it changes
 * no ledger row; it ends the account), so it gets its own client that may send exactly ONE request:
 *
 *     POST /functions/v1/delete-account
 *
 * Found on the emulator, not in unit tests: the first build routed the call through the shared
 * read-only client, which refused it (`WriteRefusedError`) and showed the person "the connection
 * was lost". The client never touches `client.auth` (its `accessToken` option makes supabase-js
 * throw if anything tries) and asks the app's live session for the bearer at request time, like the
 * write seam, so it can never act for an identity other than the one that is signed in.
 */

export class AccountRequestRefusedError extends Error {
  readonly code = 'account_request_refused'
  constructor(method: string, path: string) {
    super(`the account client refuses ${method} ${path}: not on the account allow-list`)
    this.name = 'AccountRequestRefusedError'
  }
}

function pathOf(url: string): string {
  const match = /^[a-z]+:\/\/[^/?#]+(\/[^?#]*)?/i.exec(url)
  return match?.[1] ?? '/'
}

/** Throws {@link AccountRequestRefusedError} unless this is exactly the deletion request. */
export function assertAccountRequest(method: string, url: string): void {
  if (method.toUpperCase() === 'POST' && pathOf(url) === '/functions/v1/delete-account') return
  throw new AccountRequestRefusedError(method.toUpperCase(), pathOf(url))
}

export interface AccountRequestDeps {
  url: string
  publishableKey: string
  /** `supabase.auth.getSession` of the app's ONE client, looked up per request. */
  getSession: () => Promise<{
    data: { session: { access_token: string; user: { id: string } } | null }
  }>
  /** Transport under the policy. Default: the platform `fetch`. Tests stand in for the network. */
  baseFetch?: typeof fetch
  /** Asks Auth whether the signed-in account is gone (the ambient client's GET /auth/v1/user). */
  accountIsGone: () => Promise<boolean>
}

export function createAccountDeletionPorts(deps: AccountRequestDeps): AccountDeletionPorts {
  const base = deps.baseFetch ?? fetch
  const guarded: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method =
      init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    assertAccountRequest(method, url)
    return base(input, init)
  }
  // Built on first use (not at app start): nothing here may run unless the person asks to delete.
  // The token provider is the ONLY authentication and is read per request.
  let client: SupabaseClient<Database> | null = null
  const clientFor = (): SupabaseClient<Database> => {
    if (client !== null) return client
    let constructing = true
    client = createClient<Database>(deps.url, deps.publishableKey, {
      global: { fetch: guarded },
      accessToken: async () => {
        if (constructing) return deps.publishableKey // supabase-js asks once while constructing
        const { data } = await deps.getSession()
        return data.session?.access_token ?? null
      },
    })
    constructing = false
    return client
  }
  return {
    invoke: (name, options) => clientFor().functions.invoke(name, options),
    accountIsGone: deps.accountIsGone,
  }
}
