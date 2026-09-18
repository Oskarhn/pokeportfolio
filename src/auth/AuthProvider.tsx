import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase, authSessionStorage, AUTH_STORAGE_KEY } from '../data/supabase-client'
// P56 §9: ending authentication must deterministically drop every user's in-memory opening
// draft — private financial intent never outlives the session that created it. (The store is
// additionally keyed by user id, so account switches are isolated even without this.)
import { draftStore } from '../features/openings/draft'
// M15 (D-093 sweep extension): scanner session defaults are private collection intent too.
import { scannerSessionStore } from '../features/scanner/session-store'
import { applyAuthIdentityBoundary, type ObservedUserId } from './query-cache-boundary'
import { describeSessionEnd, endAuthenticatedSession } from './end-session'
import { AuthContext, type AuthState } from './auth-context'

/**
 * Session state for the whole application.
 *
 * Storage and refresh are left to supabase-js: it keeps the session in localStorage with refresh
 * token rotation, which is the trade the SPA model implies (docs/SECURITY.md §9). Re-implementing
 * that on top of a custom store would add an XSS-reachable copy of the same token and buy nothing —
 * the adapter in auth/session-storage.ts wraps the SAME localStorage entry, it does not duplicate
 * it; it exists only so a deliberate sign-out can prove that entry is gone (P130-22).
 *
 * Identity isolation (P130-23) has two halves that must stay together: `AuthIdentityBoundary`
 * remounts the authenticated React subtree when the user id changes, and `observeIdentity` below
 * clears the state that lives outside React (query cache, stores) in the same auth callback.
 *
 * `isAdmin` is read from the user's own `profiles` row, and is a UI affordance only. Every admin
 * capability is gated in Postgres — the invitation RPCs check `is_admin()` themselves and the
 * `invitations` policy is admin-only — so a user who flips this in devtools sees an admin screen
 * whose every call fails.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading')
  const [session, setSession] = useState<Session | null>(null)
  // Stored against the user it was read for, rather than as a bare boolean that would have to be
  // cleared on sign-out. Deriving both `isAdmin` and `profileLoading` from it means the effect
  // below never writes state synchronously, only from its own async result.
  const [adminFor, setAdminFor] = useState<{ userId: string; isAdmin: boolean } | null>(null)
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null)
  const queryClient = useQueryClient()
  // F-61-2: the module-lifetime QueryClient is user-blind (no key carries a user id), so a
  // same-tab account switch must clear it between identities or B renders A's cached financial
  // data until refetches land. This ref tracks the last identity observed from Supabase auth;
  // every session observation — getSession AND all onAuthStateChange events (SIGNED_IN,
  // SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED, INITIAL_SESSION) — passes through
  // applyAuthIdentityBoundary, which clears queries+mutations+drafts exactly when one OBSERVED
  // user id is replaced by a different one. Same-user refreshes compare equal and keep state.
  const lastIdentityRef = useRef<ObservedUserId>(undefined)
  const observeIdentity = useCallback(
    (nextSession: Session | null) => {
      // The boundary runs BEFORE the new identity becomes renderable state, so no protected UI
      // can mount against a cache still holding the previous user's entries.
      applyAuthIdentityBoundary(queryClient, lastIdentityRef.current, nextSession?.user.id ?? null)
      lastIdentityRef.current = nextSession?.user.id ?? null
    },
    [queryClient],
  )

  useEffect(() => {
    let active = true

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      observeIdentity(data.session)
      setSession(data.session)
      setStatus(data.session ? 'signed-in' : 'signed-out')
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      observeIdentity(nextSession)
      setSession(nextSession)
      setStatus(nextSession ? 'signed-in' : 'signed-out')
      // A new session means whatever the last sign-out reported no longer applies.
      if (nextSession) setSignOutNotice(null)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [observeIdentity])

  const userId = session?.user.id ?? null

  useEffect(() => {
    if (!userId) return
    let active = true

    void supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!active) return
        setAdminFor({ userId, isAdmin: data?.is_admin === true })
      })

    return () => {
      active = false
    }
  }, [userId])

  const isAdmin = adminFor !== null && adminFor.userId === userId && adminFor.isAdmin
  const profileLoading = userId !== null && adminFor?.userId !== userId

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (!error) return { error: null }
    // Supabase answers identically for "no such account" and "wrong password"; keeping one
    // message here means the UI does not become the account-enumeration oracle the API is not.
    return { error: 'That email and password combination did not work.' }
  }, [])

  const signOut = useCallback(async () => {
    const outcome = await endAuthenticatedSession({
      auth: supabase.auth,
      storage: authSessionStorage,
      storageKey: AUTH_STORAGE_KEY,
    })
    // From here on THIS tab is signed out, whichever events did or did not fire on the way (the
    // library emits nothing when it declines to remove an expired session, P130-22). These are
    // idempotent with the SIGNED_OUT path: the boundary only fires when the identity changed.
    observeIdentity(null)
    setSession(null)
    setStatus('signed-out')
    draftStore.clearAll()
    scannerSessionStore.clearAll()
    setSignOutNotice(describeSessionEnd(outcome))
    return outcome
  }, [observeIdentity])

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      email: session?.user.email ?? null,
      isAdmin,
      profileLoading,
      signIn,
      signOut,
      signOutNotice,
    }),
    [status, session, isAdmin, profileLoading, signIn, signOut, signOutNotice],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
