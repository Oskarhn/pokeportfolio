import type { Page } from '@playwright/test'

/**
 * P119: reaches `/scan` (behind `RequireSession`, src/router.tsx) WITHOUT the real local Supabase
 * stack that `tests/e2e/authenticated/**` needs — this session's own scope explicitly forbids
 * touching Docker/Supabase (owned by a parallel session).
 *
 * `AuthProvider.tsx` calls `supabase.auth.getSession()` on mount, which resolves from
 * `localStorage` alone (supabase-js's default storage) without any network round trip as long as
 * the stored session's `expires_at` is in the future — no signature verification happens
 * client-side (`getSession()` trusts local storage; only `getUser()` calls the server to verify).
 * Seeding a well-formed-but-synthetic session under supabase-js's own storage key therefore makes
 * `RequireSession` render its children directly against the PLACEHOLDER-backend preview server
 * (the same one every non-authenticated E2E test already runs against) — confirmed empirically
 * this session (a throwaway spike navigated to `/scan` with this exact seed and got the real
 * `ScannerPage` "Scan cards" heading, zero console errors, zero network failures).
 *
 * What this does NOT give you: any REAL backend behavior. Every `/rest/v1/**` call (catalog
 * search, `add_card_acquisition`, the profile `is_admin` read) still hits the placeholder
 * `http://127.0.0.1:54321` with nothing listening — it fails exactly like every other
 * non-authenticated E2E test's backend calls already fail (playwright.config.ts's own documented
 * posture: "every network call failing identically is what makes those assertions
 * deterministic"). This is sufficient for the scanner's CAMERA/OCR/visual-worker layer — none of
 * which touches the network at all (prompt §6/§28) — but NOT for testing `commitBatch` actually
 * saving a card, manual catalog search returning real results, or anything RLS-gated. Those stay
 * the authenticated project's job.
 *
 * supabase-js derives its localStorage key as `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-
 * auth-token` (confirmed by reading the installed 2.112.3 bundle directly) — for this project's
 * placeholder build URL `http://127.0.0.1:54321`, that hostname is `127.0.0.1`, so the key is
 * `sb-127-auth-token`. Hardcoded here rather than re-derived at runtime: this file only needs to
 * match playwright.config.ts's own hardcoded placeholder URL, not compute the general case.
 */
const SUPABASE_AUTH_STORAGE_KEY = 'sb-127-auth-token'

/** The placeholder-backend build's supabase-js storage key. It is also the name of the
 *  `BroadcastChannel` supabase-js uses for cross-tab auth events (GoTrueClient builds the channel
 *  from `storageKey`), which P143's cross-tab tests rely on. */
export const FAKE_AUTH_STORAGE_KEY = SUPABASE_AUTH_STORAGE_KEY

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

const DEFAULT_USER_ID = '11111111-1111-4111-8111-111111111111'
const DEFAULT_EMAIL = 'p119-e2e-mock@example.test'

export interface FakeSessionOptions {
  userId?: string
  email?: string
  /** Absolute expiry (unix seconds); defaults to one hour from now. P143's sign-out tests need a
   *  session whose access token expired while the tab sat idle. */
  expiresAtSeconds?: number
  /** Tells two rotations of the SAME identity apart (P143: TOKEN_REFRESHED for one user). */
  refreshToken?: string
}

/** Fills every optional field of {@link FakeSessionOptions} with its default. */
export function resolveFakeSessionOptions(
  options: FakeSessionOptions = {},
): Required<FakeSessionOptions> {
  return {
    userId: options.userId ?? DEFAULT_USER_ID,
    email: options.email ?? DEFAULT_EMAIL,
    expiresAtSeconds: options.expiresAtSeconds ?? Math.floor(Date.now() / 1000) + 3600,
    refreshToken: options.refreshToken ?? 'e2e-fake-refresh-token',
  }
}

/** A syntactically well-formed but NOT cryptographically valid JWT — sufficient because
 *  supabase-js's `getSession()` never verifies the signature client-side; only a real
 *  network-backed `getUser()` call would, and nothing in the scanner's own code path calls that. */
function buildFakeSession(options: Required<FakeSessionOptions>): string {
  return JSON.stringify(buildFakeSessionObject(options))
}

/** The session as a plain object: what supabase-js stores, and what a cross-tab auth broadcast
 *  or a mocked token-endpoint response carries. */
export function buildFakeSessionObject(options: Required<FakeSessionOptions>): {
  access_token: string
  token_type: string
  expires_in: number
  expires_at: number
  refresh_token: string
  user: Record<string, unknown>
} {
  const jwt = [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({
      sub: options.userId,
      role: 'authenticated',
      aud: 'authenticated',
      exp: options.expiresAtSeconds,
      email: options.email,
    }),
    'e2e-fake-signature-never-verified-clientside',
  ].join('.')

  return {
    access_token: jwt,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: options.expiresAtSeconds,
    refresh_token: options.refreshToken,
    user: {
      id: options.userId,
      aud: 'authenticated',
      role: 'authenticated',
      email: options.email,
      email_confirmed_at: '2024-01-01T00:00:00.000Z',
      phone: '',
      confirmed_at: '2024-01-01T00:00:00.000Z',
      last_sign_in_at: '2024-01-01T00:00:00.000Z',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      identities: [],
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    },
  }
}

/** Must run BEFORE the app's own scripts (via `addInitScript`) so `AuthProvider`'s first
 *  `getSession()` call already finds the seeded session in localStorage. */
export async function installFakeSession(
  page: Page,
  options: FakeSessionOptions = {},
): Promise<void> {
  const sessionJson = buildFakeSession(resolveFakeSessionOptions(options))
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value)
    },
    [SUPABASE_AUTH_STORAGE_KEY, sessionJson] as [string, string],
  )
}

/**
 * P143: plays the part of ANOTHER tab of the same browser profile changing the shared auth
 * state, exactly the way supabase-js does it: write the new session to the shared storage key,
 * then post `{ event, session }` on the `BroadcastChannel` named after that key. Every other
 * tab's client turns that message into an `onAuthStateChange` callback. `page` only needs to be
 * same-origin with the app under test; it does not have to run the app itself.
 *
 * `session: null` models a sign-out (storage entry removed, `SIGNED_OUT` broadcast).
 */
export async function simulateOtherTabAuthChange(
  page: Page,
  change: {
    event: 'SIGNED_IN' | 'TOKEN_REFRESHED' | 'USER_UPDATED' | 'SIGNED_OUT'
    session: object | null
  },
): Promise<void> {
  await page.evaluate(
    ([key, event, session]) => {
      if (session === null) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, JSON.stringify(session))
      const channel = new BroadcastChannel(key)
      channel.postMessage({ event, session })
      channel.close()
    },
    [SUPABASE_AUTH_STORAGE_KEY, change.event, change.session] as [string, string, object | null],
  )
}
