import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/useAuth'
import { BottomNav } from '../features/nav/BottomNav'
import { DesktopNav } from '../features/nav/DesktopNav'
import { getMyProfile } from '../data/profile'
import { applyTheme } from './theme'
import { StaleDeploymentBanner } from './StaleDeploymentBanner'

interface AppShellProps {
  children: ReactNode
}

/**
 * Application frame (M7.1 prompt §9-11). No global wordmark here any more — "PokePortfolio" was
 * repeated top-left on every authenticated screen (M7), which the owner flagged as mechanical
 * branding. The brand now appears only on Home (mobile) and the auth screens; every other screen's
 * identity comes from the active nav tab. Desktop nav renders its own top row; mobile has none —
 * BottomNav is the mobile chrome, full stop.
 */
export function AppShell({ children }: AppShellProps) {
  const { status } = useAuth()
  const signedIn = status === 'signed-in'

  // Applies the signed-in user's theme preference as soon as the profile is available. Shares the
  // ['my-profile'] query with ProfilePage/HomePage — one network round trip, not a duplicate.
  // index.html's inline bootstrap script already applied the last-known preference from
  // localStorage before first paint, so this only ever corrects drift (e.g. a fresh sign-in on a
  // browser that last held a different account's preference).
  useQuery({
    queryKey: ['my-profile'],
    queryFn: getMyProfile,
    enabled: signedIn,
    select: (profile) => {
      applyTheme(profile.theme)
      return profile
    },
  })

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
      <StaleDeploymentBanner />
      {!signedIn ? (
        <header
          className="flex items-center px-4 py-3 md:hidden"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <span className="text-sm font-semibold tracking-wide text-slate-200">PokePortfolio</span>
        </header>
      ) : null}
      {signedIn ? <DesktopNav /> : null}
      <main
        className={
          signedIn
            ? 'flex flex-1 flex-col px-4 py-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-6'
            : 'flex flex-1 flex-col px-4 py-6'
        }
        style={
          signedIn
            ? { paddingTop: 'max(0, env(safe-area-inset-top))' }
            : { paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }
        }
      >
        {children}
      </main>
      {signedIn ? <BottomNav /> : null}
    </div>
  )
}
