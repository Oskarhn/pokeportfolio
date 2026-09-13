import { test, expect } from '@playwright/test'

/**
 * §14 (P89): navigation stress covering the real P83 bug's OWN shape — repeated scanner <-> exit
 * navigation, browser back/forward, and backgrounding — without needing the authenticated
 * ScannerPage UI itself (the standing no-sign-in boundary this repo's E2E suite has carried since
 * M7.1; see tests/e2e/smoke.spec.ts's own scanner test for the same constraint). What IS honestly
 * testable at this layer: that repeated navigation across the /scan <-> / boundary never
 * accumulates console errors, never surfaces a raw chunk-load/MIME-type failure (P83 §0's actual
 * real-device bug), and settles on the correct final screen every time — the router/chunk-loading
 * mechanics P83 needed to fix, exercised at stress volume instead of once.
 *
 * NOT covered here (needs a real authenticated session, so remains an owner-device manual check
 * per HANDOVER.md): actual camera-track/OCR-worker/visual-worker leak detection across repeated
 * captures — see F-05/F-06/F-07's own unit-level concurrency coverage
 * (tests/ui/scanner-camera.test.ts, tests/ui/scanner-state.test.ts) for the mechanism-level proof
 * that a session's resources are released deterministically; this spec proves the SURROUNDING
 * navigation shell survives repetition, not the camera lifecycle inside it.
 *
 * P119 §15 root-cause finding: this spec's own back-to-back `page.goto()` calls can cancel the
 * Service Worker registration `dist/registerSW.js` fires (fire-and-forget, on `window.load`)
 * mid-flight, producing a benign `TypeError: Script .../sw.js load failed` — reproduced directly
 * this session with instrumented evidence (tests/e2e/sw-load-flake-repro.spec.ts): the SAME
 * `/sw.js` URL, when a navigation doesn't interrupt it, serves a normal 200 with
 * `content-type: text/javascript`; the failing case shows the underlying request's own
 * `requestfailed` reason as literally "Load request cancelled". This is a navigation-SPEED
 * artifact only Playwright's scripted, immediate-succession navigation can trigger (no real user
 * navigates at this cadence) — not a preview-server race, not a genuine WebKit defect, not a
 * production defect. Filtered out of this spec's console-error assertions by name below, rather
 * than either silently tolerating IT or every future genuine error alongside it.
 */
const KNOWN_BENIGN_SW_REGISTRATION_RACE = /Script .*\/sw\.js load failed/

function isUnexpectedConsoleError(text: string): boolean {
  return !KNOWN_BENIGN_SW_REGISTRATION_RACE.test(text)
}

test.describe('scanner navigation stress (§14, P83 real bug shape)', () => {
  test('scan -> exit -> scan, repeated 8x rapidly: no console errors, no stale state, correct screen every time', async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    for (let cycle = 0; cycle < 8; cycle += 1) {
      // The CONTENT assertion below is the real correctness signal for a stress loop like this
      // one — back-to-back goto() calls with no settling time between them can occasionally hand
      // back a null/non-ok Response object on some engines even for a navigation that completes
      // and renders correctly (a Playwright/WebKit navigation-superseded timing artifact, not an
      // app-level MIME/404 failure — the actual P83 bug this spec guards against would fail the
      // heading assertion, not just the raw response status).
      await page.goto('/scan')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    }

    // No error accumulated across 8 full navigation cycles (16 route transitions) — a stale
    // module graph, a leaked listener throwing on a later navigation, or a MIME-type mismatch
    // would show up here regardless of which specific cycle triggered it.
    expect(consoleErrors.filter(isUnexpectedConsoleError)).toEqual([])
  })

  test('browser back/forward across the scan route settles on the correct screen every time', async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await page.goto('/scan')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await page.goBack()
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await page.goForward()
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    }

    expect(consoleErrors.filter(isUnexpectedConsoleError)).toEqual([])
  })

  test('backgrounding (tab hidden) then foregrounding mid-navigation-cycle causes no error', async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    await page.goto('/scan')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

    // Simulates backgrounding: dispatches the real visibilitychange event the app's own
    // visibility-driven camera-release logic (camera-session.ts's visibilityChangeAction) reacts
    // to, without needing a real OS-level tab switch.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    const response = await page.goto('/')
    expect(response?.ok()).toBe(true)
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(consoleErrors.filter(isUnexpectedConsoleError)).toEqual([])
  })
})
