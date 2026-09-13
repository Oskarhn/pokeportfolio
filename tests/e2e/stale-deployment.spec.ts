import { test, expect } from '@playwright/test'

/**
 * P83, D-100 — real-browser proof that a stale-chunk failure recovers instead of surfacing as the
 * raw "'text/html' is not a valid JavaScript MIME type" crash a real iPhone hit (P83 §0).
 *
 * `/login` is an EAGER route (router.tsx never lazy-loads auth screens) reachable with no
 * Supabase session, so it exercises `main.tsx`'s real production bootstrap — including
 * `initBuildFreshnessWatch()`, started unconditionally before the first render — without needing
 * the authenticated session this E2E harness deliberately never fakes (playwright.config.ts).
 *
 * Root-cause repro, verified directly in this session: `curl` against this suite's own `vite
 * preview` webServer for a nonexistent hashed asset path returned `200 text/html` — BYTE-FOR-BYTE
 * the same failure shape `curl` also produced against the live Cloudflare Pages preview for PR #63
 * (output_83.txt's `_headers`/root-cause section). Under WebKit specifically, requesting the SAME
 * missing path from inside the page instead came back as a genuine 404 (a real, disclosed platform
 * difference in how `vite preview`'s dev-only history-fallback middleware classifies the request —
 * unrelated to `_redirects`, which Cloudflare Pages ignores here too) — but EITHER response still
 * makes the browser's module loader fail the import; WebKit's own real error text was confirmed
 * directly to be `TypeError: Importing a module script failed.`, a message `isChunkLoadFailure`
 * already matches (tests/ui/build-freshness.test.ts covers the full message-shape list).
 *
 * Recovery-path trigger: dispatching `vite:preloadError` directly, rather than relying on a raw
 * unhandled promise rejection from a `page.evaluate`-injected `import()`. Confirmed directly in
 * this session that the latter DOES surface as a genuine `unhandledrejection` DOM event under
 * Chromium, but — under WebKit specifically — a rejection from code injected via CDP
 * `page.evaluate()` was observed NOT to surface as `unhandledrejection` at all (a WebKit/CDP-
 * injection interaction; untested whether ordinary top-level application script differs, disclosed
 * rather than papered over). Vite's own `vite:preloadError` mechanism — the actual path every real
 * `React.lazy` chunk in this app goes through (router.tsx) — does not depend on native
 * `unhandledrejection` propagation at all: Vite's generated `__vitePreload` wrapper catches the
 * rejection itself and dispatches this event explicitly, cross-browser, by design
 * (vite.dev/guide/build.html). Dispatching it directly is therefore the reliable, honest way to
 * drive this suite's own listener (`onPreloadError`, build-freshness-runtime.ts) through its real
 * production code path in both engines.
 */

const MISSING_CHUNK_URL = '/assets/DefinitelyMissingChunk-p83e2e123456.js'

test.describe('stale-deployment recovery (P83, D-100)', () => {
  test('a stale dynamic import genuinely fails to load in this real browser (root-cause repro)', async ({
    page,
  }) => {
    await page.goto('/login')
    const result = await page.evaluate(async (url) => {
      try {
        await import(/* @vite-ignore */ url)
        return { failed: false, message: null as string | null }
      } catch (error) {
        return { failed: true, message: String(error) }
      }
    }, MISSING_CHUNK_URL)
    expect(result.failed).toBe(true)
    expect(result.message).toBeTruthy()
  })

  test('a stale dynamic-import failure reloads instead of leaving a raw MIME-type crash on screen', async ({
    page,
  }) => {
    await page.goto('/login')
    await expect(page.locator('body')).toBeVisible()

    const nextLoad = page.waitForEvent('load', { timeout: 10_000 })

    await page.evaluate(() => {
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    })

    // Recovery: no unsaved scanner work exists on a fresh /login load, so
    // resolveStaleDeploymentAction reloads automatically — the page navigates again rather than
    // sitting on a broken module graph or a raw crash screen.
    await nextLoad

    expect(page.url()).toContain('/login')
    await expect(page.locator('body')).toBeVisible()
    // The page came back up cleanly — the login form is real content, not a leftover error
    // screen ("Something went wrong!"/a bare MIME-type message).
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0)
    await expect(page.getByText(/is not a valid javascript mime type/i)).toHaveCount(0)
  })
})
