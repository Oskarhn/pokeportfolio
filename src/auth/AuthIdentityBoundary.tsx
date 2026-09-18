import { Fragment, type ReactNode } from 'react'
import { useAuth } from './useAuth'
import { identityKey } from './identity'

/**
 * The React half of the account-isolation boundary (P143, closes P130-23).
 *
 * WHY: every protected route is wrapped in `RequireSession`, which renders `<>{children}</>` for
 * any signed-in status. supabase-js broadcasts auth events to every tab sharing the browser
 * profile's storage, so another tab signing in as B delivers `SIGNED_IN(B)` to a tab that is
 * showing A's half-typed form — with `status` staying `'signed-in'` throughout. React only
 * unmounts a component when its key or type changes, so that form instance survived with A's
 * `useState` values, and its next submit went out under B's bearer.
 *
 * WHAT: the whole authenticated application subtree (app shell, nav, portals and the routed page)
 * is mounted under a key derived from the auth USER ID. A different user id remounts it, which
 * destroys every piece of component-local state in one central place instead of relying on each
 * form to remember to reset itself. The same user id — token refresh, `USER_UPDATED`, a repeated
 * `SIGNED_IN` on tab refocus, a new session object — keeps the key, so unsaved work survives those
 * events (the boundary is the USER, not the token).
 *
 * State that lives OUTSIDE this subtree (the TanStack Query cache, the openings draft store, the
 * scanner session store, the unsaved-work counter) is not reached by a remount; `AuthProvider`
 * clears it synchronously in its auth callback, before the new identity becomes renderable, via
 * `applyAuthIdentityBoundary`.
 *
 * Signed-out and still-restoring share one key, so the initial session restore resolving to
 * "signed out" does not remount public pages; a restore that resolves to a user remounts once,
 * from skeleton content that held no user state.
 *
 * Placement: inside the router (it renders in the root route), never around `RouterProvider` —
 * remounting the provider would rebuild router state instead of just the UI beneath it.
 */
export function AuthIdentityBoundary({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  return <Fragment key={identityKey(session?.user.id ?? null)}>{children}</Fragment>
}
