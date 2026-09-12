import { test, expect } from '@playwright/test'

/**
 * P118 §16 — CacheStorage privacy audit, explicitly NOT done in P115 ("no dedicated private
 * CacheStorage inspection"). docs/ARCHITECTURE.md §6 states financial/auth data must never be
 * cached by the Service Worker; vite.config.ts's Workbox config precaches only the app shell
 * (`globPatterns: ['**\/*.{js,css,html,svg,png,ico,woff2}']`, no `.json`) and registers exactly
 * three runtime-caching routes, all scoped to `/scanner-assets/...` paths (`scanner-assets-v7`,
 * `scanner-assets-visual-v1`, `scanner-assets-visual-v1-index`). This proves that CONFIGURATION
 * empirically at runtime: after real app-shell loads, real public navigation, and real (mocked)
 * Supabase-shaped network responses fired from the page, CacheStorage contains nothing outside
 * that allow-list — no Supabase JSON, no auth/session/OTP payload, no purchase/sale data.
 *
 * Scope note (coordinated with P116, which owns scanner-specific cache faults): this file checks
 * the GENERIC app-shell/privacy boundary, not whether the scanner runtime caches behave correctly
 * under fault conditions (that's scanner-visual-index-fault-matrix.spec.ts /
 * scanner-index-cache-coherence.spec.ts).
 */

const SENTINEL_MARKERS = [
  'SENTINEL_PRIVATE_PURCHASE_NOTE_9f3a2c',
  'SENTINEL_ACCESS_TOKEN_eyJhbGciOiJIUzI1NiJ9_fake',
  'SENTINEL_REFRESH_TOKEN_7d4e1b',
  'SENTINEL_OTP_CODE_048213',
  'SENTINEL_SALE_MARKETPLACE_NOTE_b81f',
]

const EXPECTED_RUNTIME_CACHE_NAMES = new Set([
  'scanner-assets-v7',
  'scanner-assets-visual-v1',
  'scanner-assets-visual-v1-index',
])

// vite-plugin-pwa always injects the web app manifest into the precache manifest regardless of
// `globPatterns` (needed for offline installability) — confirmed empirically here, not just read
// from vite.config.ts's own comment, which only documents globPatterns' own extension list.
// `.webmanifest` is public app metadata (name/icons/theme), never a privacy concern.
const PRECACHE_ALLOWED_EXTENSIONS = /\.(js|css|html|svg|png|ico|woff2|webmanifest)(\?.*)?$/i

function isExpectedCacheName(name: string): boolean {
  return name.startsWith('workbox-precache-') || EXPECTED_RUNTIME_CACHE_NAMES.has(name)
}

interface CacheAudit {
  cacheNames: string[]
  entries: { cacheName: string; url: string; bodySample: string }[]
}

async function auditAllCaches(page: import('@playwright/test').Page): Promise<CacheAudit> {
  return page.evaluate(async () => {
    const cacheNames = await caches.keys()
    const entries: { cacheName: string; url: string; bodySample: string }[] = []
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName)
      const requests = await cache.keys()
      for (const request of requests) {
        let bodySample = ''
        try {
          const response = await cache.match(request)
          if (response) {
            const contentType = response.headers.get('content-type') ?? ''
            if (contentType.includes('json') || contentType.includes('text')) {
              bodySample = (await response.clone().text()).slice(0, 5000)
            }
          }
        } catch {
          bodySample = ''
        }
        entries.push({ cacheName, url: request.url, bodySample })
      }
    }
    return { cacheNames, entries }
  })
}

test.describe('CacheStorage privacy audit (P118 §16)', () => {
  test('after app load, public navigation and mocked private-shaped network activity, no cache stores private data', async ({
    page,
  }) => {
    // Arm interceptors BEFORE any navigation for a battery of Supabase-shaped and generic
    // API-shaped URLs — both the real configured project host (whatever VITE_SUPABASE_URL is,
    // read back from the page at runtime below) and a definitely-fake one, so this doesn't
    // depend on knowing the real project ref in this test file.
    await page.route('**/rest/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'fake-purchase-1',
            notes: SENTINEL_MARKERS[0],
            marketplace: SENTINEL_MARKERS[4],
          },
        ]),
      }),
    )
    await page.route('**/auth/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: SENTINEL_MARKERS[1],
          refresh_token: SENTINEL_MARKERS[2],
          user: { email: 'sentinel@example.test' },
        }),
      }),
    )
    await page.route('**/functions/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ otp: SENTINEL_MARKERS[3] }),
      }),
    )
    await page.route('**sentinel-fake-project.supabase.co/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ marker: SENTINEL_MARKERS[0] }),
      }),
    )

    // Real app-shell load, real Service Worker registration/activation.
    await page.goto('/login')
    await page.evaluate(() => navigator.serviceWorker.ready)

    // Real public navigation across several routes (exercises navigateFallback/app-shell caching
    // for more than one page).
    for (const path of ['/privacy', '/terms', '/faq', '/forgot-password', '/login']) {
      await page.goto(path)
    }

    // Mocked private-shaped network activity fired directly from the page — a REST read, an auth
    // token exchange, an Edge Function call, and a request to a fake Supabase-lookalike host.
    // Every one of these matches a route above and resolves with sentinel-bearing JSON; nothing
    // here has any business being written into a CacheStorage entry regardless of outcome.
    await page.evaluate(async () => {
      const attempts = [
        fetch('https://sentinel-fake-project.supabase.co/rest/v1/purchases?select=*'),
        fetch('https://sentinel-fake-project.supabase.co/auth/v1/token?grant_type=password', {
          method: 'POST',
          body: JSON.stringify({ email: 'x', password: 'y' }),
        }),
        fetch('https://sentinel-fake-project.supabase.co/functions/v1/redeem-invitation', {
          method: 'POST',
        }),
      ]
      await Promise.allSettled(attempts)
    })

    // Attempted authenticated-like navigation, safely stubbable: the route guard redirects an
    // unauthenticated visit before any real data fetch — this just proves that redirect race
    // leaves nothing behind either.
    await page.goto('/portfolio')
    await page.waitForLoadState('networkidle')

    const audit = await auditAllCaches(page)

    // 1) Only the expected precache + the three documented scanner runtime caches may exist.
    for (const name of audit.cacheNames) {
      expect(isExpectedCacheName(name), `unexpected cache name: ${name}`).toBe(true)
    }

    for (const entry of audit.entries) {
      // 2) No entry's URL is Supabase-shaped or API-shaped.
      expect(entry.url, `private-shaped URL cached: ${entry.url}`).not.toMatch(
        /supabase\.co|\/rest\/v1\/|\/auth\/v1\/|\/functions\/v1\/|sentinel-fake-project/i,
      )
      // 3) No cached body contains any sentinel marker.
      for (const marker of SENTINEL_MARKERS) {
        expect(
          entry.bodySample,
          `sentinel marker '${marker}' found cached at ${entry.url}`,
        ).not.toContain(marker)
      }
      // 4) Anything in a workbox-precache-* cache must be a real static asset extension — a
      // future accidental widening of globPatterns to include `.json` would be caught here.
      if (entry.cacheName.startsWith('workbox-precache-')) {
        const path = new URL(entry.url).pathname
        expect(path, `precache entry has a non-asset extension: ${entry.url}`).toMatch(
          PRECACHE_ALLOWED_EXTENSIONS,
        )
      }
    }
  })

  test('build-meta.json (deliberately excluded from precache) is never present in any cache', async ({
    page,
  }) => {
    // vite.config.ts's own comment: build-meta.json is deliberately excluded from the Workbox
    // precache glob (no `.json` extension in globPatterns) so a stale cached answer can never mask
    // a newer deployment. Confirm that holds at runtime, not just by reading the config.
    await page.goto('/login')
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.request.get('/build-meta.json')
    const audit = await auditAllCaches(page)
    for (const entry of audit.entries) {
      expect(entry.url).not.toContain('build-meta.json')
    }
  })
})
