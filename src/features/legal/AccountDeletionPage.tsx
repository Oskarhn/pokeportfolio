import { Link } from '@tanstack/react-router'
import { useDocumentMeta } from '../../ui/useDocumentMeta'
import { CONTACT_EMAIL } from './contact'
import { LegalLayout } from './LegalLayout'

/**
 * The public account-deletion information page (P189) — the URL a store listing can point to. It is
 * reachable without signing in and states only what is true of this application:
 *
 *   - how to delete an account in the app (the in-app flow is the primary path);
 *   - what deletion covers (docs/security/P189_DELETION_DATA_MAP.md — the same list the in-app
 *     dialog shows);
 *   - what it does NOT reach, without inventing a retention period. Backups: Supabase documents that
 *     projects are restored from daily backups or point-in-time recovery; how long the operator's own
 *     project retains them is a setting this page does not know, so it promises no date. Logs: the
 *     hosting providers' retention is theirs and is not stated here.
 *   - how to ask for deletion if the app cannot be used: the one contact address the Privacy page
 *     already publishes. No other channel exists and none is implied.
 *
 * It claims no completion time for an emailed request: none has been decided (owner decision).
 */
export function AccountDeletionPage() {
  useDocumentMeta({
    title: 'Delete your account',
    description:
      'How to delete your PokePortfolio account and data, what deletion covers and what it does not reach.',
    robots: 'index, follow',
    canonicalPath: '/account-deletion',
  })

  return (
    <LegalLayout title="Delete your account" updated="2026-10-02">
      <p>
        PokePortfolio is a private, invite-only portfolio tracker for Pokémon cards. This page
        explains how to delete your account and the data in it. You do not need to be signed in to
        read it.
      </p>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">Delete it in the app</h2>
        <ol className="list-inside list-decimal space-y-1">
          <li>Sign in and open Profile.</li>
          <li>
            If you want a copy first, use <strong>Export &amp; backup</strong>. Deleting does not
            require it.
          </li>
          <li>
            Choose <strong>Delete account…</strong>, read the confirmation, enter your password
            again and confirm.
          </li>
        </ol>
        <p>
          Deletion is permanent and cannot be undone. When it finishes you are signed out. If it is
          interrupted, your account is locked against changes and you can run the same steps again
          to finish.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">What is deleted</h2>
        <ul className="list-inside list-disc space-y-0.5">
          <li>Your sign-in (email address and password) and your display name</li>
          <li>All tracked cards, graded cards and sealed products</li>
          <li>Purchases, sales, openings, valuations and acquisition history</li>
          <li>Tags, collections, storage locations, retailers and manual card definitions</li>
          <li>Your own sealed product definitions and your portfolio value history</li>
          <li>Your settings</li>
        </ul>
        <p>
          The invitation you signed up with is kept as a record of an administrative action; your
          email address is removed from it.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">What deletion does not reach</h2>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <strong>Database backups.</strong> The service that hosts the database keeps backups so
            the app can be recovered. A backup made before you deleted your account is not rewritten
            and may still contain your data until it is replaced or expires. No date for that is
            promised here, because the retention of the operator's backups is a setting this page
            does not state.
          </li>
          <li>
            <strong>Restoring a backup.</strong> The operator keeps a minimal record of deletions —
            a one-way fingerprint of the account's random identifier, a date and a sequence number;
            no name, email address, portfolio data or password — separately from the backups. The
            documented recovery procedure re-applies those deletions to a restored database before
            it is used again, so restoring an old backup is not meant to bring a deleted account
            back.
          </li>
          <li>
            <strong>Logs.</strong> The hosting providers keep operational logs under their own
            retention rules. This page does not state a period for them.
          </li>
          <li>Files you exported earlier are on your own device, not on ours.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-slate-100">If you cannot use the app</h2>
        <p>
          Ask for deletion by email to{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">
            {CONTACT_EMAIL}
          </a>
          , from the address you signed up with. This is a one-person project; no completion time is
          promised for an emailed request.
        </p>
        <p>
          More about what the application stores is on the{' '}
          <Link to="/privacy" className="underline underline-offset-2">
            Privacy page
          </Link>
          .
        </p>
      </section>
    </LegalLayout>
  )
}
