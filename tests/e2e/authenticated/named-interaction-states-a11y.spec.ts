import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const SYNTHETIC_CARD_IMAGE = fileURLToPath(
  new URL('../../fixtures/scanner/synthetic-card.png', import.meta.url),
)

/**
 * P112 §9/§C — closes P111's disclosed gap: the standing per-route axe sweeps
 * (`private-routes-smoke*.spec.ts`) scan each route's DEFAULT load state only. This file drives
 * specific named INTERACTION states — a validation error actually showing, a dialog actually
 * open, the debug panel in both themes, a chip actually selected — and axe-scans each one, since a
 * violation that only exists once a component enters an error/open/selected branch is invisible to
 * a scan of the resting state.
 */

async function expectNoViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
}

test.describe('Named interaction-state accessibility (P112)', () => {
  // NOTE on "scanner candidate dialog": the scanner never renders an ARIA `role="dialog"` anywhere
  // (confirmed by a direct search of ScannerPage.tsx) — candidate selection is a full-screen VIEW
  // (ManualSearchView -> ConfirmView), not a modal. The closest real equivalent named state is the
  // Confirm view's own "choose a version" branch, exercised below.
  test('Scanner: candidate confirmation state (version choice required, unresolved)', async ({
    page,
  }) => {
    await page.goto('/scan')
    await page.getByRole('button', { name: 'Choose photo' }).click()
    await page.locator('input[type="file"]').setInputFiles(SYNTHETIC_CARD_IMAGE)
    await page.getByRole('button', { name: 'Use photo' }).click()
    await page.getByRole('button', { name: /search manually/i }).click({ timeout: 60_000 })
    await page.getByLabel('Card name').fill('Pikachu')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByText('Tap a card to confirm it').waitFor({ timeout: 15_000 })
    await page
      .locator('#scanner-search-results-label')
      .locator('xpath=following-sibling::ul[1]//button')
      .first()
      .click()
    await expect(page.getByRole('heading', { name: 'Confirm card' })).toBeVisible()
    await expectNoViolations(page)
  })

  test('Purchase Add: validation-error state', async ({ page }) => {
    await page.goto('/purchases/new')
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 })
    await expectNoViolations(page)
  })

  test('Sale Add: validation-error state', async ({ page }) => {
    await page.goto('/sales/new')
    await page.getByRole('button', { name: /^(Save sale|Record sale)$/ }).click()
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 })
    await expectNoViolations(page)
  })

  test('Opening wizard: validation-error state', async ({ page }) => {
    await page.goto('/openings/new')
    // The default "Open something I own" mode disables Continue outright when the account has no
    // sealed products (a disabled-button state, not a validation error). "Bought and opened now"
    // always has fields to validate regardless of inventory.
    await page.getByRole('button', { name: 'Bought and opened now' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 })
    await expectNoViolations(page)
  })

  test('Export: backup-ready state', async ({ page }) => {
    await page.goto('/profile/export')
    await page.getByRole('button', { name: 'Create backup file' }).click()
    // A real client-side JSON export of the signed-in synthetic user's (empty) account — genuinely
    // fast, but the model/CI-hardware-adjusted budget matches every other real-worker spec here.
    await expect(page.getByRole('button', { name: /save|share/i })).toBeVisible({ timeout: 30_000 })
    await expectNoViolations(page)
  })

  test('Portfolio: selected filter/sort chip (accent) state', async ({ page }) => {
    await page.goto('/portfolio')
    // The toolbar's own summary button ("Value: high to low") opens a menu containing the real
    // toggle chips; "Value: high to low" is the default sort, so its own chip is already
    // aria-pressed once the menu is open — no extra selection click needed, and this sidesteps a
    // strict-mode name collision between the summary button and the chip it summarizes.
    await page.getByRole('button', { name: 'Value: high to low' }).first().click()
    const chip = page.getByLabel('Sort by').getByRole('button', { name: 'Value: high to low' })
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
    await expectNoViolations(page)
  })

  test('Profile: editing state (display name field focused with a pending change)', async ({
    page,
  }) => {
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Add a display name' }).click()
    const field = page.getByLabel('Display name')
    await field.fill('P112 A11y Check')
    await expect(field).toHaveValue('P112 A11y Check')
    await expectNoViolations(page)
  })

  test('Scanner debug panel: light mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/scan?scannerDebug=1')
    await expectNoViolations(page)
  })

  test('Scanner debug panel: dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/scan?scannerDebug=1')
    await expectNoViolations(page)
  })
})
