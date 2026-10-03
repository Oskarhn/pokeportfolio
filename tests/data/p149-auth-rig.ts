import { vi } from 'vitest'
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { createAppSupabaseClient } from '../../src/data/supabase-factory'

/**
 * P149 — a REAL supabase-js auth client (the installed auth-js, in-memory storage) whose network is
 * scripted. Shared by the contract test (what `getSession()` does) and the credential-provider tests
 * (what the identity lease makes of it), so both talk about the same library behaviour.
 *
 * The library backs off for ~25 s when the refresh endpoint is unreachable; tests run it under fake
 * timers (`vi.useFakeTimers`) and advance the clock instead of waiting.
 */

export const AUTH_URL_BASE = 'http://gotrue.test'
const REFRESH_PATH = '/auth/v1/token'

export class MemoryStorage {
  readonly map = new Map<string, string>()
  failReads = false
  getItem(key: string): string | null {
    if (this.failReads) throw new Error('storage read failed')
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export function sessionJson(options: {
  user?: string
  access?: string
  refresh?: string
  expired?: boolean
}): Record<string, unknown> {
  const user = options.user ?? 'user-a'
  return {
    access_token: options.access ?? 'access-1',
    refresh_token: options.refresh ?? 'refresh-1',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: options.expired ? nowSeconds() - 120 : nowSeconds() + 3600,
    user: {
      id: user,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  }
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** What the auth service answers to a refresh request. */
export type RefreshAnswer = (attempt: number) => Response | Promise<Response>

export const NETWORK_DOWN: RefreshAnswer = () => {
  throw new TypeError('Failed to fetch')
}
export const SERVICE_UNAVAILABLE: RefreshAnswer = () =>
  json(503, { message: 'Service Unavailable' })
export const REFRESH_TOKEN_REJECTED: RefreshAnswer = () =>
  json(400, {
    code: 400,
    error_code: 'refresh_token_not_found',
    msg: 'Invalid Refresh Token: Refresh Token Not Found',
  })
export const refreshOk =
  (access = 'access-2', refresh = 'refresh-2', user = 'user-a'): RefreshAnswer =>
  () =>
    json(200, sessionJson({ access, refresh, user }))

export interface AuthRig {
  client: SupabaseClient
  storage: MemoryStorage
  key: string
  events: { event: AuthChangeEvent; user: string | null }[]
  refreshAttempts: number
  refresh: RefreshAnswer
  seed: (session: Record<string, unknown>) => void
  stored: () => Session | null
}

export async function makeAuthRig(): Promise<AuthRig> {
  const storage = new MemoryStorage()
  const key = 'sb-p149-auth-token'
  const rig = {} as AuthRig
  rig.storage = storage
  rig.key = key
  rig.events = []
  rig.refreshAttempts = 0
  rig.refresh = refreshOk()
  const fetchStub: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (url.pathname === REFRESH_PATH && url.searchParams.get('grant_type') === 'refresh_token') {
      rig.refreshAttempts += 1
      return rig.refresh(rig.refreshAttempts)
    }
    return json(404, { message: `unexpected ${url.pathname}` })
  }
  rig.client = createAppSupabaseClient(
    AUTH_URL_BASE,
    'publishable-key',
    {},
    {
      auth: {
        storageKey: key,
        storage,
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
      },
      baseFetch: fetchStub,
    },
  )
  rig.client.auth.onAuthStateChange((event, session) => {
    rig.events.push({ event, user: session?.user.id ?? null })
  })
  // Subscribing makes the library look the (empty) storage up once, asynchronously (INITIAL_SESSION).
  // Let that finish first, so a test that then breaks the storage is not also breaking that lookup.
  await vi.advanceTimersByTimeAsync(10)
  rig.seed = (session) => {
    storage.setItem(key, JSON.stringify(session))
  }
  rig.stored = () => {
    const raw = storage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as Session)
  }
  return rig
}

/** Fake time, fixed start: the auth client's expiry arithmetic and its 60 s failure cache read `Date`. */
export function useAuthFakeTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-09-19T10:00:00Z'))
}
