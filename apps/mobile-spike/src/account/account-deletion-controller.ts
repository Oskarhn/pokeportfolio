import { AccountDeletionError, runAccountDeletion } from '@shared/data/account-deletion'
import type { LeasedDb } from '@shared/data/leased-client'
import type { AuthController } from '../auth/auth-controller'
import type { IdentityAuthority } from '../auth/identity-authority'
import { Emitter, type Resettable } from '../state/registry'
import type { PendingWriteJournal } from '../write/pending-write-journal'

/**
 * In-app account deletion (P189). It is NOT a second implementation: it calls the SAME backend
 * contract the web app calls (`delete-account`, through the shared `runAccountDeletion`), so the
 * authority, the password re-verification, the restore-safe erasure record and the retryable
 * failure states are the server's, identical on every client. There is no client-side cascade, no
 * table access and no deletion SQL anywhere in the native app.
 *
 * What is native-specific is only the local cleanup after the server says the account is gone:
 * the pending-write journal for that user, then the session (SecureStore) and every identity-scoped
 * store (collection, price check, scanner photo and scanner transient state, drafts) through the one
 * sign-out path — `AuthController.signOut()` retires the identity, which resets the whole registry
 * synchronously (and `PhotoStore.reset()` deletes the app-held photo copy). Photos the person picked
 * from their own library are theirs and are not touched.
 *
 * Safety properties pinned by tests/unit/account-deletion.test.ts:
 *   - nothing is sent unless there is a signed-in identity, and the intended id is that identity's;
 *   - failure never shows server text (the shared vocabulary maps to fixed sentences);
 *   - local cleanup runs only after the account is KNOWN to be gone;
 *   - an identity change while the dialog is open closes it without sending anything.
 */

export type AccountDeletionPhase = 'idle' | 'confirming' | 'working' | 'done'

export interface AccountDeletionState {
  phase: AccountDeletionPhase
  /** The account the confirmation was opened for. */
  intentUserId: string | null
  error: string | null
}

export interface AccountDeletionPorts {
  /** `supabase.functions.invoke` of the app's ONE client (bearer = the ambient session). */
  invoke: (name: string, options: { body: Record<string, unknown> }) => Promise<{ error: unknown }>
  /** Asks Auth whether the signed-in account is gone; only an explicit `user_not_found` is true. */
  accountIsGone: () => Promise<boolean>
}

const UNKNOWN = 'Something went wrong and we could not confirm the result. Try again.'

const MESSAGES: Record<string, string> = {
  reauthentication_failed: 'That password is not correct. Nothing was deleted.',
  reauthentication_unavailable:
    'We could not verify your password right now. Nothing was deleted — try again in a moment.',
  reauthentication_unsupported:
    'This account signs in in a way that cannot confirm a deletion here yet. Nothing was deleted.',
  identity_mismatch:
    'You are signed in as a different account than the one this confirmation was opened for. Nothing was deleted.',
  unauthenticated: 'Your session is no longer valid. Sign in again to delete your account.',
  deletion_unavailable:
    'Account deletion is not available right now. Nothing was deleted — try again later.',
  bad_request: 'The request was not accepted. Nothing was deleted.',
  network:
    'The connection was lost and we could not confirm the result. Try again — if the account was already deleted, you will be told your session is no longer valid.',
  unknown: UNKNOWN,
}

const INCOMPLETE_BEFORE_DELETING =
  'Deletion could not be completed safely and has not started removing anything. Your account is locked against changes for now. Enter your password and try again in a little while.'
const INCOMPLETE_AFTER_STARTING =
  'Deletion did not finish. Your account is now locked against changes and some of your data may already be removed. Enter your password and try again to complete it.'

export function deletionFailureMessage(error: unknown): string {
  if (error instanceof AccountDeletionError) {
    if (error.code === 'deletion_incomplete') {
      return error.stage === 'registry' ? INCOMPLETE_BEFORE_DELETING : INCOMPLETE_AFTER_STARTING
    }
    return MESSAGES[error.code] ?? UNKNOWN
  }
  const name = (error as { name?: string } | null)?.name
  if (name === 'AuthIdentityChangedError' || name === 'AuthCredentialsUnavailableError') {
    return (error as Error).message // fixed text, no detail
  }
  return UNKNOWN
}

export class AccountDeletionController implements Resettable {
  private state: AccountDeletionState = { phase: 'idle', intentUserId: null, error: null }
  private readonly emitter = new Emitter()
  private readonly authority: IdentityAuthority
  private readonly auth: AuthController
  private readonly journal: PendingWriteJournal
  private readonly ports: AccountDeletionPorts

  constructor(
    authority: IdentityAuthority,
    auth: AuthController,
    journal: PendingWriteJournal,
    ports: AccountDeletionPorts,
  ) {
    this.authority = authority
    this.auth = auth
    this.journal = journal
    this.ports = ports
  }

  subscribe = this.emitter.subscribe
  getSnapshot = (): AccountDeletionState => this.state

  private set(next: Partial<AccountDeletionState>): void {
    this.state = { ...this.state, ...next }
    this.emitter.emit()
  }

  /** Registered with the identity registry: a different identity can never inherit an open dialog. */
  reset(): void {
    if (this.state.phase === 'done') return // the deletion itself ends the identity; keep the result
    this.state = { phase: 'idle', intentUserId: null, error: null }
    this.emitter.emit()
  }

  open(): void {
    const userId = this.authority.userId
    if (userId === null || this.state.phase === 'working') return
    this.set({ phase: 'confirming', intentUserId: userId, error: null })
  }

  cancel(): void {
    if (this.state.phase === 'working') return
    this.set({ phase: 'idle', intentUserId: null, error: null })
  }

  async confirm(password: string): Promise<void> {
    if (this.state.phase !== 'confirming' || password.length === 0) return
    const intent = this.state.intentUserId
    // The lease is taken for the identity the confirmation was OPENED for. If that is no longer the
    // current identity the lease is dead and runAccountDeletion refuses before sending anything.
    const lease = this.authority.begin(intent)
    this.set({ phase: 'working', error: null })
    const db = {
      identityLease: lease,
      functions: {
        invoke: (name: string, options: { body: Record<string, unknown> }) =>
          this.ports.invoke(name, options),
      },
    } as unknown as LeasedDb
    try {
      await runAccountDeletion(
        db,
        { accountIsGone: () => this.ports.accountIsGone() },
        { password },
      )
    } catch (error) {
      if (!lease.isCurrent()) {
        // The identity changed under the dialog: it belongs to nobody now. Nothing to show.
        this.state = { phase: 'idle', intentUserId: null, error: null }
        this.emitter.emit()
        return
      }
      this.set({ phase: 'confirming', error: deletionFailureMessage(error) })
      return
    }
    // The server says the account is gone. Local cleanup, in this order, each step independent: a
    // failure of one must not leave the person signed in to an account that no longer exists.
    if (intent !== null) await this.journal.clearForUser(intent).catch(() => undefined)
    // Sign out only if the deleted account is STILL the signed-in identity: if the person switched to
    // another account while the request was in flight, that other account must not be signed out.
    if (lease.isCurrent()) await this.auth.signOut()
    this.set({ phase: 'done', intentUserId: null, error: null })
  }
}
