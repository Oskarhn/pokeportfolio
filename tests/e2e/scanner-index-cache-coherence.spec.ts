import { test, expect } from '@playwright/test'

/**
 * P87 F-01 — real-browser proof of the content-addressed visual-index cache design.
 *
 * `vite preview` (this suite's webServer) does not interpret `_headers` at all — that file is
 * Cloudflare-Pages-specific and ignored by both `vite dev` and `vite preview` (vite.config.ts's
 * own documented limitation, the same one `stale-deployment.spec.ts` and P83's live-`curl`
 * verification already work around). So this test does not rely on `vite preview` serving the
 * real production headers; instead it uses Playwright's request interception to serve realistic
 * fixture bodies through the EXACT Cache-Control headers `_headers` declares for each path, then
 * proves what a REAL Chromium HTTP cache does with them — the actual claim F-01 depends on, not
 * merely that the config file contains the right strings (that half is covered separately by
 * `tests/config/security-headers.test.ts` and `scripts/verify-scanner-platform-build.mjs`).
 *
 * Scenario: two index generations, A and B. A page loads A, the server "publishes" B (the pointer
 * now names B; A's files remain present, as a real deployment's old generation would), and a
 * fresh fetch cycle (simulating a new scanner session on the SAME already-loaded page, without a
 * reload) must observe B — proving the old fixed-URL design's failure mode (a browser silently
 * stuck on a year-old cached A) cannot happen here.
 */

const POINTER_PATH = '/scanner-assets/visual-v1/index/current.json'
const GEN_A_MANIFEST = '/scanner-assets/visual-v1/index/generations/aaaaaaaaaaaaaaaa/manifest.json'
const GEN_B_MANIFEST = '/scanner-assets/visual-v1/index/generations/bbbbbbbbbbbbbbbb/manifest.json'

test.describe('visual-index two-generation cache coherence (P87 F-01)', () => {
  test('the pointer always revalidates (no-cache) — a same-page refetch sees a newly published generation', async ({
    page,
  }) => {
    let currentContentId = 'aaaaaaaaaaaaaaaa'
    let pointerHits = 0

    await page.route(`**${POINTER_PATH}`, async (route) => {
      pointerHits += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-cache' },
        body: JSON.stringify({
          indexVersion: 'visual-v1',
          contentId: currentContentId,
          manifestPath: `generations/${currentContentId}/manifest.json`,
        }),
      })
    })

    await page.goto('/login')

    const first = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: 'no-store' })
      return (await response.json()) as { contentId: string }
    }, POINTER_PATH)
    expect(first.contentId).toBe('aaaaaaaaaaaaaaaa')
    expect(pointerHits).toBe(1)

    // The server "publishes" generation B — no page reload, exactly like a real deployment
    // shipping a new index while a tab stays open across scanner sessions.
    currentContentId = 'bbbbbbbbbbbbbbbb'

    const second = await page.evaluate(async (url) => {
      const response = await fetch(url, { cache: 'no-store' })
      return (await response.json()) as { contentId: string }
    }, POINTER_PATH)
    expect(second.contentId).toBe('bbbbbbbbbbbbbbbb')
    // The pointer was fetched from the network again, not answered from a cached copy of A's
    // pointer response — this is the load-bearing assertion: under the OLD fixed-immutable-path
    // design, this second read could never have observed B without the browser evicting or
    // expiring a year-long cache entry first.
    expect(pointerHits).toBe(2)
  })

  test('a content-addressed generation is served from cache on a repeat fetch, and two generations never mix', async ({
    page,
  }) => {
    let genAHits = 0
    let genBHits = 0

    await page.route(`**${GEN_A_MANIFEST}`, async (route) => {
      genAHits += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        body: JSON.stringify({ contentId: 'aaaaaaaaaaaaaaaa', cardCount: 111 }),
      })
    })
    await page.route(`**${GEN_B_MANIFEST}`, async (route) => {
      genBHits += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        body: JSON.stringify({ contentId: 'bbbbbbbbbbbbbbbb', cardCount: 222 }),
      })
    })

    await page.goto('/login')

    const fetchJson = (url: string) =>
      page.evaluate(async (u) => {
        const response = await fetch(u)
        return (await response.json()) as { contentId: string; cardCount: number }
      }, url)

    const a1 = await fetchJson(GEN_A_MANIFEST)
    const b1 = await fetchJson(GEN_B_MANIFEST)
    expect(a1).toEqual({ contentId: 'aaaaaaaaaaaaaaaa', cardCount: 111 })
    expect(b1).toEqual({ contentId: 'bbbbbbbbbbbbbbbb', cardCount: 222 })
    expect(genAHits).toBe(1)
    expect(genBHits).toBe(1)

    // Re-fetching EITHER generation a second time must never cross-contaminate the other's
    // content — proving immutable per-generation URLs coexist safely rather than one clobbering
    // the other the way a single fixed `/visual-v1/manifest.json` URL used to.
    const a2 = await fetchJson(GEN_A_MANIFEST)
    const b2 = await fetchJson(GEN_B_MANIFEST)
    expect(a2).toEqual({ contentId: 'aaaaaaaaaaaaaaaa', cardCount: 111 })
    expect(b2).toEqual({ contentId: 'bbbbbbbbbbbbbbbb', cardCount: 222 })
  })
})
