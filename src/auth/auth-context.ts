import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface AuthState {
  /** `undefined` while the initial session is still being restored from storage. */
  status: 'loading' | 'signed-in' | 'signed-out'
  session: Session | null
  email: string | null
  isAdmin: boolean
  /** True while the profile row backing `isAdmin` is still being read. */
  profileLoading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

/**
 * Split from the provider component so the module exports exactly one thing and Fast Refresh
 * keeps working (`react-refresh/only-export-components`).
 */
export const AuthContext = createContext<AuthState | null>(null)
