import { test, expect, type Page } from '@playwright/test'
import { createFixtureHolding, createFixturePurchase } from './fixtures'
import { seedCatalog } from '../../db/setup'

/**
 * P111 §13-14 — real, signed-in browser regressions for two entity-switch bug classes the prior
 * sessions only proved with a deterministic unit matrix (`sale-form-entity-isolation.test.ts`,
 * `sale-form-state.test.ts`) or a static `key={purchaseId}` read. Both bugs are specifically about
 * the SAME React component instance surviving a client-side (SPA) route/search-param transition —
 * a full `page.goto()` between two URLs always tears down and rebuilds the whole document, which
 * would trivially "pass" either regression for the wrong reason. `navigateWithinApp` below performs
 * a real `history.pushState` + `popstate` dispatch instead — the same mechanism the app's own
 * router relies on for browser back/forward (the exact scenario SaleFormPage's own P98/P109
 * comments name as the real-world trigger) — so the SPA transitions client-side, the same component
 * instance survives, and the bug class actually gets exercised.
 */
async function navigateWithinApp(page: Page, path: string) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

// Every test in this file creates 2+ real fixture rows (add_card_acquisition/create_purchase)
// for the SAME synthetic e2e user (auth.setup.ts creates exactly one). Run serially: the default
// parallel workers hammering that one user's rows concurrently hit a real Postgres deadlock
// (observed directly in this session) that has nothing to do with the entity-switch behavior
// these tests exist to prove.
test.describe.configure({ mode: 'serial' })

test.describe('PurchaseEditPage — A -> B entity-switch regression (P109, key={purchaseId})', () => {
  test('editing purchase A then switching to purchase B in-app never leaks A into B', async ({
    page,
  }) => {
    const { purchaseId: purchaseA } = await createFixturePurchase({
      cardVariantId: seedCatalog.pikachuVariantId,
      unitPriceMinor: 5000,
    })
    const { purchaseId: purchaseB } = await createFixturePurchase({
      cardVariantId: seedCatalog.charizardVariantId,
      unitPriceMinor: 12000,
    })

    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByLabel('Unit price').first()).toHaveValue('50.00')

    // A real edit to A — proves a later assertion that B is unaffected is meaningful (not just
    // "B never had A's values because nothing wrote them").
    await page.getByLabel('Shipping').fill('99')

    await navigateWithinApp(page, `/purchases/${purchaseB}/edit`)

    // B's own real data must load — not a full reload, so this is the SAME component instance
    // recognizing a genuinely new purchaseId via `key={purchaseId}` and remounting itself.
    await expect(page.getByText(/charizard/i).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/pikachu/i)).toHaveCount(0)
    await expect(page.getByLabel('Unit price').first()).toHaveValue('120.00')
    // A's edited Shipping must not have survived onto B's fresh mount.
    await expect(page.getByLabel('Shipping')).not.toHaveValue('99')

    // Editing B, then submitting, must only ever affect B.
    await page.getByLabel('Shipping').fill('42')
    await page.getByRole('button', { name: /save changes/i }).click()
    await expect(page.getByText(/pikachu/i)).toHaveCount(0)

    // A, reloaded fresh from the server, must be completely untouched by anything done to B.
    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByLabel('Shipping')).not.toHaveValue('42')
  })
})

test.describe('SaleFormPage — A -> B -> A entity-switch regression (P109 full state isolation)', () => {
  test('every submission-bound field resets on a genuine holding switch, not just items', async ({
    page,
  }) => {
    const { holdingId: holdingA } = await createFixtureHolding({
      cardVariantId: seedCatalog.pikachuVariantId,
    })
    const { holdingId: holdingB } = await createFixtureHolding({
      cardVariantId: seedCatalog.charizardVariantId,
    })

    await page.goto(`/sales/new?holdingId=${holdingA}`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    // Edit every field P109's own design says must reset on a genuine entity switch — not just
    // `items`.
    await page.getByLabel('Marketplace').fill('eBay - holding A')
    await page.getByLabel('Fees').fill('25')
    await page.getByLabel('Your shipping cost').fill('15')
    await page.locator('#sale-notes').fill('notes about holding A')

    await navigateWithinApp(page, `/sales/new?holdingId=${holdingB}`)

    // B's own prefill must appear; A's item must not survive alongside it.
    await expect(page.getByText(/charizard/i).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/pikachu/i)).toHaveCount(0)

    // Every OTHER field must be back to its fresh default — the specific defect P106's
    // items-only reset left in place, and the whole reason P109's full-fields design exists.
    await expect(page.getByLabel('Marketplace')).toHaveValue('')
    await expect(page.getByLabel('Fees')).toHaveValue('')
    await expect(page.getByLabel('Your shipping cost')).toHaveValue('')
    await expect(page.locator('#sale-notes')).toHaveValue('')
    await expect(page.getByText(/save or cancel what you were doing/i)).toHaveCount(0)

    // B -> A again: a FRESH attempt, not a resurrected local draft of A's earlier edit.
    await navigateWithinApp(page, `/sales/new?holdingId=${holdingA}`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/charizard/i)).toHaveCount(0)
    await expect(page.getByLabel('Marketplace')).toHaveValue('')
    await expect(page.locator('#sale-notes')).toHaveValue('')
  })

  test('a slow A submit response never lands on B after an in-app switch', async ({ page }) => {
    const { holdingId: holdingA } = await createFixtureHolding({
      cardVariantId: seedCatalog.pikachuVariantId,
    })
    const { holdingId: holdingB } = await createFixtureHolding({
      cardVariantId: seedCatalog.charizardVariantId,
    })

    await page.goto(`/sales/new?holdingId=${holdingA}`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    // Give the lot a quantity/price so a submit is actually well-formed, then delay the RPC
    // response so the switch below genuinely races the in-flight request.
    await page.locator('input[type="number"]').first().fill('1')
    await page.getByLabel('Sale price per unit').fill('80')

    let releaseA: () => void = () => {}
    const aReleased = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    await page.route('**/rest/v1/rpc/create_sale', async (route) => {
      await aReleased
      await route.continue()
    })

    await page.getByRole('button', { name: /save sale/i }).click()

    await navigateWithinApp(page, `/sales/new?holdingId=${holdingB}`)
    await expect(page.getByText(/charizard/i).first()).toBeVisible({ timeout: 10_000 })

    releaseA()
    await page.unroute('**/rest/v1/rpc/create_sale')

    // Give A's now-released response a moment to resolve inside the app, then confirm it did
    // not navigate B away or contaminate B's fields.
    await page.waitForTimeout(500)
    await expect(page).toHaveURL(new RegExp(`holdingId=${holdingB}`))
    await expect(page.getByText(/pikachu/i)).toHaveCount(0)
    await expect(page.getByText(/charizard/i).first()).toBeVisible()
  })
})
