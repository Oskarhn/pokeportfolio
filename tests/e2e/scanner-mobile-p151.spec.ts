import { readFileSync } from 'node:fs'
import path from 'node:path'
import { devices, test, expect, type Browser, type Page } from '@playwright/test'
import { getCameraMockDiagnostics, installCameraMock } from './support/camera-mock'
import { installFakeSession } from './support/fake-session'

/**
 * P151 mobile-EMULATION matrix for `/scan`: iPhone-14 viewport, touch, mobile user agent and CPU
 * throttling, driven in Chromium against the real production build. This is emulation. It is NOT
 * physical-iPhone validation — PHYSICAL_IPHONE_GATE remains DEFERRED_BY_OWNER: Safari's real
 * getUserMedia/WebKit-worker/memory behaviour cannot be observed here.
 *
 * The catalog RPC is stubbed to "no rows" so a scan runs the whole on-device pipeline and ends on
 * the honest no-match screen; nothing here depends on recognition quality.
 */

const CARD = readFileSync(path.resolve('tests/fixtures/scanner/synthetic-card.png'))
const { defaultBrowserType, ...IPHONE_14 } = devices['iPhone 14']
void defaultBrowserType // the device descriptor's own browser is irrelevant: this spec drives Chromium

interface Mobile {
  page: Page
  errors: string[]
}

async function mobilePage(
  browser: Browser,
  options: { camera?: 'success' | 'NotAllowedError'; cpu?: number } = {},
): Promise<Mobile> {
  const context = await browser.newContext({ ...IPHONE_14, serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const cdp = await context.newCDPSession(page)
  if (options.cpu !== undefined && options.cpu > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpu })
  }
  await installFakeSession(page)
  if (options.camera !== undefined) await installCameraMock(page, { behavior: options.camera })
  await page.route('**/rest/v1/rpc/search_cards*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route('**/rest/v1/cards*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.goto('/scan')
  await expect(page.getByRole('heading', { name: 'Scan cards' })).toBeVisible()
  return { page, errors }
}

const analyzing = (page: Page) => page.getByText(/Preparing scanner…|Analyzing card…/)

async function pickCard(page: Page): Promise<void> {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: CARD })
  await expect(page.getByRole('button', { name: 'Use photo' })).toBeVisible()
}

async function setVisibility(page: Page, state: 'visible' | 'hidden'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { value: s, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

async function hasLiveCamera(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof document.createElement('canvas').captureStream === 'function')
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
}

test.describe('P151 scanner — mobile emulation (NOT a physical iPhone)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP + Chromium emulation only')
  })

  test('narrow portrait: no horizontal overflow and touch targets are at least 44 px', async ({
    browser,
  }) => {
    const { page, errors } = await mobilePage(browser)
    expect(await noHorizontalOverflow(page)).toBe(true)
    for (const name of ['Start camera', 'Choose photo']) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    // A touch tap (not a mouse click) opens the picker path and reaches review.
    await pickCard(page)
    await page.getByRole('button', { name: 'Use photo' }).tap()
    await expect(analyzing(page)).toBeVisible()
    await expect(analyzing(page)).toBeHidden({ timeout: 90_000 })
    await expect(page.getByRole('heading', { name: /Couldn't identify this card/ })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('landscape and live rotation: the shutter and the review actions stay reachable', async ({
    browser,
  }) => {
    const { page, errors } = await mobilePage(browser, { camera: 'success' })
    test.skip(!(await hasLiveCamera(page)), 'no HTMLCanvasElement.captureStream in this engine')
    await page.getByRole('button', { name: 'Start camera' }).tap()
    const shutter = page.getByRole('button', { name: 'Capture card' })
    await expect(shutter).toBeVisible({ timeout: 15_000 })

    await page.setViewportSize({ width: 844, height: 390 }) // rotate to landscape mid-camera
    await expect(shutter).toBeVisible()
    await expect(shutter).toBeEnabled()
    const box = await shutter.boundingBox()
    expect(box).not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(390)

    await shutter.tap()
    await expect(page.getByRole('heading', { name: 'Check your photo' })).toBeVisible()
    const use = page.getByRole('button', { name: 'Use photo' })
    await use.scrollIntoViewIfNeeded()
    await expect(use).toBeInViewport()

    await page.setViewportSize({ width: 390, height: 844 }) // and back to portrait
    await expect(use).toBeVisible()
    expect(errors).toEqual([])
  })

  test('denied camera: honest message, and the photo path still completes a scan and can be repeated', async ({
    browser,
  }) => {
    const { page, errors } = await mobilePage(browser, { camera: 'NotAllowedError' })
    await page.getByRole('button', { name: 'Start camera' }).tap()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Camera access was blocked' }),
    ).toBeVisible()

    await pickCard(page)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByRole('button', { name: 'Use photo' }).tap()
      await expect(analyzing(page)).toBeHidden({ timeout: 90_000 })
      await expect(page.getByRole('heading', { name: /Couldn't identify this card/ })).toBeVisible()
      await page.locator('input[type="file"]').setInputFiles({
        name: 'card.png',
        mimeType: 'image/png',
        buffer: CARD,
      })
      await expect(page.getByRole('button', { name: 'Use photo' })).toBeVisible()
    }
    expect(errors).toEqual([])
  })

  test('slow CPU + slow OCR assets: loading and cancel controls work, no stale result appears, the next scan succeeds', async ({
    browser,
  }) => {
    test.setTimeout(180_000)
    const { page, errors } = await mobilePage(browser, { cpu: 6 })
    // Hold the OCR runtime behind a slow network for the first attempt only.
    let slow = true
    await page.route('**/scanner-assets/v7/**', async (route) => {
      if (slow) await new Promise((resolve) => setTimeout(resolve, 6_000))
      await route.continue().catch(() => undefined)
    })
    await pickCard(page)
    await page.getByRole('button', { name: 'Use photo' }).tap()
    await expect(page.getByText(/Preparing scanner…|Analyzing card…/)).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).tap() // cancel while still loading
    await expect(page.getByRole('heading', { name: 'Check your photo' })).toBeVisible()

    // The abandoned scan finishes in the background; it must NEVER surface a result over review.
    await page.waitForTimeout(8_000)
    await expect(page.getByRole('heading', { name: 'Check your photo' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /Couldn't identify this card/ })).toBeHidden()

    slow = false
    await page.getByRole('button', { name: 'Use photo' }).tap()
    await expect(analyzing(page)).toBeHidden({ timeout: 120_000 })
    await expect(page.getByRole('heading', { name: /Couldn't identify this card/ })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('background then foreground while the camera is live: released at once, restartable, no duplicate stream', async ({
    browser,
  }) => {
    const { page, errors } = await mobilePage(browser, { camera: 'success' })
    test.skip(!(await hasLiveCamera(page)), 'no HTMLCanvasElement.captureStream in this engine')
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByRole('button', { name: 'Start camera' }).tap()
      await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
        timeout: 15_000,
      })
      await setVisibility(page, 'hidden')
      await expect(page.getByRole('button', { name: 'Start camera' })).toBeVisible()
      expect((await getCameraMockDiagnostics(page)).activeStreamCount).toBe(0)
      await setVisibility(page, 'visible')
    }
    expect(errors).toEqual([])
  })

  test('leaving the scanner while a scan is running: no page error and no scanner worker survives', async ({
    browser,
  }) => {
    const { page, errors } = await mobilePage(browser)
    const alive = new Set<string>()
    page.on('worker', (worker) => {
      alive.add(worker.url())
      worker.on('close', () => alive.delete(worker.url()))
    })
    await pickCard(page)
    await page.getByRole('button', { name: 'Use photo' }).tap()
    await expect(analyzing(page)).toBeVisible()
    await page.getByRole('button', { name: 'Close scanner' }).tap()
    await page.waitForFunction(() => !window.location.pathname.startsWith('/scan'))
    await expect
      .poll(() => [...alive].filter((u) => /worker|visual/.test(u)).length, {
        timeout: 30_000,
      })
      .toBe(0)
    expect(errors).toEqual([])
  })
})
