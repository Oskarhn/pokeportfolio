import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { SessionEndOutcome } from './end-session'
import type { IdentityAuthority } from './identity-lease'

export interface AuthState {
  /** `undefined` while the initial session is still being restored from storage. */
  status: 'loading' | 'signed-in' | 'signed-out'
  session: Session | null
  email: string | null
  isAdmin: boolean
  /** True while the profile row backing `isAdmin` is still being read. */
  profileLoading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  /** Ends local access unconditionally; the outcome separates that from remote revocation. */
  signOut: () => Promise<SessionEndOutcome>
  /** Set after a sign-out whose server-side revocation could not be confirmed (or whose local
   *  cleanup could not be verified); cleared by the next sign-in. Fixed text, never a raw error. */
  signOutNotice: string | null
  /** The tab's identity epoch (P145). Owned by AuthProvider for the tab's whole lifetime, so a lease
   *  taken from it stays observable after the page that took it has unmounted. */
  identity: IdentityAuthority
}

/**
 * Split from the provider component so the module exports exactly one thing and Fast Refresh
 * keeps working (`react-refresh/only-export-components`).
 */
export const AuthContext = createContext<AuthState | null>(null)
