import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { installFakeSession } from './support/fake-session'
import {
  CARDS,
  cardmarket,
  installBackend,
  mutatingRequests,
  type Backend,
} from './support/price-check-backend'

/**
 * P153 Price Check → Scan, driven in a real browser with the REAL on-device scanner (OCR worker and
 * visual model, the real built index) over a synthetic card photo. Only the network boundary is
 * controlled. The point of these tests is the hand-off: a scan proposes a card identity, the person
 * confirms it, the price page asks for the variant, and nothing on the way writes anything.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/scanner/${name}`, import.meta.url))

let backend: Backend

test.beforeEach(async ({ page }) => {
  await installFakeSession(page)
  backend = await installBackend(page, { scannerEcho: true })
})

test.afterEach(() => {
  expect(mutatingRequests(backend.requests), 'a scan must never mutate backend state').toEqual([])
  expect(
    backend.requests.filter((r) => /add_card_acquisition|create_purchase|create_sale/.test(r.path)),
  ).toEqual([])
})

test('scan → confirm the card → choose the variant → prices, with nothing written', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const sv3 = CARDS[2]!
  backend.state.observations[sv3.variants[1]!.id] = [cardmarket('777', 1)]

  await page.goto('/price-check/scan')
  await expect(page.getByRole('heading', { name: 'Scan a card', level: 1 })).toBeVisible()
  await page.locator('input[type=file]').setInputFiles(fixture('synthetic-card-modern.png'))

  // The scanner's answer is either a confident proposal or one that needs review; both must end
  // in an explicit confirmation before any price is shown.
  const candidates = page.getByTestId('scan-candidate')
  await expect(candidates.first()).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('observation')).toHaveCount(0)

  const uncertain = await page.getByTestId('scan-uncertain').isVisible()
  if (uncertain) {
    // Not confident: nothing is pre-selected and the confirm button is disabled.
    for (const candidate of await candidates.all()) {
      await expect(candidate).toHaveAttribute('aria-checked', 'false')
    }
    await expect(page.getByRole('button', { name: 'Check price' })).toBeDisabled()
  } else {
    await expect(candidates.first()).toHaveAttribute('aria-checked', 'true')
  }

  // Choose the multi-variant Obsidian Flames candidate explicitly.
  await page.getByTestId('scan-candidate').filter({ hasText: 'Obsidian Flames' }).click()
  await page.getByRole('button', { name: 'Check price' }).click()

  await expect(page).toHaveURL(new RegExp(`/price-check/${sv3.id}$`))
  // The scan identified the printed card only — the VARIANT is still the person's choice.
  await expect(page.getByTestId('choose-variant')).toBeVisible()
  await expect(page.getByTestId('observation')).toHaveCount(0)
  await page.getByTestId('variant-option').nth(1).click()
  await expect(page.getByTestId('observation')).toContainText('€7.77')
})

test('scan: cancelling and re-scanning never leaves a stale result', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/price-check/scan')
  const input = page.locator('input[type=file]')
  await input.setInputFiles(fixture('synthetic-card-modern.png'))
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  await expect(page.getByText('Take or choose a photo')).toBeVisible()
  // Nothing from the abandoned scan may appear afterwards.
  await page.waitForTimeout(3000)
  await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
  await expect(page.getByTestId('scan-no-match')).toHaveCount(0)
})

test('scan: leaving the page mid-scan is safe and writes nothing', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/price-check/scan')
  await page.locator('input[type=file]').setInputFiles(fixture('synthetic-card-modern.png'))
  await page.getByRole('link', { name: '← Back to price check' }).click()
  await expect(page.getByRole('heading', { name: 'Price check', level: 1 })).toBeVisible()
  await page.waitForTimeout(3000)
  await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
})

test('scan: a file that is not an image is refused with a clear message', async ({ page }) => {
  await page.goto('/price-check/scan')
  await page.locator('input[type=file]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image'),
  })
  await expect(page.getByRole('alert')).toContainText(/image|photo/i)
})

test('scan: nothing recognised → manual fallback to name search', async ({ page }) => {
  test.setTimeout(120_000)
  // No catalog matches for whatever the scanner reads, and no echo fallback.
  backend.state.scannerEcho = false
  await page.goto('/price-check/scan')
  await page.locator('input[type=file]').setInputFiles(fixture('synthetic-card-lowcontrast.png'))
  await expect(page.getByTestId('scan-no-match')).toBeVisible({ timeout: 90_000 })
  await page.getByRole('link', { name: 'Search by name instead' }).last().click()
  await expect(page.getByRole('heading', { name: 'Price check', level: 1 })).toBeVisible()
})
