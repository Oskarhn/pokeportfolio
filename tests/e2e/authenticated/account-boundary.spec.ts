import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { createServiceClient, createSyntheticUser, deleteSyntheticUser } from '../../db/setup'

const SYNTHETIC_CARD_IMAGE = fileURLToPath(
  new URL('../../fixtures/scanner/synthetic-card.png', import.meta.url),
)

/**
 * P94 §22 — real, signed-in account-switch privacy proof: A's unsaved in-memory work must never
 * be visible to B after a same-tab sign-out/sign-in, mirroring D-093's cross-account query-cache
 * boundary (SECURITY.md §9.1) but exercised through a real browser session rather than only unit
 * tests of the cache-clearing logic itself.
 *
 * P112: this file's two tests are the ONLY specs in the authenticated project that click the real
 * "Sign out" button. `supabase.auth.signOut()` defaults to GLOBAL scope (correct, intended product
 * behavior — revoking every session for the account, not just this browser tab), which means
 * signing out the shared `e2e-auth` user every other authenticated spec inherits via
 * `auth.setup.ts`'s `storageState` would permanently kill that session for the rest of the run —
 * a real cross-test hazard found by running the full authenticated suite, not a product bug.
 * Fixed by giving THIS file's own "A" role a dedicated, disposable user signed in fresh through the
 * real login form (`test.use({ storageState: { cookies: [], origins: [] } })` opts out of the
 * inherited session
 * entirely), exactly mirroring how "B" was already created. No other spec's session is ever
 * touched.
 */

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Account-switch privacy: unsaved purchase input does not leak across a sign-out', () => {
  let userA: { id: string; email: string; password: string } | null = null
  let userB: { id: string; email: string; password: string } | null = null

  test.beforeEach(async ({ page }) => {
    const service = createServiceClient()
    userA = await createSyntheticUser(service, 'e2e-boundary-a')
    await page.goto('/login')
    await page.getByLabel('Email').fill(userA.email)
    await page.getByLabel('Password').fill(userA.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  })

  test.afterEach(async () => {
    const service = createServiceClient()
    if (userA !== null) {
      await deleteSyntheticUser(service, userA.id)
      userA = null
    }
    if (userB !== null) {
      await deleteSyntheticUser(service, userB.id)
      userB = null
    }
  })

  test("A types unsaved purchase input, signs out, B signs in — B sees an empty form, not A's text", async ({
    page,
  }) => {
    // A (signed in fresh in beforeEach, above) types real unsaved input.
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

  /**
   * P96 §15 — closes P94's own disclosed gap: a real, genuinely nonempty scanner batch, driven
   * through "Choose photo" (a plain `<input type=file>` — no camera/fake-media-stream needed at
   * all, since the file-picker path is a first-class entry alongside the live camera one) ->
   * manual search (works regardless of whether OCR/visual recognition itself succeeds on the
   * synthetic fixture card) -> confirm -> "Add to batch". The batch is deliberately never
   * committed. Two things are proven, not assumed: (1) A genuinely had nonempty scanner state —
   * the "1 card scanned" summary is asserted before anything else happens, exactly what P94's own
   * note said a real proof requires; (2) that nonempty state registers as real unsaved work (the
   * same stale-deployment-blocks-reload contract every other unsaved-work surface in this app
   * proves) AND is completely gone for a second user after a real sign-out/sign-in — not merely
   * "the intro screen renders," which would be true regardless of what A did.
   *
   * P99: was `test.fixme()` — see D-108 (docs/DECISIONS.md). Building this spec originally
   * surfaced a real, confirmed bug: under React StrictMode (this project's dev server only —
   * `pnpm exec vite`, which is what the `desktop-chromium-authenticated` project drives; production
   * builds strip StrictMode's double-invoke entirely, so the real deployed PWA was never affected),
   * ScannerPage's render function ran twice for the initial mount as part of React's render-purity
   * check, and `useMemo(() => getScannerUiController(userId), [userId])`'s factory was a real side
   * effect that ran both times, producing two independently-alive controller instances — the FIRST
   * one ended up wired into the actually-committed render's event handlers, and the route-exit
   * cleanup effect disposed it, so every `analyzeCapture()` afterward threw
   * `ScannerEngineDisposedError`. Fixed in D-108 by moving construction out of `useMemo` into the
   * mount effect itself (stored in a ref, not a state value — see D-108's own note on why): effect
   * bodies genuinely run once per REAL mount even under StrictMode, so exactly one live instance now
   * survives. This test is the real, execution-level proof of that fix — un-skipped below.
   *
   * P112: the searched card can resolve to a catalog entry with more than one trackable version
   * (e.g. "Pikachu" Base Set #58, seeded with Normal/Reverse holo/an "Other" test finish) — the
   * Confirm view correctly refuses to guess and shows an explicit, nothing-pre-selected "Version"
   * picker until one is chosen. Selecting the first option when that picker appears is real,
   * intended product validation this test must satisfy, not a bug to route around.
   */
  test('A scans a card into a nonempty batch (never committed); it blocks the stale-deployment reload and is gone for B after sign-out/sign-in', async ({
    page,
  }) => {
    // A cold model/OCR-WASM load (60s budget below) plus the full sign-out/sign-in round trip
    // easily exceeds Playwright's 30s default — matching visual-worker-real-browser.spec.ts's own
    // generous budget for the same real cold-start cost.
    test.setTimeout(120_000)
    await page.goto('/scan')
    await page.getByRole('button', { name: 'Choose photo' }).click()
    await page.locator('input[type="file"]').setInputFiles(SYNTHETIC_CARD_IMAGE)

    await page.getByRole('button', { name: 'Use photo' }).click()
    // Analysis (OCR + visual) runs for real — cold model/WASM load can be slow the first time,
    // matching the generous timeout every other real-worker spec in this suite already uses.
    await page.getByRole('button', { name: /search manually/i }).click({ timeout: 60_000 })

    await page.getByLabel('Card name').fill('Pikachu')
    await page.getByRole('button', { name: 'Search' }).click()
    // Tap the first real search result — whichever card the catalog actually returns; this test
    // proves batch-state isolation, not matcher/search-ranking correctness (that's engine.test.ts's
    // job).
    await page.getByText('Tap a card to confirm it').waitFor({ timeout: 15_000 })
    await page
      .locator('#scanner-search-results-label')
      .locator('xpath=following-sibling::ul[1]//button')
      .first()
      .click()

    // Confirm view: variants load asynchronously (a "Checking available versions…" skeleton shows
    // first), and when the catalog card has more than one trackable version, the UI correctly
    // refuses to guess — it shows an explicit "Version" picker with NOTHING pre-selected, and
    // "Add to batch" surfaces "Choose which version of this card you have" until one is picked
    // (real, intended product validation, not a bug this test should route around). A
    // single-variant card instead shows plain text ("Version: <label>") and needs no click here.
    await expect(page.getByText('Checking available versions…')).toHaveCount(0, { timeout: 15_000 })
    const versionGroup = page.getByRole('group', { name: 'Version' })
    if (await versionGroup.isVisible().catch(() => false)) {
      await versionGroup.getByRole('button').first().click()
    }

    await page.getByRole('button', { name: 'Add to batch' }).click()

    // (1) A genuinely has nonempty scanner state — asserted BEFORE anything else, per this
    // block's own doc above.
    await expect(page.getByText('1 card scanned')).toBeVisible({ timeout: 10_000 })

    // (2a) That nonempty batch registers as real unsaved work: the same stale-deployment ->
    // no-automatic-reload contract every other unsaved-work surface in this app proves.
    // StaleDeploymentBanner is a non-blocking banner (never intercepts routing, only the
    // AUTOMATIC reload) — asserting it appeared and the URL didn't move is the whole proof; no
    // dismissal step is needed before the real sign-out navigation below.
    const urlBefore = page.url()
    await page.evaluate(() => {
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    })
    await expect(page.getByText(/save or cancel what you were doing/i)).toBeVisible()
    expect(page.url()).toBe(urlBefore)

    // A signs out through the real UI — this unmounts the scanner (pure in-memory React state,
    // never localStorage/sessionStorage/IndexedDB per this feature's own standing privacy audit,
    // tests/ui/scanner-network-audit.test.ts) and, independently, D-093's identity-change cache
    // boundary clears whatever else might carry cross-user state.
    await page.goto('/profile')
    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 15_000 })

    const service = createServiceClient()
    const created = await createSyntheticUser(service, 'e2e-boundary-scanner-b')
    userB = created

    await page.getByLabel('Email').fill(created.email)
    await page.getByLabel('Password').fill(created.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })

    // (2b) B's scanner is genuinely fresh: the intro screen, not a resumed batch/summary — and
    // NOT the blocking unsaved-work sheet either (a leaked registry entry would show it here).
    await page.goto('/scan')
    await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText(/card scanned/i)).toHaveCount(0)
    await expect(page.getByText(/save or cancel what you were doing/i)).toHaveCount(0)
  })
})
