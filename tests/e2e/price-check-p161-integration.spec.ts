import { fileURLToPath } from 'node:url'
import { test, expect, type Page, type Worker } from '@playwright/test'
import { installFakeSession } from './support/fake-session'
import {
  CARDS,
  installBackend,
  mutatingRequests,
  type Backend,
} from './support/price-check-backend'

/**
 * P161 — Price Check on top of the hardened scanner, in a real browser with the REAL production
 * build: real Web Workers (Tesseract and the visual model), real object URLs, real React effects,
 * real photo picker. Only the network boundary is a stand-in (support/price-check-backend.ts).
 *
 * What only a browser can prove, and what neither parent branch could: after Price Check has used
 * the scanner, NO scanner worker survives leaving the scan screen; a hostile or corrupt photo is
 * refused and the next photo still works; a superseded photo never delivers; going back to /scan
 * starts from nothing. Emulated engines (Chromium, WebKit), NOT a physical iPhone.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/scanner/${name}`, import.meta.url))

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b.set([8, 6, 0, 0, 0], 24)
  return b
}

/** Every dedicated worker the page currently has alive, by kind. */
function trackWorkers(page: Page) {
  const live = new Set<Worker>()
  page.on('worker', (worker) => {
    live.add(worker)
    worker.on('close', () => {
      live.delete(worker)
    })
  })
  const isOcr = (w: Worker) => /scanner-assets\/v7\/worker\.min\.js/.test(w.url())
  const isVisual = (w: Worker) => /visual-worker/.test(w.url())
  return { scanner: () => [...live].filter((w) => isOcr(w) || isVisual(w)).length }
}

// Same reason as price-check-scan.spec.ts: WebKit + an active service worker lets requests skip
// `page.route`, which is unrelated to what is measured here.
test.use({ serviceWorkers: 'block' })

let backend: Backend

test.beforeEach(async ({ page }) => {
  await installFakeSession(page)
  backend = await installBackend(page, { scannerEcho: true })
})

test.afterEach(() => {
  expect(mutatingRequests(backend.requests), 'Price Check must never mutate backend state').toEqual(
    [],
  )
  expect(
    backend.requests.filter((r) => /add_card_acquisition|create_purchase|create_sale/.test(r.path)),
  ).toEqual([])
})

/** Waits until the scan screen shows an outcome (candidates or an honest no-match). */
async function untilOutcome(page: Page): Promise<void> {
  await expect(
    page.getByTestId('scan-candidate').first().or(page.getByTestId('scan-no-match')),
  ).toBeVisible({
    timeout: 90_000,
  })
}

test.describe('P161 scanner + Price Check lifecycle (real workers)', () => {
  test('after a finished scan, confirming a card leaves ZERO live scanner workers on the result page, and /scan starts empty again', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    const workers = trackWorkers(page)
    await page.goto('/price-check/scan')
    await page.locator('input[type=file]').setInputFiles(fixture('synthetic-card-modern.png'))
    await untilOutcome(page)
    // The scanner really was running (otherwise "zero after" proves nothing).
    expect(workers.scanner()).toBeGreaterThan(0)

    const candidate = page.getByTestId('scan-candidate').first()
    if (await candidate.isVisible()) {
      await candidate.click()
      await page.getByRole('button', { name: 'Check price' }).click()
      await expect(page).toHaveURL(
        new RegExp(`/price-check/${CARDS[2]!.id}$|/price-check/[0-9a-f-]{36}`),
      )
      await expect.poll(() => workers.scanner(), { timeout: 30_000 }).toBe(0)
      await page.goBack()
    } else {
      await page.getByRole('link', { name: 'Search by name instead' }).last().click()
      await expect.poll(() => workers.scanner(), { timeout: 30_000 }).toBe(0)
      await page.goto('/price-check/scan')
    }
    // A brand-new screen: nothing of the previous scan is on it.
    await expect(page.getByText('Take or choose a photo')).toBeVisible()
    await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
    await expect(page.getByTestId('scan-no-match')).toHaveCount(0)
  })

  test('P130-10 through Price Check: entering and leaving /price-check/scan while the readers cold-start leaves zero workers', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const workers = trackWorkers(page)
    await page.route('**/scanner-assets/v7/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.continue().catch(() => undefined)
    })
    for (const dwell of [300, 2_300, 300, 2_300]) {
      await page.goto('/price-check/scan')
      await expect(page.getByRole('heading', { name: 'Scan a card', level: 1 })).toBeVisible()
      await page.waitForTimeout(dwell)
      await page.getByRole('link', { name: '← Back to price check' }).click()
      await expect(page.getByRole('heading', { name: 'Price check', level: 1 })).toBeVisible()
    }
    await expect.poll(() => workers.scanner(), { timeout: 30_000 }).toBe(0)
  })

  test('the text search never starts a camera, a reader or a model download', async ({ page }) => {
    const workers = trackWorkers(page)
    const scannerRequests: string[] = []
    page.on('request', (request) => {
      if (/scanner-assets|traineddata|visual-worker|tesseract/i.test(request.url())) {
        scannerRequests.push(request.url())
      }
    })
    await page.addInitScript(() => {
      const w = window as unknown as { __gum: number }
      w.__gum = 0
      const md = navigator.mediaDevices as MediaDevices | undefined
      if (md !== undefined) {
        md.getUserMedia = () => {
          w.__gum += 1
          return Promise.reject(new DOMException('no camera in test', 'NotAllowedError'))
        }
      }
    })
    await page.goto('/price-check')
    await page.getByLabel('Card name, set or number').fill('Charizard')
    await page.getByRole('link', { name: /Charizard.*Evolutions/ }).click()
    await expect(page).toHaveURL(/\/price-check\/[0-9a-f-]{36}/)
    await page.waitForTimeout(1_500)
    expect(workers.scanner()).toBe(0)
    expect(scannerRequests).toEqual([])
    expect(await page.evaluate(() => (window as unknown as Record<string, number>).__gum)).toBe(0)
  })
})

test.describe('P161 hostile and failing photos, then recovery', () => {
  test('a pixel bomb from the picker is refused before any decode; the next real photo scans', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    await page.goto('/price-check/scan')
    const input = page.locator('input[type=file]')
    await input.setInputFiles({
      name: 'bomb.png',
      mimeType: 'image/png',
      buffer: pngHeader(60000, 60000),
    })
    await expect(page.getByRole('alert')).toContainText(/too large|large/i)
    await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
    await input.setInputFiles(fixture('synthetic-card-modern.png'))
    await untilOutcome(page)
  })

  test('a corrupt image is refused with a message, then a valid photo scans', async ({ page }) => {
    test.setTimeout(150_000)
    await page.goto('/price-check/scan')
    const input = page.locator('input[type=file]')
    await input.setInputFiles({
      name: 'corrupt.png',
      mimeType: 'image/png',
      buffer: Buffer.from('this is not a png at all, just text pretending'),
    })
    await expect(page.getByRole('alert')).toBeVisible()
    await input.setInputFiles(fixture('synthetic-card-modern.png'))
    await untilOutcome(page)
  })

  test('Cancel during a slow read: nothing surfaces afterwards, and the next scan succeeds', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    await page.route('**/scanner-assets/v7/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await route.continue().catch(() => undefined)
    })
    await page.goto('/price-check/scan')
    const input = page.locator('input[type=file]')
    await input.setInputFiles(fixture('synthetic-card-modern.png'))
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Take or choose a photo')).toBeVisible()
    await page.waitForTimeout(6_000)
    await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
    await expect(page.getByTestId('scan-no-match')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
    await input.setInputFiles(fixture('synthetic-card-modern.png'))
    await untilOutcome(page)
  })

  test('latest pick wins: a valid photo followed at once by a refused one never delivers the valid photo', async ({
    page,
  }) => {
    test.setTimeout(150_000)
    await page.goto('/price-check/scan')
    const input = page.locator('input[type=file]')
    await input.setInputFiles(fixture('synthetic-card-modern.png'))
    await input.setInputFiles({
      name: 'bomb.png',
      mimeType: 'image/png',
      buffer: pngHeader(60000, 60000),
    })
    await expect(page.getByRole('alert')).toContainText(/too large|large/i)
    // Long enough for the superseded scan to have finished had it not been abandoned.
    await page.waitForTimeout(8_000)
    await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
    await expect(page.getByTestId('scan-no-match')).toHaveCount(0)
    await expect(page.getByRole('alert')).toContainText(/too large|large/i)
  })
})

test.describe('P161 narrow viewports and text-search timing', () => {
  for (const width of [320, 360, 390, 430]) {
    test(`the scan screen fits a ${String(width)} px wide phone at every step, with touch-sized controls`, async ({
      page,
    }) => {
      test.setTimeout(150_000)
      await page.setViewportSize({ width, height: 700 })
      const noOverflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      await page.goto('/price-check/scan')
      await expect(page.getByText('Take or choose a photo')).toBeVisible()
      expect(await noOverflow()).toBe(true)
      const picker = page.locator('label', { hasText: 'Take or choose a photo' })
      expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44)

      await page.locator('input[type=file]').setInputFiles(fixture('synthetic-card-modern.png'))
      await expect(page.getByAltText('Card being scanned')).toBeVisible()
      expect(await noOverflow()).toBe(true)
      await untilOutcome(page)
      expect(await noOverflow()).toBe(true)
      for (const control of await page.getByRole('button').all()) {
        if (!(await control.isVisible())) continue
        expect((await control.boundingBox())!.height, 'touch target').toBeGreaterThanOrEqual(44)
      }
    })
  }

  test('text search: cold first search vs warm repeat (recorded; only a generous ceiling is asserted)', async ({
    page,
  }, testInfo) => {
    const scannerRequests: string[] = []
    page.on('request', (r) => {
      if (/scanner-assets|traineddata|visual-worker/i.test(r.url())) scannerRequests.push(r.url())
    })
    const search = async (text: string): Promise<number> => {
      const started = Date.now()
      await page.getByLabel('Card name, set or number').fill(text)
      await expect(page.getByTestId('price-check-result').first()).toBeVisible({ timeout: 15_000 })
      return Date.now() - started
    }
    await page.goto('/price-check')
    const cold = await search('Charizard')
    // Warm = the same query again after a different one: served from the query cache, no request.
    await search('Pikachu')
    const requestsBefore = backend.searchQueries.length
    const warm = await search('Charizard')
    const warmRequests = backend.searchQueries.length - requestsBefore
    testInfo.annotations.push({
      type: 'text-search-timing',
      description: `cold ${String(cold)} ms, warm ${String(warm)} ms, extra search requests on the warm repeat: ${String(warmRequests)}`,
    })
    expect(cold).toBeLessThan(10_000)
    expect(warm).toBeLessThan(10_000)
    expect(scannerRequests).toEqual([])
  })
})
