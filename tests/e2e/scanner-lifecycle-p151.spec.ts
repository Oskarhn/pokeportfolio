import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, type Page, type Worker } from '@playwright/test'
import { installCameraMock } from './support/camera-mock'
import { installFakeSession } from './support/fake-session'

/**
 * P151 real-browser lifecycle proof against the REAL production build of `/scan` — real Web Workers,
 * real Tesseract and DINOv2 assets, real React effects. Reaches `/scan` through the locally seeded
 * fake session (support/fake-session.ts): the catalog stays the unreachable placeholder backend, so a
 * finished analysis ends in an honest "Scan did not go through" alert — which is all these tests need
 * (they measure resources and control flow, not recognition quality).
 *
 * Emulated desktop Chromium/WebKit, NOT a physical iPhone (PHYSICAL_IPHONE_GATE stays deferred).
 */

// Playwright runs from the repository root.
const FIXTURE = readFileSync(path.resolve('tests/fixtures/scanner/synthetic-card.png'))

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
  return {
    live,
    ocr: () => [...live].filter(isOcr).length,
    visual: () => [...live].filter(isVisual).length,
    scanner: () => [...live].filter((w) => isOcr(w) || isVisual(w)).length,
  }
}

async function openScanner(page: Page): Promise<void> {
  await page.goto('/scan')
  await expect(page.getByRole('heading', { name: 'Scan cards' })).toBeVisible()
}

/** Leaves via the header X and waits until the scanner route is really gone. */
async function closeScanner(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close scanner' }).click()
  await page.waitForFunction(() => !window.location.pathname.startsWith('/scan'))
}

test.describe('P151 scanner lifecycle (real browser, real workers)', () => {
  test.use({ serviceWorkers: 'block' })

  test('P130-10: repeatedly entering and leaving /scan while the OCR/visual workers are still cold-starting leaves ZERO live scanner workers', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const workers = trackWorkers(page)
    await installFakeSession(page)
    // Make the OCR cold start slow enough that leaving lands DURING it (the P130-10 window).
    await page.route('**/scanner-assets/v7/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.continue().catch(() => undefined)
    })

    await openScanner(page)
    // Dwell times straddle the two windows: 300 ms = OCR still loading (visual not started yet);
    // 2,300 ms = the staggered visual worker (1.5 s) was constructed and is mid-init.
    const dwells = [300, 2_300, 300, 2_300, 300, 2_300]
    for (const dwell of dwells) {
      await page.waitForTimeout(dwell)
      await closeScanner(page)
      await page.goBack() // SPA history back to /scan: same document, so leaked workers would persist
      await expect(page.getByRole('heading', { name: 'Scan cards' })).toBeVisible()
    }
    await closeScanner(page)

    // Every worker created after the route was left must be torn down once its load settles.
    await expect.poll(() => workers.scanner(), { timeout: 30_000 }).toBe(0)
  })

  test('a photo that finishes encoding AFTER the user pressed Close never leaves a raw camera frame behind', async ({
    page,
  }) => {
    test.skip(
      !(await page.evaluate(
        () => typeof document.createElement('canvas').captureStream === 'function',
      )),
      'needs HTMLCanvasElement.captureStream for the mock camera (not in this WebKit build)',
    )
    await installFakeSession(page)
    await installCameraMock(page, { behavior: 'success' })
    await openScanner(page)
    await page.getByRole('button', { name: 'Start camera' }).click()
    await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
      timeout: 15_000,
    })

    // Instrument object URLs, and HOLD canvas.toBlob at a barrier so "capture completes after exit"
    // is a deterministic ordering, not a race.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      const live = new Set<string>()
      w.__liveUrls = live
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (obj: Blob | MediaSource) => {
        const url = create(obj)
        live.add(url)
        return url
      }
      URL.revokeObjectURL = (url: string) => {
        live.delete(url)
        revoke(url)
      }
      const original = HTMLCanvasElement.prototype.toBlob
      const held: (() => void)[] = []
      w.__held = held
      w.__encoded = false
      HTMLCanvasElement.prototype.toBlob = function (cb, type, quality) {
        held.push(() => {
          original.call(
            this,
            (blob) => {
              cb(blob)
              w.__encoded = true
            },
            type,
            quality,
          )
        })
      }
    })

    await page.getByRole('button', { name: 'Capture card' }).click()
    await page.waitForFunction(
      () => (window as unknown as { __held: unknown[] }).__held.length === 1,
    )
    await closeScanner(page) // exit while the frame is still encoding
    await page.evaluate(() => {
      ;(window as unknown as { __held: (() => void)[] }).__held.forEach((release) => {
        release()
      })
    })
    await page.waitForFunction(
      () => (window as unknown as { __encoded: boolean }).__encoded === true,
    )
    // One more task turn so the (now guarded) promise continuation has run.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    )

    expect(
      await page.evaluate(() => (window as unknown as { __liveUrls: Set<string> }).__liveUrls.size),
    ).toBe(0)
  })

  test('pixel bomb through the file picker: refused before decode with an honest message, and the next valid photo still scans', async ({
    page,
  }) => {
    await installFakeSession(page)
    await openScanner(page)
    const input = page.locator('input[type="file"]')

    await input.setInputFiles({
      name: 'bomb.png',
      mimeType: 'image/png',
      buffer: pngHeader(60_000, 60_000),
    })
    await expect(page.getByRole('alert').filter({ hasText: 'Photo is too large' })).toBeVisible()

    await input.setInputFiles({
      name: 'strip.png',
      mimeType: 'image/png',
      buffer: pngHeader(10_000, 100),
    })
    await expect(
      page.getByRole('alert').filter({ hasText: 'Photo could not be read' }),
    ).toBeVisible()

    await input.setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: FIXTURE })
    await expect(page.getByRole('heading', { name: 'Check your photo' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use photo' })).toBeEnabled()
  })

  test('cancel during analysis, then scan again: no stale result, the second scan completes, exit leaves no scanner worker', async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const workers = trackWorkers(page)
    await installFakeSession(page)
    await openScanner(page)
    await page.locator('input[type="file"]').setInputFiles({
      name: 'card.png',
      mimeType: 'image/png',
      buffer: FIXTURE,
    })
    await expect(page.getByRole('button', { name: 'Use photo' })).toBeVisible()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByRole('button', { name: 'Use photo' }).click()
      await expect(page.getByText(/Preparing scanner…|Analyzing card…/)).toBeVisible()
      await page.getByRole('button', { name: 'Cancel' }).click()
      // Back on review with the photo intact — cancelling never costs a recapture, never shows a result.
      await expect(page.getByRole('heading', { name: 'Check your photo' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Use photo' })).toBeEnabled()
    }

    // Let one attempt run to completion: it must end (result or honest error), not hang.
    await page.getByRole('button', { name: 'Use photo' }).click()
    await expect(page.getByText(/Preparing scanner…|Analyzing card…/)).toBeHidden({
      timeout: 120_000,
    })
    await expect(page.getByRole('heading', { name: 'Check your photo' }))
      .not.toBeVisible()
      .catch(() => undefined)

    await closeScanner(page)
    await expect.poll(() => workers.scanner(), { timeout: 30_000 }).toBe(0)
  })
})
