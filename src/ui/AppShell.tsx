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

  // `svh`, not `dvh`. Both are "the viewport", but dvh is the *largest* it can be — the height with
  // browser chrome retracted, and on iOS the height with the on-screen keyboard dismissed. Sizing
  // the shell to that leaves a stretch of empty page below the content whenever the real visible
  // area is smaller, and that stretch is scrollable: on an installed iPhone PWA the sign-in form
  // could be scrolled entirely off the top, leaving only the footer link on screen. `svh` is the
  // *smallest* viewport, so the shell never exceeds what is actually visible.
  //
  // Found on real hardware. It does not reproduce in Chromium's mobile emulation, where dvh, svh
  // and the visual viewport are all the same number.
  return (
    <div className="flex min-h-svh flex-col">
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
        className="flex flex-1 flex-col px-4 py-6"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        {children}
      </main>
    </div>
  )
}
