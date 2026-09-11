import { test, expect, type Page } from '@playwright/test'
import {
  installCameraMock,
  getCameraMockDiagnostics,
  setCameraMockBehavior,
  endActiveMockCameraTracks,
} from './support/camera-mock'
import { installFakeSession } from './support/fake-session'

/**
 * P119 §9: real-browser camera permission matrix, against the REAL `/scan` route and the REAL
 * `openEnvironmentCamera`/`ScannerPage` code — not a unit-level mock of camera-session.ts. Reaches
 * `/scan` via a locally-seeded fake Supabase session (support/fake-session.ts) rather than the
 * authenticated (real-Supabase/Docker) project, which this session is not permitted to touch — see
 * that file's own doc for exactly what this does and does not prove.
 *
 * WEBKIT LIMITATION (verified this session, not assumed): a successful mock acquisition uses
 * `HTMLCanvasElement.captureStream()` to produce a genuine MediaStream (see camera-mock.ts's own
 * doc for why a duck-typed fake cannot work — confirmed empirically that `video.srcObject = <a
 * non-MediaStream object>` throws a WebIDL TypeError in this exact WebKit build, so a fake stream
 * MUST be a real MediaStream instance). Playwright's Windows-hosted WebKit 26.5 does not implement
 * `HTMLCanvasElement.captureStream` at all (`typeof canvas.captureStream === 'function'` is
 * false, confirmed directly against a fresh page this session) — matching this project's own
 * prior, disclosed pattern of Windows-hosted-WebKit-vs-real-Safari API gaps (D-105/D-107's
 * OffscreenCanvas finding). Every case that needs a LIVE mock stream is therefore skipped on
 * WebKit with an explicit, capability-detected reason — never silently, never by project name.
 * Every case that needs only a REJECTED getUserMedia (no stream construction at all) runs
 * identically on both engines and is NOT skipped.
 */

async function gotoScanner(page: Page): Promise<void> {
  await page.goto('/scan')
  await expect(page.getByRole('heading', { name: 'Scan cards' })).toBeVisible()
}

async function supportsCanvasCaptureStream(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof document.createElement('canvas').captureStream === 'function')
}

test.describe('scanner camera permission matrix (P119 §9)', () => {
  test('permission accepted: camera starts, shutter becomes usable, one stream created', async ({
    page,
  }) => {
    test.skip(
      !(await supportsCanvasCaptureStream(page)),
      'This engine has no HTMLCanvasElement.captureStream — see file header. A live mock stream is impossible here.',
    )
    await installFakeSession(page)
    await installCameraMock(page, { behavior: 'success' })
    await gotoScanner(page)

    await page.getByRole('button', { name: 'Start camera' }).click()
    await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
      timeout: 10_000,
    })

    const diagnostics = await getCameraMockDiagnostics(page)
    expect(diagnostics.createdStreamCount).toBe(1)
    expect(diagnostics.activeStreamCount).toBe(1)
    expect(diagnostics.getUserMediaCallCount).toBe(1)
    // camera-session.ts requests a rear-camera preference at an ideal 1920x1920 hint (§7) —
    // asserting the ACTUAL constraints openEnvironmentCamera sent, not a guess.
    const video = diagnostics.lastConstraints?.video
    expect(video && typeof video === 'object' ? video : null).toMatchObject({
      facingMode: { ideal: 'environment' },
    })
  })

  const deniedCases: {
    behavior:
      | 'NotAllowedError'
      | 'NotFoundError'
      | 'NotReadableError'
      | 'AbortError'
      | 'OverconstrainedError'
    expectedTitle: string
  }[] = [
    { behavior: 'NotAllowedError', expectedTitle: 'Camera access was blocked' },
    { behavior: 'NotFoundError', expectedTitle: 'No camera found' },
    { behavior: 'NotReadableError', expectedTitle: 'Camera is in use' },
    { behavior: 'AbortError', expectedTitle: 'Camera could not start' },
    { behavior: 'OverconstrainedError', expectedTitle: 'Camera could not start' },
  ]

  for (const { behavior, expectedTitle } of deniedCases) {
    // Denial requires no stream construction at all (mockGetUserMedia rejects before ever calling
    // createFakeStream) — runs on every engine, WebKit included.
    test(`${behavior} maps to an honest error, button stays usable, no orphan stream`, async ({
      page,
    }) => {
      await installFakeSession(page)
      await installCameraMock(page, { behavior })
      await gotoScanner(page)

      const startButton = page.getByRole('button', { name: 'Start camera' })
      await startButton.click()

      await expect(page.getByRole('alert').filter({ hasText: expectedTitle })).toBeVisible({
        timeout: 10_000,
      })
      // The failed attempt must not leave the UI stuck: back on the intro screen, the button is
      // usable again (no permanent disabled lock from one failed acquisition).
      await expect(startButton).toBeEnabled()

      const diagnostics = await getCameraMockDiagnostics(page)
      expect(diagnostics.activeStreamCount).toBe(0)
      expect(diagnostics.createdStreamCount).toBe(0)
      expect(diagnostics.getUserMediaCallCount).toBe(1)
    })

    test(`${behavior} then retry succeeds: the earlier failure never poisons a later attempt`, async ({
      page,
    }) => {
      test.skip(
        !(await supportsCanvasCaptureStream(page)),
        'Retry path needs a live mock stream — see file header.',
      )
      await installFakeSession(page)
      await installCameraMock(page, { behavior })
      await gotoScanner(page)

      const startButton = page.getByRole('button', { name: 'Start camera' })
      await startButton.click()
      await expect(page.getByRole('alert').filter({ hasText: expectedTitle })).toBeVisible({
        timeout: 10_000,
      })

      await setCameraMockBehavior(page, 'success')
      await startButton.click()
      await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
        timeout: 10_000,
      })
      const afterRetryDiagnostics = await getCameraMockDiagnostics(page)
      expect(afterRetryDiagnostics.activeStreamCount).toBe(1)
      expect(afterRetryDiagnostics.createdStreamCount).toBe(1)
    })
  }

  test('track ends unexpectedly while camera is live: app returns to intro, no orphan stream, camera reopens cleanly', async ({
    page,
  }) => {
    test.skip(
      !(await supportsCanvasCaptureStream(page)),
      'This engine has no HTMLCanvasElement.captureStream — see file header.',
    )
    await installFakeSession(page)
    await installCameraMock(page, { behavior: 'success' })
    await gotoScanner(page)

    await page.getByRole('button', { name: 'Start camera' }).click()
    await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
      timeout: 10_000,
    })

    // Simulates a hardware disconnect / camera seized by another app mid-session (prompt §9's
    // "camera disappears while preview active") — NOT a user-initiated stop.
    const endedCount = await endActiveMockCameraTracks(page)
    expect(endedCount).toBe(1)

    // camera-session.ts's `onEnded` callback dispatches CAMERA_EXITED -> the reducer returns to
    // 'intro' (state.ts). The user is not stranded on a dead preview.
    await expect(page.getByRole('heading', { name: 'Scan cards' })).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('button', { name: 'Start camera' })).toBeEnabled()

    const diagnostics = await getCameraMockDiagnostics(page)
    expect(diagnostics.activeStreamCount).toBe(0)
    expect(diagnostics.activeTrackCount).toBe(0)
    expect(diagnostics.stoppedTrackCount).toBe(1)

    // Re-entry after the unexpected end succeeds and creates exactly one NEW stream — the old,
    // now-ended track/stream is never resurrected or double-counted.
    await page.getByRole('button', { name: 'Start camera' }).click()
    await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
      timeout: 10_000,
    })
    const afterReentry = await getCameraMockDiagnostics(page)
    expect(afterReentry.createdStreamCount).toBe(2)
    expect(afterReentry.activeStreamCount).toBe(1)
  })

  test('success followed by a later failure on re-entry: the earlier success never masks the new failure', async ({
    page,
  }) => {
    test.skip(
      !(await supportsCanvasCaptureStream(page)),
      'Needs a live mock stream for the first acquisition — see file header.',
    )
    await installFakeSession(page)
    await installCameraMock(page, { behavior: 'success' })
    await gotoScanner(page)

    await page.getByRole('button', { name: 'Start camera' }).click()
    await expect(page.getByRole('button', { name: 'Capture card' })).toBeVisible({
      timeout: 10_000,
    })

    // Leave the camera step (X closes the whole scanner back to intro in a fresh page — simplest
    // honest way to force a brand-new openEnvironmentCamera call without depending on an
    // in-session "retake"/back affordance this matrix doesn't otherwise need).
    await page.getByRole('button', { name: 'Close scanner' }).click()
    await gotoScanner(page)

    await setCameraMockBehavior(page, 'NotReadableError')
    await page.getByRole('button', { name: 'Start camera' }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'Camera is in use' })).toBeVisible({
      timeout: 10_000,
    })
  })
})
