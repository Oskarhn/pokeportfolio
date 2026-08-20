import type { ReactNode } from 'react'
import { Navigate } from '@tanstack/react-router'
import { useAuth } from './useAuth'

/**
 * Route guards, which are a redirect convenience and nothing more.
 *
 * The real boundary is Postgres: RLS decides what a session can read, column grants decide what
 * it can write, and the invitation RPCs re-check `is_admin()` on the server. Someone who deletes
 * these components in devtools reaches a page whose every request comes back empty or refused.
 * They exist so a signed-out person lands on the sign-in form instead of an empty screen.
 */

function Waiting() {
  return <div className="h-24 animate-pulse rounded-lg bg-slate-800/60" aria-busy="true" />
}

export function RequireSession({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  if (status === 'loading') return <Waiting />
  if (status === 'signed-out') return <Navigate to="/login" replace />
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, isAdmin, profileLoading } = useAuth()
  if (status === 'loading' || profileLoading) return <Waiting />
  if (status === 'signed-out') return <Navigate to="/login" replace />
  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

/** Keeps a signed-in person off the sign-in form rather than showing them a pointless one. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  if (status === 'loading') return <Waiting />
  if (status === 'signed-in') return <Navigate to="/" replace />
  return <>{children}</>
}
