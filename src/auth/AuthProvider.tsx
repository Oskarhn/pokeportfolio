import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../data/supabase-client'
// P56 §9: ending authentication must deterministically drop every user's in-memory opening
// draft — private financial intent never outlives the session that created it. (The store is
// additionally keyed by user id, so account switches are isolated even without this.)
import { draftStore } from '../features/openings/draft'
import { AuthContext, type AuthState } from './auth-context'

/**
 * Session state for the whole application.
 *
 * Storage and refresh are left to supabase-js: it keeps the session in localStorage with refresh
 * token rotation, which is the trade the SPA model implies (docs/SECURITY.md §9). Re-implementing
 * that on top of a custom store would add an XSS-reachable copy of the same token and buy nothing.
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

  useEffect(() => {
    let active = true

    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setStatus(data.session ? 'signed-in' : 'signed-out')
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setStatus(nextSession ? 'signed-in' : 'signed-out')
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

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
    await supabase.auth.signOut()
    draftStore.clearAll()
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      status,
      session,
      email: session?.user.email ?? null,
      isAdmin,
      profileLoading,
      signIn,
      signOut,
    }),
    [status, session, isAdmin, profileLoading, signIn, signOut],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}
