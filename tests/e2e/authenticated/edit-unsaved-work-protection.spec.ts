import { test, expect } from '@playwright/test'
import { createFixturePurchase, createFixtureSale } from './fixtures'

/**
 * P96 §16 — Purchase Edit / Sale Edit unsaved-work protection, real and signed-in. Disclosed as
 * NOT DONE by P94 (§20-22's own "NOT DONE / DISCLOSED GAPS" list: "Purchase Edit / Sale Edit
 * authenticated E2E coverage — needs a pre-existing purchase/sale fixture"). `createFixturePurchase`/
 * `createFixtureSale` (fixtures.ts) close that gap through the real `create_purchase`/`create_sale`
 * RPCs — never a direct table insert.
 *
 * Both edit pages mount their form ONLY once the `useQuery`-loaded detail is available, with every
 * field's `useState` lazily initialized FROM that already-loaded data (PurchaseEditPage.tsx's own
 * doc: "no effect syncing external data into local state is needed at all") — structurally
 * immune to N-14's specific bug class (a baseline captured against empty state before an async
 * effect populates it). This spec proves the resulting behavior end to end regardless: untouched
 * genuinely means untouched, and a real edit is genuinely caught.
 */

function triggerStaleDeployment(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
  })
}

const BLOCKING_PROMPT_TEXT = /save or cancel what you were doing/i

test.describe('Purchase Edit — unsaved-work protection', () => {
  test('an untouched edit form is not falsely dirty — the reload fires automatically', async ({
    page,
  }) => {
    const { purchaseId } = await createFixturePurchase()

    await page.goto(`/purchases/${purchaseId}/edit`)
    // Wait for the real loaded line (the fixture's own Pikachu card line) to prove the form has
    // actually finished loading real data, not an empty/loading shell.
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    const nextLoad = page.waitForEvent('load', { timeout: 10_000 })
    await triggerStaleDeployment(page)

    await nextLoad
    expect(page.url()).toContain(`/purchases/${purchaseId}/edit`)
    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toHaveCount(0)
  })

  test('changing Shipping after load blocks the automatic reload', async ({ page }) => {
    const { purchaseId } = await createFixturePurchase()

    await page.goto(`/purchases/${purchaseId}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    await page.getByLabel('Shipping').fill('79')

    const urlBefore = page.url()
    await triggerStaleDeployment(page)

    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toBeVisible()
    expect(page.url()).toBe(urlBefore)
    await expect(page.getByLabel('Shipping')).toHaveValue('79')
  })
})

test.describe('Sale Edit — unsaved-work protection', () => {
  test('an untouched edit form is not falsely dirty — the reload fires automatically', async ({
    page,
  }) => {
    const { saleId } = await createFixtureSale()

    await page.goto(`/sales/${saleId}/edit`)
    await expect(page.getByLabel(/marketplace/i)).toBeVisible({ timeout: 10_000 })

    const nextLoad = page.waitForEvent('load', { timeout: 10_000 })
    await triggerStaleDeployment(page)

    await nextLoad
    expect(page.url()).toContain(`/sales/${saleId}/edit`)
    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toHaveCount(0)
  })

  test('changing Marketplace after load blocks the automatic reload', async ({ page }) => {
    const { saleId } = await createFixtureSale()

    await page.goto(`/sales/${saleId}/edit`)
    await expect(page.getByLabel(/marketplace/i)).toBeVisible({ timeout: 10_000 })

    await page.getByLabel(/marketplace/i).fill('TCGplayer')

    const urlBefore = page.url()
    await triggerStaleDeployment(page)

    await expect(page.getByText(BLOCKING_PROMPT_TEXT)).toBeVisible()
    expect(page.url()).toBe(urlBefore)
    await expect(page.getByLabel(/marketplace/i)).toHaveValue('TCGplayer')
  })
})
