import { test, expect } from '@playwright/test'
import { createFixtureHolding } from './fixtures'

/**
 * P94 §21 — real, signed-in proof of the unsaved-work protection F-40 (P89)/N-14 (P94) built:
 * typed-but-unsaved input on a form must block the automatic stale-deployment reload; a genuinely
 * clean route must still reload automatically. The trigger is simulated exactly the way the
 * placeholder-backend suite's own `tests/e2e/stale-deployment.spec.ts` does —
 * `window.dispatchEvent(new Event('vite:preloadError'))` — no real stale build needed; what
 * differs here is that these forms actually WORK (real signed-in session, real data), so the
 * "unsaved" state being protected is real typed input, not a guess.
 */

function triggerStaleDeployment(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
  })
}

const BLOCKING_PROMPT_TEXT = /save or cancel what you were doing/i

test.describe('Purchase Add — unsaved input blocks the automatic reload', () => {
  test('typing a shipping charge makes the reload prompt instead of firing automatically', async ({
    page,
  }) => {
    await page.goto('/purchases/new')
    await page.getByLabel('Shipping').fill('49')

    const urlBefore = page.url()
    await triggerStaleDeployment(page)

    // The blocking prompt appears — proof the reload did NOT fire (a real reload would navigate
    // away and the typed value would be gone).
    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toBeVisible()
    expect(page.url()).toBe(urlBefore)
    await expect(page.getByLabel('Shipping')).toHaveValue('49')
  })
})

test.describe('Sale Add — holding prefill dirty-baseline fix (N-14, P94)', () => {
  test('zero user edits after an async holding prefill is NOT falsely dirty — the reload fires automatically', async ({
    page,
  }) => {
    const { holdingId } = await createFixtureHolding()

    await page.goto(`/sales/new?holdingId=${holdingId}`)
    // Let the async prefill effect actually resolve and populate the item before proceeding —
    // waiting for the prefilled row's own content is a real behavioral wait, not a fixed sleep.
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    const nextLoad = page.waitForEvent('load', { timeout: 10_000 })
    await triggerStaleDeployment(page)

    // N-14's whole point: prefill alone must never look like unsaved user work. Before the fix,
    // this reload would have been wrongly BLOCKED here.
    await nextLoad
    expect(page.url()).toContain('/sales/new')
  })

  test('an actual edit AFTER the prefill IS dirty — the reload is blocked', async ({ page }) => {
    const { holdingId } = await createFixtureHolding()

    await page.goto(`/sales/new?holdingId=${holdingId}`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    // A real user edit: Marketplace is a simple, unambiguous field every SaleFormPage instance has.
    await page.getByLabel(/marketplace/i).fill('Cardmarket')

    const urlBefore = page.url()
    await triggerStaleDeployment(page)

    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toBeVisible()
    expect(page.url()).toBe(urlBefore)
    await expect(page.getByLabel(/marketplace/i)).toHaveValue('Cardmarket')
  })
})

test.describe('A clean, untouched route still reloads automatically', () => {
  test('no unsaved work anywhere — the stale-deployment trigger reloads without prompting', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('body')).toBeVisible()

    const nextLoad = page.waitForEvent('load', { timeout: 10_000 })
    await triggerStaleDeployment(page)
    await nextLoad

    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toHaveCount(0)
  })
})
