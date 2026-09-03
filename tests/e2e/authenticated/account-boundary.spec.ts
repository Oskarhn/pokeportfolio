import { test, expect } from '@playwright/test'
import { createServiceClient, createSyntheticUser, deleteSyntheticUser } from '../../db/setup'

/**
 * P94 §22 — real, signed-in account-switch privacy proof: A's unsaved in-memory work must never
 * be visible to B after a same-tab sign-out/sign-in, mirroring D-093's cross-account query-cache
 * boundary (SECURITY.md §9.1) but exercised through a real browser session rather than only unit
 * tests of the cache-clearing logic itself.
 *
 * The `desktop-chromium-authenticated` project's storageState already signs the page in as
 * synthetic user A (auth.setup.ts). This spec creates its OWN second synthetic user B — never a
 * production account — and cleans it up in its own `afterEach`, independent of the shared
 * `teardown` project (which only ever owns user A).
 */

test.describe('Account-switch privacy: unsaved purchase input does not leak across a sign-out', () => {
  let userB: { id: string; email: string; password: string } | null = null

  test.afterEach(async () => {
    if (userB === null) return
    const service = createServiceClient()
    await deleteSyntheticUser(service, userB.id)
    userB = null
  })

  test("A types unsaved purchase input, signs out, B signs in — B sees an empty form, not A's text", async ({
    page,
  }) => {
    // A (already signed in via storageState) types real unsaved input.
    await page.goto('/purchases/new')
    await page.getByLabel('Shipping').fill('12345')
    await expect(page.getByLabel('Shipping')).toHaveValue('12345')

    // A signs out through the real UI.
    await page.goto('/profile')
    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 15_000 })

    // A SECOND synthetic user (B) — created fresh here, deleted in afterEach.
    const service = createServiceClient()
    const created = await createSyntheticUser(service, 'e2e-boundary-b')
    userB = created

    await page.getByLabel('Email').fill(created.email)
    await page.getByLabel('Password').fill(created.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })

    // B navigates to the SAME form A left unsaved input in. A fresh in-memory React tree (a full
    // navigation, not a client-side route transition, since sign-out/sign-in reloads the app) has
    // no way to inherit A's component state — this proves there is no OUT-OF-BAND leak (a stale
    // cache entry, a registry the identity-change boundary forgot to clear) either.
    await page.goto('/purchases/new')
    await expect(page.getByLabel('Shipping')).toHaveValue('')
  })

  // NOT COVERED this session (P94, disclosed rather than shipped as a weak test): a real scanner
  // batch requires either a live camera (unavailable in this headless environment without a
  // `--use-fake-device-for-media-stream` Chromium launch flag this session did not wire up) or
  // driving the manual-search -> confirm -> commit-batch UI far enough to register nonempty
  // unsaved work — a real proof needs the ACTUAL registry key populated, not just "the intro
  // screen renders for B," which would be true regardless of what A did and would prove nothing.
  // The account-boundary MECHANISM itself (AuthProvider's identity-change cache/registry clear,
  // D-093, SECURITY.md §9.1) is already unit-tested directly (tests/ui/auth-query-cache.test.ts);
  // this file adds the first real-browser proof for the purchase-form case above. A future
  // session wiring up a fake media stream can extend this describe block for the scanner case.
})
