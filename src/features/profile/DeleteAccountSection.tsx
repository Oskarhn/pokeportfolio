import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { markAccountDeleted } from '../../auth/account-deleted-notice'
import { useAuth } from '../../auth/useAuth'
import { useLeasedMutation } from '../../auth/useLeasedMutation'
import { AccountDeletionError, runAccountDeletion } from '../../data/account-deletion'
import { authAccountProbe } from '../../data/account-deletion-probe'
import { leasedDb } from '../../data/leased-db'
import { exportReminderStorageKey } from '../../domain/export/export-reminder'
import { Button, FormMessage, PasswordField } from '../../ui/form'
import { Sheet } from '../../ui/Sheet'

/**
 * Settings → Delete account (P152, rebuilt on identity leases and restore-safe deletion in P189).
 * Deliberately separate from "Reset portfolio data" above it: that one keeps the account; this one
 * ends it.
 *
 * Identity binding. The dialog captures WHICH account it was opened for (`intent`). If the auth
 * session moves to a different user while it is open, the dialog closes itself and nothing is sent.
 * Pressing the confirm button takes an identity LEASE for the account the screen was rendered under
 * (useLeasedMutation); the request layer then refuses to send anything once that identity has ended,
 * and the server compares the intended id with the verified session and refuses on mismatch. All
 * three halves exist on purpose; none is trusted alone.
 *
 * What the person sees on failure is a fixed sentence per code. Nothing from the server's body, no
 * SQL, no function or table name and no stack is ever rendered (the data layer maps to a closed
 * vocabulary). The copy says what is deleted, what is not, and what can go wrong; it does not say
 * "everything is erased everywhere": earlier backups and provider logs are outside this action
 * (src/features/legal/AccountDeletionPage.tsx has the full statement).
 */

interface Intent {
  userId: string
  email: string | null
}

const UNKNOWN_MESSAGE = 'Something went wrong and we could not confirm the result. Try again.'

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
  unknown: UNKNOWN_MESSAGE,
}

const INCOMPLETE_BEFORE_DELETING =
  'Deletion could not be completed safely and has not started removing anything. Your account is locked against changes for now. Enter your password and try again in a little while.'
const INCOMPLETE_AFTER_STARTING =
  'Deletion did not finish. Your account is now locked against changes and some of your data may already be removed. Enter your password and try again to complete it.'

export function messageForDeletionFailure(error: unknown): string {
  if (!(error instanceof AccountDeletionError)) {
    // An ended lease (identity changed) or an unavailable credential carries fixed, safe text of its
    // own; anything else is the generic sentence — never the error's own message.
    const name = (error as { name?: string } | null)?.name
    if (name === 'AuthIdentityChangedError' || name === 'AuthCredentialsUnavailableError') {
      return (error as Error).message
    }
    return UNKNOWN_MESSAGE
  }
  if (error.code === 'deletion_incomplete') {
    return error.stage === 'registry' ? INCOMPLETE_BEFORE_DELETING : INCOMPLETE_AFTER_STARTING
  }
  return MESSAGES[error.code] ?? UNKNOWN_MESSAGE
}

export function DeleteAccountSection() {
  const { session, email, isAdmin, signOut } = useAuth()
  const [intent, setIntent] = useState<Intent | null>(null)
  const [password, setPassword] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switchedNotice, setSwitchedNotice] = useState(false)

  const currentUserId = session?.user.id ?? null

  // The session changed underneath an open confirmation: drop it. Done while rendering (React's
  // supported "adjust state on prop change" pattern) rather than in an effect, so there is no
  // frame in which a dialog opened for one account is interactive under another.
  if (intent !== null && intent.userId !== currentUserId) {
    setIntent(null)
    setPassword('')
    setAcknowledged(false)
    setError(null)
    setSwitchedNotice(true)
  }

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- the mutation resolves with nothing
  const deletion = useLeasedMutation<void, { password: string }>({
    // Local cleanup runs INSIDE the mutation function, not in onSuccess: ending the session ends the
    // lease, and a lease callback is skipped once its lease has ended (useLeasedMutation).
    mutationFn: async (variables, lease) => {
      await runAccountDeletion(leasedDb(lease), authAccountProbe(lease), variables)
      try {
        window.localStorage.removeItem(exportReminderStorageKey(lease.userId))
      } catch {
        // Storage can be unavailable (private mode); nothing else depends on it.
      }
      // Ending the local session makes the route guard send this tab to /login; the note is what
      // lets that page say why.
      markAccountDeleted()
      await signOut()
    },
    onError: (failure: unknown) => {
      setPassword('')
      setError(messageForDeletionFailure(failure))
    },
  })

  const working = deletion.isPending
  const open = intent !== null

  function close() {
    if (working) return
    setIntent(null)
    setPassword('')
    setAcknowledged(false)
    setError(null)
  }

  return (
    <section className="space-y-2 rounded-2xl border border-rose-900/50 p-4">
      <h2 className="text-sm font-semibold text-rose-300">Delete account</h2>
      <p className="text-xs text-slate-500">
        Permanently delete your account and everything in it. Unlike resetting your portfolio, this
        also removes your sign-in.
      </p>
      {switchedNotice && !open ? (
        <FormMessage tone="error">
          The signed-in account changed while the confirmation was open, so it was closed. Nothing
          was deleted.
        </FormMessage>
      ) : null}
      <Button
        type="button"
        variant="quiet"
        className="border border-rose-900/60 text-rose-300 hover:bg-rose-950/40"
        disabled={currentUserId === null}
        onClick={() => {
          if (currentUserId === null) return
          setSwitchedNotice(false)
          setError(null)
          setIntent({ userId: currentUserId, email })
        }}
      >
        Delete account…
      </Button>

      <Sheet open={open} onClose={close} title="Delete your account?">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (intent === null || !acknowledged || password.length === 0 || working) return
            setError(null)
            deletion.mutate({ password })
          }}
        >
          <p className="text-sm text-slate-300">
            This deletes the account{intent?.email ? ` ${intent.email}` : ''}. It cannot be undone.
          </p>

          <div className="rounded-lg border border-rose-900/40 p-3 text-xs text-slate-400">
            <p className="font-medium text-rose-300">Deleted right away:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>Your sign-in (email and password) and your display name</li>
              <li>All tracked cards, graded cards and sealed products</li>
              <li>Purchases, sales, openings, valuations and acquisition history</li>
              <li>Tags, collections, storage locations, retailers and manual card definitions</li>
              <li>Your own sealed product definitions and your portfolio value history</li>
              <li>Your settings</li>
            </ul>
          </div>

          <div className="rounded-lg border border-slate-800 p-3 text-xs text-slate-400">
            <p className="font-medium text-slate-300">Not covered by this action:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              <li>
                Database backups made earlier are not rewritten and may still contain your data
                until they are replaced or expire. No date is promised here. If a backup is ever
                restored, the deletion is re-applied before the restored database is used.
              </li>
              <li>
                The invitation you signed up with is kept as a record; your email address is removed
                from it.
              </li>
              <li>Exports you already downloaded are files on your device, not on our side.</li>
            </ul>
            <p className="mt-1 text-slate-500">
              <Link to="/profile/export" className="underline underline-offset-2">
                Export &amp; backup
              </Link>{' '}
              first if you want a copy. It is not required.{' '}
              <Link to="/account-deletion" className="underline underline-offset-2">
                Read more
              </Link>
              .
            </p>
          </div>

          {isAdmin ? (
            <p className="rounded-lg border border-slate-800 p-3 text-xs text-slate-400">
              You are an administrator. Deleting this account removes your admin access. Invitations
              you issued stay as records.
            </p>
          ) : null}

          <p className="text-xs text-slate-500">
            If something goes wrong part-way, the account is locked against changes and you can run
            this again to finish.
          </p>

          <PasswordField
            label="Your password"
            hint="Required again, to confirm it is you."
            name="current-password"
            autoComplete="current-password"
            required
            value={password}
            disabled={working}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />

          <label className="flex min-h-9 cursor-pointer items-start gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={working}
              onChange={(event) => {
                setAcknowledged(event.target.checked)
              }}
              className="mt-0.5 size-5 accent-rose-600"
            />
            <span>I understand this is permanent and cannot be undone.</span>
          </label>

          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
          {working ? (
            <p role="status" className="text-xs text-slate-400">
              Deleting your account… this can take a few seconds. Keep this page open.
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="button" variant="quiet" disabled={working} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="border border-rose-900/60 bg-rose-900/80 hover:bg-rose-800"
              disabled={working || !acknowledged || password.length === 0}
            >
              {working ? 'Deleting…' : 'Permanently delete account'}
            </Button>
          </div>
        </form>
      </Sheet>
    </section>
  )
}
