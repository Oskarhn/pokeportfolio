/**
 * The decision logic of account deletion, with every side effect injected.
 *
 * Kept free of imports, `Deno` and network access on purpose: the Edge Function wires the real
 * dependencies (supabase/functions/delete-account/index.ts), and the test suites drive this same
 * function in-process with failing dependencies to prove the interrupted/retried paths without any
 * fault-injection switch existing in the deployed function. There is nothing an HTTP caller can
 * send to make the real function fail on purpose.
 *
 * Authority. The account that gets deleted is the one identified by the SERVER-VERIFIED bearer
 * token, and nothing else. `expectedUserId` from the request body is an intent check — "the person
 * who pressed the button was looking at this account" — and can only ever make the function do
 * LESS: a mismatch aborts before anything is touched. It is never used to pick a target.
 *
 * Order matters, and every step before `beginDeletion` changes nothing:
 *
 *   authenticate → intent check → fresh password verification → begin → purge → delete auth user
 *
 * The pending record is only written after the password has been verified, so a stolen access
 * token alone cannot even put an account into the pending state (which blocks its writes).
 *
 * What is atomic: each batch of `purgeData` (one database transaction per call). What is not, and
 * is therefore retryable: the sequence as a whole. A failure after `beginDeletion` leaves the account pending — write-
 * blocked by the database — and the same request can simply be repeated.
 */

export interface VerifiedUser {
  id: string
  email: string
  /**
   * Whether "the person typed their password just now" is a sufficient proof of recent
   * authentication for THIS account. False for anything the password check cannot honestly stand in
   * for: an account with no email/password identity (OAuth, passkey or other future sign-in), or one
   * with a verified second factor. Such an account is refused explicitly (`reauthentication_unsupported`)
   * rather than being sent through a password prompt it cannot pass or, worse, could pass without
   * its second factor. Every method the product adds later must extend this on purpose.
   */
  passwordReauthentication: boolean
}

export type PasswordCheck = 'ok' | 'invalid' | 'unavailable'

export interface AccountDeletionDeps {
  /** Resolves a bearer token against the Auth server. Null for anything not a live session. */
  authenticate(bearerToken: string): Promise<VerifiedUser | null>
  /** Verifies the password against Auth for the given (server-derived) address. */
  verifyPassword(email: string, password: string): Promise<PasswordCheck>
  /** Commits the pending record. `user_gone` means the account no longer exists (a parallel
   *  request finished first); any other failure rejects. */
  beginDeletion(userId: string): Promise<'pending' | 'user_gone'>
  /** Deletes every user-owned application row, in bounded atomic batches until the database
   *  reports it is complete. `account_gone` means the pending record has vanished, i.e. the auth
   *  user was deleted underneath this request. */
  purgeData(userId: string): Promise<'purged' | 'account_gone'>
  /** Hard-deletes the Auth user. `not_found` means it was already gone. */
  deleteAuthUser(userId: string): Promise<'deleted' | 'not_found'>
  /** Best-effort removal of Auth audit rows naming the user. Must not throw for platform limits. */
  scrubAuditTrail(userId: string): Promise<void>
  /** Coarse stage label kept on the pending record for operators. Best effort. */
  recordStage(
    userId: string,
    stage: 'purge_failed' | 'purged' | 'auth_delete_failed',
  ): Promise<void>
  /** Operational logging. Fields are stage/outcome labels only — never ids, emails or tokens. */
  log(event: string, fields?: Record<string, string | number>): void
}

export interface AccountDeletionRequest {
  bearerToken: string | null
  body: unknown
}

export type AccountDeletionErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'identity_mismatch'
  | 'reauthentication_failed'
  | 'reauthentication_unavailable'
  | 'reauthentication_unsupported'
  | 'deletion_incomplete'

export interface AccountDeletionResponse {
  status: number
  body:
    | { status: 'deleted' }
    | { error: AccountDeletionErrorCode; retryable?: boolean; stage?: 'data' | 'login' }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_PASSWORD_LENGTH = 1024

interface ParsedBody {
  expectedUserId: string
  password: string
}

function parseBody(body: unknown): ParsedBody | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { expectedUserId, password, confirm } = body as Record<string, unknown>
  if (typeof expectedUserId !== 'string' || !UUID.test(expectedUserId)) return null
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return null
  }
  // An explicit confirmation flag is a guard against a malformed or replayed-by-accident body. It
  // is NOT a security control — the password is — and is named as such so nobody mistakes it for one.
  if (confirm !== true) return null
  return { expectedUserId: expectedUserId.toLowerCase(), password }
}

const respond = (
  status: number,
  body: AccountDeletionResponse['body'],
): AccountDeletionResponse => ({ status, body })

export async function handleAccountDeletion(
  deps: AccountDeletionDeps,
  request: AccountDeletionRequest,
): Promise<AccountDeletionResponse> {
  // 1. Who is asking. Nothing about the body is looked at before the caller is known to be real,
  //    so an anonymous caller learns nothing about what a valid body looks like.
  if (!request.bearerToken) return respond(401, { error: 'unauthenticated' })

  let user: VerifiedUser | null
  try {
    user = await deps.authenticate(request.bearerToken)
  } catch {
    deps.log('delete-account.authenticate_unavailable')
    return respond(503, { error: 'reauthentication_unavailable', retryable: true })
  }
  if (!user) return respond(401, { error: 'unauthenticated' })

  // 2. Shape.
  const parsed = parseBody(request.body)
  if (!parsed) return respond(400, { error: 'bad_request' })

  // 3. Intent: the confirmation dialog was opened for THIS account. Abort, touching nothing, if
  //    the session behind the request is now someone else's.
  if (parsed.expectedUserId !== user.id.toLowerCase()) {
    deps.log('delete-account.identity_mismatch')
    return respond(409, { error: 'identity_mismatch' })
  }

  // 3b. Fail closed for accounts a password cannot stand in for. Nothing is verified, begun or touched.
  if (!user.passwordReauthentication) {
    deps.log('delete-account.reauthentication_unsupported')
    return respond(403, { error: 'reauthentication_unsupported' })
  }

  // 4. Recent authentication: a password the caller had to type just now, verified by Auth against
  //    the address of the account the token belongs to (never an address from the request).
  let check: PasswordCheck
  try {
    check = await deps.verifyPassword(user.email, parsed.password)
  } catch {
    check = 'unavailable'
  }
  if (check === 'invalid') {
    deps.log('delete-account.reauthentication_failed')
    return respond(403, { error: 'reauthentication_failed' })
  }
  if (check === 'unavailable') {
    deps.log('delete-account.reauthentication_unavailable')
    return respond(503, { error: 'reauthentication_unavailable', retryable: true })
  }

  // 5. Commit the pending state. From here on the database refuses new rows for this account. A
  //    failure means nothing else has happened yet.
  let gone = false
  try {
    // `user_gone` is the one case where "the target no longer exists" is a success rather than an
    // error: a parallel request for the same account finished between authenticate and here. It
    // is reported by the database itself (a foreign-key violation), never inferred from the
    // token going stale, which a revoked session would cause too.
    gone = (await deps.beginDeletion(user.id)) === 'user_gone'
  } catch {
    deps.log('delete-account.begin_failed')
    return respond(500, { error: 'deletion_incomplete', retryable: true, stage: 'data' })
  }

  // 6. Data. Bounded atomic batches, child-first; progress is durable, so a failure leaves a
  //    consistent prefix removed and a retry carries on.
  if (!gone) {
    try {
      gone = (await deps.purgeData(user.id)) === 'account_gone'
    } catch {
      deps.log('delete-account.purge_failed')
      await deps.recordStage(user.id, 'purge_failed').catch(() => undefined)
      return respond(500, { error: 'deletion_incomplete', retryable: true, stage: 'data' })
    }
  }
  if (!gone) await deps.recordStage(user.id, 'purged').catch(() => undefined)

  // 7. The login. `not_found` means a parallel request already finished the job.
  try {
    await deps.deleteAuthUser(user.id)
  } catch {
    deps.log('delete-account.auth_delete_failed')
    if (!gone) await deps.recordStage(user.id, 'auth_delete_failed').catch(() => undefined)
    return respond(500, { error: 'deletion_incomplete', retryable: true, stage: 'login' })
  }

  // 8. Residue in the Auth service's own audit table. The account is already gone, so nothing
  //    here may turn a completed deletion into an error response.
  try {
    await deps.scrubAuditTrail(user.id)
  } catch {
    deps.log('delete-account.audit_scrub_failed')
  }

  deps.log('delete-account.completed')
  return respond(200, { status: 'deleted' })
}
