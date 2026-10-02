import { FunctionsHttpError } from '@supabase/supabase-js'
import {
  isAuthCredentialsUnavailableError,
  isAuthIdentityChangedError,
} from '../auth/identity-lease'
import type { LeasedDb } from './leased-client'

/**
 * Client for the `delete-account` Edge Function (P152, restore-safe in P189). The function
 * permanently deletes the CALLING account; docs/SECURITY.md §8 and docs/security/RESTORE_RUNBOOK.md
 * have the sequence and its recovery story. Web and native call this ONE contract: the same
 * endpoint, the same three inputs (a bearer token, the intended account id, a freshly typed
 * password). Nothing here orchestrates deletion across tables.
 *
 * `expectedUserId` is an INTENT check, never authority. It is the id of the account whose
 * confirmation dialog the person was looking at, taken from the identity lease captured when they
 * pressed the button. The server derives the target from the verified session alone and aborts,
 * touching nothing, if the two disagree — which is what stops a dialog opened as A from deleting B
 * after an account switch. The lease adds the client half: a request is not even sent once the
 * identity it belongs to has ended (src/data/leased-client.ts).
 *
 * What a failure means to the person is deliberately coarse. The codes below are the whole
 * vocabulary: nothing from the server's body beyond them (no SQL, no PostgREST text, no function or
 * table name, no stack) ever reaches the screen.
 */

export type AccountDeletionFailureCode =
  | 'reauthentication_failed'
  | 'reauthentication_unavailable'
  | 'reauthentication_unsupported'
  | 'identity_mismatch'
  | 'unauthenticated'
  | 'deletion_incomplete'
  | 'deletion_unavailable'
  | 'bad_request'
  | 'network'
  | 'unknown'

export class AccountDeletionError extends Error {
  readonly code: AccountDeletionFailureCode
  /** True when repeating the same request can be expected to help. */
  readonly retryable: boolean
  /** For `deletion_incomplete`: which step did not finish. */
  readonly stage: 'registry' | 'data' | 'login' | undefined

  constructor(
    code: AccountDeletionFailureCode,
    retryable: boolean,
    stage?: 'registry' | 'data' | 'login',
  ) {
    super(code)
    this.name = 'AccountDeletionError'
    this.code = code
    this.retryable = retryable
    this.stage = stage
  }
}

export interface DeleteAccountInput {
  /** The password, typed for this request. Sent once, never stored, never logged. */
  password: string
}

/** What the module needs besides the leased client: a way to ask Auth whether the account is gone. */
export interface DeletionProbe {
  /** `gone` only for Auth's explicit "this user does not exist"; anything else is `unknown`. */
  accountIsGone(): Promise<boolean>
}

const KNOWN_CODES = new Set<AccountDeletionFailureCode>([
  'reauthentication_failed',
  'reauthentication_unavailable',
  'reauthentication_unsupported',
  'identity_mismatch',
  'unauthenticated',
  'deletion_incomplete',
  'deletion_unavailable',
  'bad_request',
])

async function readFailure(error: unknown): Promise<AccountDeletionError | null> {
  if (!(error instanceof FunctionsHttpError)) return null
  const response = error.context as Response
  try {
    const body = (await response.json()) as {
      error?: string
      retryable?: boolean
      stage?: 'registry' | 'data' | 'login'
    }
    if (body.error && KNOWN_CODES.has(body.error as AccountDeletionFailureCode)) {
      return new AccountDeletionError(
        body.error as AccountDeletionFailureCode,
        body.retryable === true,
        body.stage,
      )
    }
  } catch {
    // Not our JSON: a gateway or platform error page. Handled by the caller as unknown.
  }
  return null
}

/**
 * Runs the deletion through the leased client. Resolves when the account is gone; rejects with an
 * {@link AccountDeletionError} otherwise (an ended lease rejects with the lease's own error, which
 * carries fixed text and no detail).
 *
 * After a request whose outcome the client could not read (connection lost, gateway error) the only
 * honest way to learn whether the account is gone is to ask Auth, and only an explicit "user does
 * not exist" counts: an expired or revoked session is not the same statement.
 */
function isLeaseRefusal(error: unknown): error is Error {
  return isAuthIdentityChangedError(error) || isAuthCredentialsUnavailableError(error)
}

export async function runAccountDeletion(
  db: LeasedDb,
  probe: DeletionProbe,
  input: DeleteAccountInput,
): Promise<void> {
  const lease = db.identityLease
  lease.assertCurrent()
  const expectedUserId = lease.userId

  let response: { error: unknown }
  try {
    response = await db.functions.invoke('delete-account', {
      body: { expectedUserId, password: input.password, confirm: true },
    })
  } catch (thrown) {
    if (isLeaseRefusal(thrown)) throw thrown
    if (await probe.accountIsGone()) return
    throw new AccountDeletionError('network', true)
  }

  if (!response.error) return

  // supabase-js reports a throw from the request layer (the lease refusing to hand out a token)
  // as a FunctionsFetchError whose context is the original error. Say exactly that: nothing was
  // sent, so it is never "we could not confirm the result".
  const context = (response.error as { context?: unknown }).context
  if (isLeaseRefusal(context)) throw context

  const failure = await readFailure(response.error)
  if (failure) throw failure

  // No readable answer from our own function: the request may or may not have finished.
  if (await probe.accountIsGone()) return
  const fetchFailure =
    response.error instanceof Error && response.error.name === 'FunctionsFetchError'
  throw new AccountDeletionError(fetchFailure ? 'network' : 'unknown', true)
}
