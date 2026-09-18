import { createClient } from '@supabase/supabase-js'
import { test, expect, type Page } from '@playwright/test'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type SyntheticUser,
} from '../../db/setup'

/**
 * P143 / P130-22 against a REAL local GoTrue. The mocked-endpoint matrix (tests/e2e/
 * auth-signout.spec.ts) proves the client behaviour deterministically; this file adds what only a
 * real Auth server can show:
 *
 *   - "server confirmed" really means the refresh token is dead afterwards, and
 *   - "server unconfirmed" really means it is NOT — the old refresh token is still valid at the
 *     server after a failed logout. That is exactly the credential a session that only React
 *     pretended to end would have resurrected on the next load.
 *
 * Each test signs in its own disposable user through the real login form; `signOut()` is GLOBAL
 * scope, so the shared `e2e-auth` session must never be used here (P112).
 */

test.use({ storageState: { cookies: [], origins: [] } })

const supabaseUrl = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
const SIGN_OUT_NOTICE = /couldn.t confirm/i

let user: SyntheticUser | null = null

test.beforeEach(async ({ page }) => {
  const service = createServiceClient()
  user = await createSyntheticUser(service, 'p143-signout')
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  await page.goto('/purchases/new')
  await expect(page.getByLabel('Notes')).toBeVisible()
})

test.afterEach(async () => {
  if (user !== null) await deleteSyntheticUser(createServiceClient(), user.id)
  user = null
})

async function storedRefreshToken(page: Page): Promise<string> {
  const token = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as { refresh_token: string }).refresh_token
  }, STORAGE_KEY)
  if (token === null) throw new Error('no stored session to read a refresh token from')
  return token
}

async function storedSession(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
}

async function expireStoredAccessToken(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (raw === null) throw new Error('no stored session to expire')
    const parsed = JSON.parse(raw) as { expires_at: number }
    parsed.expires_at = Math.floor(Date.now() / 1000) - 60
    window.localStorage.setItem(key, JSON.stringify(parsed))
  }, STORAGE_KEY)
}

/** Would the SERVER still accept this refresh token? (Consumes it — call last.) */
async function serverStillAccepts(refreshToken: string): Promise<boolean> {
  const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.refreshSession({ refresh_token: refreshToken })
  return error === null
}

const abortAuth = (route: { abort: (reason: string) => Promise<void> }) =>
  route.abort('connectionrefused')

test.describe('P143 — real sign-out semantics', () => {
  test('normal sign-out: the server really revokes the refresh token, and no warning is shown', async ({
    page,
  }) => {
    const refreshToken = await storedRefreshToken(page)

    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toHaveCount(0)
    expect(await serverStillAccepts(refreshToken)).toBe(false)
  })

  test('logout unreachable (token valid): local access ends, warning shown, and the server token is honestly still alive', async ({
    page,
  }) => {
    const refreshToken = await storedRefreshToken(page)
    await page.route('**/auth/v1/logout**', abortAuth)

    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toBeVisible()
    // The warning is TRUE: revocation really did not happen.
    expect(await serverStillAccepts(refreshToken)).toBe(true)
  })

  test('expired token + Auth unreachable, then Auth returns: reload does NOT resurrect the session', async ({
    page,
  }) => {
    const refreshToken = await storedRefreshToken(page)
    await page.route('**/auth/v1/**', abortAuth)
    await expireStoredAccessToken(page)

    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(page.getByLabel('Notes')).toHaveCount(0)
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toBeVisible()

    // Auth is back. The refresh token was never revoked, so the server would happily accept it.
    await page.unroute('**/auth/v1/**')
    let tokenRequests = 0
    page.on('request', (request) => {
      if (request.url().includes('/auth/v1/token')) tokenRequests += 1
    })

    await page.reload()

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page).toHaveURL(/\/login/)
    expect(await storedSession(page)).toBeNull()
    expect(tokenRequests).toBe(0)
    // Premise check: it really was a live credential the whole time.
    expect(await serverStillAccepts(refreshToken)).toBe(true)
  })

  test('expired token but Auth reachable: the library refreshes and revokes for real; confirmed, no warning', async ({
    page,
  }) => {
    await expireStoredAccessToken(page)

    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toHaveCount(0)
  })
})
