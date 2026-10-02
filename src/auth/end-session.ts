import { isAuthApiError } from '@supabase/supabase-js'
import { authUserStorageKey } from './session-storage'

/**
 * A deliberate "Sign out" (P143, closes P130-22).
 *
 * The contract is two independent facts, deliberately not collapsed into one boolean:
 *
 *   local   did this browser stop being able to act as the person? Must always end. The stored
 *           session (which holds the refresh token) is gone and the client has been told.
 *   remote  could the Auth service CONFIRM it ended the session on its side? Cannot be guaranteed
 *           when the service is unreachable, and must then be reported as unconfirmed rather than
 *           implied to have succeeded.
 *
 * `supabase.auth.signOut()` does not give us the first fact on its own, and it can also take far
 * longer than a person will wait. In the installed auth-js (2.112.3) it loads the stored session
 * and, if the ACCESS token has expired, refreshes BEFORE revoking. A network failure there is an
 * `AuthRetryableFetchError` that is retried with exponential backoff for up to ~25 s and is then
 * returned WITHOUT removing the stored session and without emitting SIGNED_OUT (session-storage.ts
 * has the details). So: the request to revoke is given a short deadline, and once it has answered
 * or the deadline has passed this verifies the stored session is really gone; if the library left
 * it behind, it is removed through the same storage adapter and the library's own LOCAL sign-out is
 * run — with nothing left in storage that needs no network and tells every subscriber and every
 * other tab. A late answer from the abandoned request cannot resurrect anything: the library's own
 * commit guard discards rotated tokens when storage changed under a refresh. No private auth-js
 * API is used anywhere.
 *
 * While a sign-out is pending, a `pagehide` listener removes the stored session synchronously, so
 * closing the tab right after pressing the button cannot leave the session behind.
 *
 * Never throws: whatever fails is folded into the returned outcome, and no raw error object, HTTP
 * detail or token ever leaves this module (see {@link describeSessionEnd}).
 */

export interface AuthSignOutApi {
  signOut: (options?: { scope?: 'global' | 'local' | 'others' }) => Promise<{ error: unknown }>
}

export interface StoredSessionAccess {
  getItem: (key: string) => string | null | Promise<string | null>
  removeItem: (key: string) => void | Promise<void>
}

export interface SessionEndDeps {
  auth: AuthSignOutApi
  storage: StoredSessionAccess
  storageKey: string
  /** How long to wait for the Auth service before ending local access anyway. */
  deadlineMs?: number
}

export interface SessionEndOutcome {
  /** `ended`: nothing of the session remains in browser storage. `incomplete`: removal could not
   *  be verified (storage threw or still holds the entry). */
  local: 'ended' | 'incomplete'
  /** `confirmed`: the service ended it, or told us the credential was already not valid.
   *  `unconfirmed`: unreachable, slow, failed, or answered in a way that says nothing about
   *  revocation. */
  remote: 'confirmed' | 'unconfirmed'
}

/** Long enough for a healthy round trip (tens of ms) plus a token refresh, short enough that a
 *  person who pressed Sign out on a dead connection is not left staring at a signed-in screen. */
export const REMOTE_REVOCATION_DEADLINE_MS = 3000

/** HTTP verdicts that mean "the service looked at this credential and it is not (or is no longer)
 *  a live session": nothing is left there to revoke. Anything else says nothing about revocation. */
const DEFINITIVE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404])

export function isRemoteRevocationConfirmed(error: unknown): boolean {
  if (error === null || error === undefined) return true
  return isAuthApiError(error) && DEFINITIVE_REJECTION_STATUSES.has(error.status)
}

const DEADLINE_EXCEEDED = new Error('remote revocation deadline exceeded')

async function attemptRemoteSignOut(auth: AuthSignOutApi, deadlineMs: number): Promise<unknown> {
  const request = (async (): Promise<unknown> => {
    try {
      const { error } = await auth.signOut()
      return error ?? null
    } catch (thrown) {
      // A thrown value can be falsy; a failure must never be mistaken for "no error".
      return thrown ?? new Error('sign-out threw')
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<unknown>((resolve) => {
    timer = setTimeout(() => {
      resolve(DEADLINE_EXCEEDED)
    }, deadlineMs)
  })
  try {
    return await Promise.race([request, deadline])
  } finally {
    clearTimeout(timer)
  }
}

type StoredState = 'present' | 'absent'

async function readStoredState(storage: StoredSessionAccess, key: string): Promise<StoredState> {
  try {
    return (await storage.getItem(key)) === null ? 'absent' : 'present'
  } catch {
    // Unreadable is not "gone": treat it as still present and let the caller prove otherwise.
    return 'present'
  }
}

function sessionKeys(storageKey: string): string[] {
  return [storageKey, authUserStorageKey(storageKey)]
}

async function ensureStoredSessionRemoved(deps: SessionEndDeps): Promise<'ended' | 'incomplete'> {
  const { auth, storage, storageKey } = deps
  if ((await readStoredState(storage, storageKey)) === 'absent') return 'ended'

  for (const key of sessionKeys(storageKey)) {
    try {
      await storage.removeItem(key)
    } catch {
      // Verified below; a failed removal shows up as `incomplete`, not as an exception.
    }
  }
  try {
    // Storage is empty now, so this makes no request: it only lets the library tell its
    // subscribers and the other tabs that the session is gone.
    await auth.signOut({ scope: 'local' })
  } catch {
    // Same: the verification below is the authority.
  }
  return (await readStoredState(storage, storageKey)) === 'absent' ? 'ended' : 'incomplete'
}

/** Removes the stored session synchronously if the page goes away while a sign-out is pending. */
function installPageHideGuard(deps: SessionEndDeps): () => void {
  if (typeof globalThis.addEventListener !== 'function') return () => undefined
  const onPageHide = () => {
    for (const key of sessionKeys(deps.storageKey)) {
      try {
        void deps.storage.removeItem(key)
      } catch {
        // Nothing more can be done while the page is unloading.
      }
    }
  }
  globalThis.addEventListener('pagehide', onPageHide)
  return () => {
    globalThis.removeEventListener('pagehide', onPageHide)
  }
}

export async function endAuthenticatedSession(deps: SessionEndDeps): Promise<SessionEndOutcome> {
  const removePageHideGuard = installPageHideGuard(deps)
  try {
    const remoteError = await attemptRemoteSignOut(
      deps.auth,
      deps.deadlineMs ?? REMOTE_REVOCATION_DEADLINE_MS,
    )
    const local = await ensureStoredSessionRemoved(deps)
    return {
      local,
      remote: isRemoteRevocationConfirmed(remoteError) ? 'confirmed' : 'unconfirmed',
    }
  } finally {
    removePageHideGuard()
  }
}

/**
 * The text shown to the person after a sign-out, or null when there is nothing to warn about.
 * Fixed strings only — never derived from an error — so no HTTP detail, endpoint or token can
 * reach the screen.
 */
export function describeSessionEnd(outcome: SessionEndOutcome): string | null {
  if (outcome.local === 'incomplete') {
    return "We couldn't fully clear the sign-in stored in this browser. Before you leave this device, close this tab and clear this site's data."
  }
  if (outcome.remote === 'unconfirmed') {
    return "Signed out on this device. We couldn't confirm that the server ended your session — the sign-in service was unreachable, slow or returned an error. On a shared device, sign in and sign out again once you're back online."
  }
  return null
}
