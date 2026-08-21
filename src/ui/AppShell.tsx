import type { ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { BottomNav } from '../features/nav/BottomNav'
import { DesktopNav } from '../features/nav/DesktopNav'

interface AppShellProps {
  children: ReactNode
}

/**
 * Application frame (M7 prompt §10-11). Mobile gets a slim branding header plus a fixed bottom
 * navigation bar with a central quick-add; desktop gets a single top navigation row covering the
 * same five destinations plus Add (DesignSystem.md §4.2's "sidebar/top nav at ≥768px, not a
 * stretched phone tab bar" — a plain top row was the simpler choice that meets the same
 * requirement without inventing a persistent sidebar this app does not otherwise need).
 */
export function AppShell({ children }: AppShellProps) {
  const { status } = useAuth()
  const signedIn = status === 'signed-in'

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
        className="flex items-center border-b border-slate-800 px-4 py-3 md:hidden"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <span className="text-sm font-medium tracking-wide text-slate-300">PokePortfolio</span>
      </header>
      {signedIn ? <DesktopNav /> : null}
      <main
        className={
          signedIn
            ? 'flex flex-1 flex-col px-4 py-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6'
            : 'flex flex-1 flex-col px-4 py-6'
        }
        style={signedIn ? undefined : { paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
      >
        {children}
      </main>
      {signedIn ? <BottomNav /> : null}
    </div>
  )
}
