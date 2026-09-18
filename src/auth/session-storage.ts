import type { SupportedStorage } from '@supabase/supabase-js'

/**
 * Where supabase-js keeps the session, made explicit so a deliberate sign-out can guarantee the
 * stored copy is gone (P143, closes P130-22).
 *
 * WHY THIS EXISTS. `supabase.auth.signOut()` is not a guarantee of local removal. In the installed
 * auth-js (2.112.3) it first loads the stored session; if the ACCESS token has already expired it
 * refreshes before revoking, and a network failure there is an `AuthRetryableFetchError` that
 * `_signOut` returns WITHOUT removing the stored session and without emitting SIGNED_OUT. A tab
 * left idle past token expiry while the Auth service is unreachable therefore had a Sign out
 * button that did nothing visible, and a session (refresh token included) that would be accepted
 * again the moment the service came back.
 *
 * The supported ways out are both documented client options — an explicit `storageKey` and a
 * caller-supplied `storage` adapter — so the app can remove the stored session itself, through
 * the very adapter the client reads, when the library did not. Nothing here touches auth-js
 * internals or an undocumented key: the key below is passed to `createClient` (and a unit test
 * pins it to the value supabase-js would have derived on its own, so existing signed-in browsers
 * keep their session across this change).
 */

/** The storage key supabase-js derives by default: `sb-<first hostname label>-auth-token`. */
export function deriveAuthStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
}

/** The auxiliary key auth-js writes next to the session when a separate user storage is used. */
export function authUserStorageKey(storageKey: string): string {
  return `${storageKey}-user`
}

function detectLocalStorage(): Storage | null {
  try {
    const candidate = globalThis.localStorage as Storage | undefined
    if (candidate === undefined) return null
    const probe = '__pp_storage_probe__'
    candidate.setItem(probe, '1')
    candidate.removeItem(probe)
    return candidate
  } catch {
    // DOM SecurityError / QuotaExceededError (blocked site data, some private modes).
    return null
  }
}

/**
 * The same medium supabase-js picks on its own — `localStorage`, else an in-memory map — but held
 * by the app, so removal goes through the exact object the client reads from.
 */
export function createAuthSessionStorage(): SupportedStorage {
  const local = detectLocalStorage()
  if (local !== null) {
    return {
      getItem: (key) => local.getItem(key),
      setItem: (key, value) => {
        local.setItem(key, value)
      },
      removeItem: (key) => {
        local.removeItem(key)
      },
    }
  }
  const memory = new Map<string, string>()
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value)
    },
    removeItem: (key) => {
      memory.delete(key)
    },
  }
}
