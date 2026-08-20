import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useAuth } from '../auth/useAuth'

interface AppShellProps {
  children: ReactNode
}

/**
 * Minimal application frame. Product navigation arrives at M6; what the header carries today is
 * the part authentication needs — who you are, the way out, and the admin entry point when the
 * account has it.
 */
export function AppShell({ children }: AppShellProps) {
  const { status, isAdmin, signOut } = useAuth()

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="flex items-center gap-4 border-b border-slate-800 px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <span className="text-sm font-medium tracking-wide text-slate-300">PokePortfolio</span>
        {status === 'signed-in' ? (
          <nav className="ml-auto flex items-center gap-4">
            {isAdmin ? (
              <Link
                to="/admin/invitations"
                className="text-sm text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
              >
                Invitations
              </Link>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void signOut()
              }}
              className="min-h-11 text-sm text-slate-400 underline-offset-4 hover:text-slate-200 hover:underline"
            >
              Sign out
            </button>
          </nav>
        ) : null}
      </header>
      <main
        className="flex-1 px-4 py-6"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        {children}
      </main>
    </div>
  )
}
