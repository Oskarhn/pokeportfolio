import { classifyFailure, type Failure } from '../net/failure'
import { Emitter } from '../state/registry'
import type { IdentityAuthority } from './identity-authority'

/**
 * The native counterpart of the web `AuthProvider`'s behaviour (not its code: that file is coupled
 * to react-router, the query client and browser storage). It feeds ONE identity authority from the
 * events supabase-js reports and fires the identity boundary when the identity really changes.
 *
 *   TOKEN_REFRESHED / USER_UPDATED / repeated SIGNED_IN  -> same user, nothing is reset (unsaved work
 *                                                          survives a token refresh)
 *   sign in as A, A -> B directly, A -> signed out        -> boundary fires SYNCHRONOUSLY, before any
 *                                                          screen can render the new identity
 *
 * SPIKE_ONLY: when P149 releases, `AuthProvider` + `IdentityAuthority` there are the single source of
 * truth and this controller collapses into a thin native adapter around them. Until then this class
 * only records what supabase-js reports; it never keeps its own copy of the session.
 */

export interface SessionLike {
  user: { id: string; email?: string | undefined }
}

interface AuthErrorLike {
  name?: string
  message: string
  status?: number
  code?: string
}

/** The subset of `SupabaseClient['auth']` this controller uses (structurally satisfied by it). */
export interface AuthClientPort {
  onAuthStateChange(
    callback: (event: string, session: SessionLike | null) => void | Promise<void>,
  ): {
    data: { subscription: { unsubscribe(): void } }
  }
  signInWithPassword(credentials: { email: string; password: string }): Promise<{
    data: { session: SessionLike | null }
    error: AuthErrorLike | null
  }>
  signOut(options?: {
    scope?: 'global' | 'local' | 'others'
  }): Promise<{ error: AuthErrorLike | null }>
  getSession(): Promise<{ data: { session: SessionLike | null }; error: AuthErrorLike | null }>
}

export type AuthStatus = 'initializing' | 'signed_out' | 'signed_in' | 'session_check_failed'

export interface AuthSnapshot {
  status: AuthStatus
  userId: string | null
  email: string | null
  epoch: number
  /** Set when a sign-out could not fully remove the stored session, or a session check failed. */
  notice: Failure | null
}

export type SignInResult =
  | { ok: true }
  | { ok: false; kind: 'invalid_credentials'; message: string }
  | { ok: false; kind: 'failure'; failure: Failure }

export interface AuthControllerDeps {
  auth: AuthClientPort
  authority: IdentityAuthority
  /** Fired synchronously on every real identity change (the identity boundary). */
  onIdentityChange: (userId: string | null) => void
  /** Removes the stored session through the SAME adapter the client reads (P143). */
  removeStoredSession: () => Promise<void>
}

export class AuthController {
  private snapshot: AuthSnapshot
  private readonly emitter = new Emitter()
  private unsubscribe: (() => void) | null = null
  private pendingCheck: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: AuthControllerDeps) {
    this.snapshot = {
      status: 'initializing',
      userId: null,
      email: null,
      epoch: deps.authority.epoch,
      notice: null,
    }
  }

  subscribe = this.emitter.subscribe

  getSnapshot = (): AuthSnapshot => this.snapshot

  start(): () => void {
    if (this.unsubscribe !== null) return this.unsubscribe
    const { data } = this.deps.auth.onAuthStateChange((event, session) => {
      this.handle(event, session)
    })
    this.unsubscribe = () => {
      data.subscription.unsubscribe()
      if (this.pendingCheck !== null) clearTimeout(this.pendingCheck)
      this.unsubscribe = null
    }
    return this.unsubscribe
  }

  private set(next: Partial<AuthSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next, epoch: this.deps.authority.epoch }
    this.emitter.emit()
  }

  private handle(event: string, session: SessionLike | null): void {
    const userId = session?.user.id ?? null
    if (this.deps.authority.observe(userId)) this.deps.onIdentityChange(userId)
    if (userId !== null) {
      this.set({ status: 'signed_in', userId, email: session?.user.email ?? null, notice: null })
      return
    }
    if (event === 'INITIAL_SESSION') {
      // A null session at start is ambiguous: nobody signed in, OR the stored session could not be
      // refreshed because the network was down (auth-js reports both as a null session). Ask again
      // after the callback returns (calling getSession inside it can deadlock auth-js's lock).
      this.pendingCheck = setTimeout(() => {
        void this.checkStoredSession()
      }, 0)
      return
    }
    this.set({ status: 'signed_out', userId: null, email: null })
  }

  async checkStoredSession(): Promise<void> {
    const { data, error } = await this.deps.auth.getSession()
    if (data.session !== null) return // the auth event path already reported it
    if (error !== null) {
      this.set({
        status: 'session_check_failed',
        userId: null,
        email: null,
        notice: classifyFailure(error),
      })
    } else {
      this.set({ status: 'signed_out', userId: null, email: null, notice: null })
    }
  }

  async retrySessionCheck(): Promise<void> {
    this.set({ status: 'initializing', notice: null })
    await this.checkStoredSession()
  }

  async signIn(email: string, password: string): Promise<SignInResult> {
    try {
      const { error } = await this.deps.auth.signInWithPassword({ email, password })
      if (error === null) return { ok: true }
      if (error.status === 400 || error.code === 'invalid_credentials') {
        return {
          ok: false,
          kind: 'invalid_credentials',
          message: 'Email or password is not correct.',
        }
      }
      return { ok: false, kind: 'failure', failure: classifyFailure(error) }
    } catch (error) {
      return { ok: false, kind: 'failure', failure: classifyFailure(error) }
    }
  }

  /**
   * Deliberate sign-out. The identity ends FIRST (retire), so no in-flight operation can start another
   * step under the old identity while the request to the server is pending. `signOut` can leave the
   * stored session in place (auth-js returns early when its own token refresh fails offline); the
   * stored copy is therefore removed explicitly (P143), and the person is signed out locally even if
   * the server could not be told.
   */
  async signOut(): Promise<void> {
    if (this.deps.authority.retire()) this.deps.onIdentityChange(null)
    this.set({ status: 'signed_out', userId: null, email: null, notice: null })
    let notice: Failure | null = null
    try {
      const { error } = await this.deps.auth.signOut({ scope: 'local' })
      if (error !== null) notice = classifyFailure(error)
    } catch (error) {
      notice = classifyFailure(error)
    }
    try {
      await this.deps.removeStoredSession()
    } catch {
      notice = classifyFailure(new Error('unknown'))
    }
    if (notice !== null) this.set({ notice })
  }
}

/** Minimal AppState surface (react-native's `AppState`). */
export interface AppStateLike {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void }
}

/**
 * Supabase's documented React Native pattern: refresh tokens only while the app is in the
 * foreground (a JS timer does not run reliably in the background). Returns the detach function.
 */
export function attachForegroundRefresh(
  auth: { startAutoRefresh(): Promise<void>; stopAutoRefresh(): Promise<void> },
  appState: AppStateLike,
  initialState: string,
): () => void {
  if (initialState === 'active') void auth.startAutoRefresh()
  const subscription = appState.addEventListener('change', (state) => {
    if (state === 'active') void auth.startAutoRefresh()
    else void auth.stopAutoRefresh()
  })
  return () => {
    subscription.remove()
  }
}
