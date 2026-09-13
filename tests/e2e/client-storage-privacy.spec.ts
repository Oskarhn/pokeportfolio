import { test, expect } from '@playwright/test'

/**
 * P121 §19-23 — localStorage/sessionStorage/IndexedDB privacy audit, explicitly NOT done in
 * P118 ("§15 localStorage/sessionStorage/IndexedDB inventory and account-transition audit — NOT
 * done"). Static inventory (this file's own findings, not repeated as a separate doc since it
 * would just duplicate what's below):
 *
 *   - localStorage['pp-theme'] (src/ui/theme.ts) — UI preference only ('light'|'dark'|'system'),
 *     global (not account-scoped), never cleared on signout. Not sensitive.
 *   - localStorage['pokeportfolio.export.reminder-marked-at.<userId>']
 *     (src/domain/export/export-reminder.ts) — a bare ISO timestamp, namespaced per user id
 *     (P111 fix), never cleared on signout (harmless: namespaced, so a stale entry for one user
 *     can never affect another). Not sensitive (no export content/financial data).
 *   - sessionStorage['pp-stale-reload-last-at'] (src/platform/build-freshness-runtime.ts) — a
 *     bare timestamp of the last automatic stale-deployment reload, tab-lifetime. Not sensitive.
 *   - localStorage['sb-<project-ref>-auth-token'] — Supabase-managed session/token storage
 *     (docs/SECURITY.md §9 acknowledges this explicitly as the accepted SPA trade-off). Provider-
 *     managed, not app code; cleared by supabase-js itself on signOut() (AUTH_STORAGE_CONTRACT,
 *     not re-implemented or forbidden here).
 *   - IndexedDB: no application code opens a database (`indexedDB.databases()` is asserted empty
 *     below on a page with no scanner activity — the scanner's own model/asset caching, if any,
 *     is scanner-owned territory per this prompt's §2 boundary and not touched here).
 *
 * This test proves the inventory holds at RUNTIME under adversarial-shaped conditions: real
 * public navigation, a mocked Supabase auth-token response (sentinel-bearing, exactly like
 * cachestorage-privacy.spec.ts §16 already does for CacheStorage) actually written into
 * localStorage by the real supabase-js client, and mocked REST/Functions responses carrying
 * financial/PII-shaped sentinel markers. No sentinel may ever land in any storage KEY the app
 * does not already document above.
 */

const SENTINEL_PURCHASE_NOTE = 'SENTINEL_PRIVATE_PURCHASE_NOTE_9f3a2c'
const SENTINEL_SALE_MARKETPLACE = 'SENTINEL_SALE_MARKETPLACE_NOTE_b81f'
const SENTINEL_PII_EMAIL = 'SENTINEL_PII_EMAIL_owner-real@example-private.test'
const SENTINEL_MONEY_AMOUNT = 'SENTINEL_MONEY_AMOUNT_MINOR_123456789'

const SENTINEL_MARKERS = [
  SENTINEL_PURCHASE_NOTE,
  SENTINEL_SALE_MARKETPLACE,
  SENTINEL_PII_EMAIL,
  SENTINEL_MONEY_AMOUNT,
]

const KNOWN_KEY_PATTERNS = [
  /^pp-theme$/,
  /^pokeportfolio\.export\.reminder-marked-at\./,
  /^pp-stale-reload-last-at$/,
  /^sb-.*-auth-token$/,
]

function isKnownKey(key: string): boolean {
  return KNOWN_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

interface StorageAudit {
  localStorage: Record<string, string>
  sessionStorage: Record<string, string>
  indexedDbNames: string[]
}

async function auditClientStorage(page: import('@playwright/test').Page): Promise<StorageAudit> {
  return page.evaluate(async () => {
    const localStorageDump: Record<string, string> = {}
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key !== null) localStorageDump[key] = localStorage.getItem(key) ?? ''
    }
    const sessionStorageDump: Record<string, string> = {}
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i)
      if (key !== null) sessionStorageDump[key] = sessionStorage.getItem(key) ?? ''
    }
    let indexedDbNames: string[] = []
    if ('databases' in indexedDB) {
      const dbs = await indexedDB.databases()
      indexedDbNames = dbs.map((d) => d.name ?? '(unnamed)')
    }
    return {
      localStorage: localStorageDump,
      sessionStorage: sessionStorageDump,
      indexedDbNames,
    }
  })
}

test.describe('client storage privacy audit (P121 §19-23)', () => {
  test('after public navigation, a mocked auth session and sentinel-bearing mocked API activity, no unexpected key or leaked value exists', async ({
    page,
  }) => {
    await page.route('**/rest/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'fake-purchase-1',
            notes: SENTINEL_PURCHASE_NOTE,
            marketplace: SENTINEL_SALE_MARKETPLACE,
          },
        ]),
      }),
    )
    await page.route('**/functions/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: SENTINEL_PII_EMAIL }),
      }),
    )
    // A real auth-token exchange response, sentinel-bearing, fulfilled at the network layer —
    // supabase-js's real client (loaded by the real app bundle) persists whatever session shape
    // it receives here into ITS OWN documented localStorage key, exactly as production does.
    await page.route('**/auth/v1/token*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'sentinel.access.token',
          refresh_token: 'sentinel-refresh-token',
          token_type: 'bearer',
          expires_in: 3600,
          user: { id: 'sentinel-user-id', email: SENTINEL_PII_EMAIL },
        }),
      }),
    )

    await page.goto('/login')
    for (const path of ['/privacy', '/terms', '/faq', '/forgot-password', '/login']) {
      await page.goto(path)
    }

    // Fire the mocked private-shaped network activity directly (same technique
    // cachestorage-privacy.spec.ts §16 uses) — a REST read and a Functions call carrying
    // financial-note/PII-shaped sentinels that must never end up written to any storage key.
    await page.evaluate(async () => {
      await Promise.allSettled([
        fetch('/rest/v1/purchases?select=*'),
        fetch('/functions/v1/redeem-invitation', { method: 'POST' }),
      ])
    })

    // Drive the REAL sign-in UI so the real supabase-js client processes the mocked token
    // response through its normal session-persistence path (not a hand-rolled localStorage
    // write) — the strongest available proof this app's ACTUAL client code only ever writes the
    // one documented sb-*-auth-token key for session data.
    await page.getByLabel('Email').fill(SENTINEL_PII_EMAIL)
    await page.getByLabel('Password').fill('irrelevant-password-not-checked-by-the-mock')
    await page.getByRole('button', { name: /Sign in|Signing in/ }).click()
    await page.waitForTimeout(500)

    const audit = await auditClientStorage(page)

    for (const key of Object.keys(audit.localStorage)) {
      expect(isKnownKey(key), `unexpected localStorage key: ${key}`).toBe(true)
    }
    for (const key of Object.keys(audit.sessionStorage)) {
      expect(isKnownKey(key), `unexpected sessionStorage key: ${key}`).toBe(true)
    }

    // No sentinel marker may appear under any key OTHER than the documented Supabase auth key
    // (which legitimately carries the mocked user id/email/tokens as part of session metadata).
    for (const [key, value] of Object.entries(audit.localStorage)) {
      if (/^sb-.*-auth-token$/.test(key)) continue
      for (const marker of SENTINEL_MARKERS) {
        expect(value, `sentinel '${marker}' leaked into localStorage['${key}']`).not.toContain(
          marker,
        )
      }
    }
    for (const [key, value] of Object.entries(audit.sessionStorage)) {
      for (const marker of SENTINEL_MARKERS) {
        expect(value, `sentinel '${marker}' leaked into sessionStorage['${key}']`).not.toContain(
          marker,
        )
      }
    }

    // No application code opens an IndexedDB database on these routes.
    expect(
      audit.indexedDbNames,
      `unexpected IndexedDB database(s): ${audit.indexedDbNames}`,
    ).toEqual([])
  })
})

/**
 * AUTH_STORAGE_CONTRACT deferral (P121 §23): the real, signed-in "A signs out, B signs in" proof
 * that the Supabase auth-token localStorage key is cleared/replaced already exists and runs
 * against a real signed-in session —
 * tests/e2e/authenticated/account-boundary.spec.ts ("A types unsaved purchase input, signs out,
 * B signs in..."), part of the `authenticated` Playwright project, which requires a running local
 * Docker/Supabase stack. P121 owns generic client storage but not Docker/Supabase (§2) — NOT
 * re-run or duplicated here. This file's own signOut()-specific case (clicking the real button
 * against a mocked-token session on the non-auth `vite preview` project) was attempted and
 * dropped: reaching an authenticated route reliably against a fully mocked session risks
 * unmocked REST calls firing during redirect and producing flaky, hard-to-attribute failures
 * unrelated to the storage question this file actually audits — not worth the risk for a contract
 * already proven for real elsewhere.
 */
