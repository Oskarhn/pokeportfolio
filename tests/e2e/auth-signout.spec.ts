import { test, expect, type Page, type Route } from '@playwright/test'
import {
  buildFakeSessionObject,
  resolveFakeSessionOptions,
  FAKE_AUTH_STORAGE_KEY,
} from './support/fake-session'

/**
 * P143 / P130-22 — a deliberate "Sign out" must end LOCAL authenticated access even when the Auth
 * service cannot confirm the revocation, and a failed revocation must not let the old local
 * session come back to life on the next load.
 *
 * WHAT supabase-js 2.112.3 ACTUALLY DOES (read from the installed GoTrueClient, not recalled):
 * `signOut()` first loads the stored session. If the ACCESS token has expired it tries a refresh
 * first; a network failure there is an `AuthRetryableFetchError`, which `_signOut` returns
 * WITHOUT removing the stored session and WITHOUT emitting SIGNED_OUT. A still-valid token instead
 * goes on to the logout request, and any failure there removes the session locally. So the only
 * dangerous shape is "tab idle past token expiry + Auth unreachable": the button does nothing
 * visible and the session (refresh token included) stays in localStorage.
 *
 * Every Auth endpoint is mocked with `page.route`, so each case is deterministic and needs no
 * local Supabase; the real-GoTrue equivalent (a real refresh token that is genuinely still valid
 * server-side after the failed logout) is tests/e2e/authenticated/auth-signout-real.spec.ts.
 *
 * The sign-in state is seeded ONCE per tab (sessionStorage guard) — a plain `addInitScript` would
 * re-seed on every reload and defeat the resurrection check.
 */

const USER = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'p143-signout@example.test' }
const SIGN_OUT_NOTICE = /couldn.t confirm/i

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function sessionJson(expiresInSeconds: number, refreshToken = 'refresh-original'): string {
  return JSON.stringify(
    buildFakeSessionObject(
      resolveFakeSessionOptions({
        ...USER,
        expiresAtSeconds: nowSeconds() + expiresInSeconds,
        refreshToken,
      }),
    ),
  )
}

async function seedSessionOnce(page: Page, json: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window.sessionStorage.getItem('p143-seeded') !== null) return
      window.sessionStorage.setItem('p143-seeded', '1')
      window.localStorage.setItem(key, value)
    },
    [FAKE_AUTH_STORAGE_KEY, json] as [string, string],
  )
}

async function storedSession(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), FAKE_AUTH_STORAGE_KEY)
}

/** The idle-tab shape: the tab loaded with a live token; while it sat there the token expired. */
async function expireStoredAccessToken(page: Page): Promise<void> {
  await page.evaluate(
    ([key, past]) => {
      const raw = window.localStorage.getItem(key)
      if (raw === null) throw new Error('no stored session to expire')
      const parsed = JSON.parse(raw) as { expires_at: number }
      parsed.expires_at = past
      window.localStorage.setItem(key, JSON.stringify(parsed))
    },
    [FAKE_AUTH_STORAGE_KEY, nowSeconds() - 60] as [string, number],
  )
}

async function signedInAt(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(page.getByLabel('Notes')).toBeVisible()
}

async function clickSignOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
}

const abortAuth = (route: Route) => route.abort('connectionrefused')

test.describe('P143 — sign-out ends local access and never resurrects (mocked Auth endpoints)', () => {
  test.skip(({ isMobile }) => isMobile, 'viewport-independent; runs on desktop-chromium only')

  test('normal sign-out: server confirms, local session removed, no warning', async ({ page }) => {
    await seedSessionOnce(page, sessionJson(3600))
    await page.route('**/auth/v1/logout**', (route) => route.fulfill({ status: 204, body: '' }))
    await signedInAt(page, '/purchases/new')

    await clickSignOut(page)

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toHaveCount(0)
  })

  test('network failure during sign-out (token still valid): local access ends, and the person is told revocation is unconfirmed', async ({
    page,
  }) => {
    await seedSessionOnce(page, sessionJson(3600))
    await page.route('**/auth/v1/**', abortAuth)
    await signedInAt(page, '/purchases/new')

    await clickSignOut(page)

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toBeVisible()
  })

  test('expired access token + Auth unreachable (the idle-tab case): local access still ends', async ({
    page,
  }) => {
    await seedSessionOnce(page, sessionJson(300))
    await page.route('**/auth/v1/**', abortAuth)
    await signedInAt(page, '/purchases/new')
    await expireStoredAccessToken(page)

    await clickSignOut(page)

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect(page.getByLabel('Notes')).toHaveCount(0)
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toBeVisible()
  })

  test('failed remote revocation does not let the old local session come back on reload', async ({
    page,
  }) => {
    await seedSessionOnce(page, sessionJson(300, 'refresh-still-valid-server-side'))
    await page.route('**/auth/v1/**', abortAuth)
    await signedInAt(page, '/purchases/new')
    await expireStoredAccessToken(page)
    await clickSignOut(page)
    // Soft: on the released base the button does nothing visible here, and the reload step below
    // is what demonstrates the resurrection; both failures should be reported together.
    await expect.soft(page).toHaveURL(/\/login/, { timeout: 10_000 })

    // The Auth service comes back — and, because the logout never reached it, it would still
    // ACCEPT the old refresh token. That is exactly what would resurrect a session that only
    // React state pretended to end.
    await page.unroute('**/auth/v1/**')
    let refreshCalls = 0
    await page.route('**/auth/v1/token**', (route) => {
      refreshCalls += 1
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: sessionJson(3600, 'refresh-rotated'),
      })
    })

    await page.reload()

    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    expect(await storedSession(page)).toBeNull()
    expect(refreshCalls).toBe(0)
  })

  test('Auth server error on logout (HTTP 500): local access ends and the person is told revocation is unconfirmed', async ({
    page,
  }) => {
    await seedSessionOnce(page, sessionJson(3600))
    await page.route('**/auth/v1/logout**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'internal upstream detail that must never reach the UI' }),
      }),
    )
    await signedInAt(page, '/purchases/new')

    await clickSignOut(page)

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
    await expect(page.getByText(SIGN_OUT_NOTICE)).toBeVisible()
    // Never the raw error.
    await expect(page.getByText(/internal upstream detail/i)).toHaveCount(0)
  })

  test('expired session whose refresh token the server rejects: session is already dead, sign-out completes, no false alarm', async ({
    page,
  }) => {
    await seedSessionOnce(page, sessionJson(300))
    await page.route('**/auth/v1/token**', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'refresh_token_not_found',
          error_code: 'refresh_token_not_found',
          message: 'Invalid Refresh Token: Refresh Token Not Found',
        }),
      }),
    )
    await page.route('**/auth/v1/logout**', abortAuth)
    await signedInAt(page, '/purchases/new')
    await expireStoredAccessToken(page)

    await clickSignOut(page)

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
    await expect.poll(() => storedSession(page)).toBeNull()
  })
})
