import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'

/**
 * P104 — private-route smoke coverage over the existing local authenticated E2E harness
 * (auth.setup.ts/playwright.config.ts, P94 §20-22). Three things per route, all against a REAL
 * signed-in session on the real local Supabase stack: the route renders (no redirect back to
 * /login, no thrown console error), it fits a mobile viewport without horizontal overflow, and it
 * carries zero axe-core WCAG 2.2 A/AA violations. Not a substitute for the full per-route
 * mobile/forms/performance matrix — this is what a smoke pass over `desktop-chromium-authenticated`
 * can honestly cover without a purpose-built mobile-authenticated Playwright project (none is
 * registered in playwright.config.ts today) or per-form fixture work.
 */

const PRIVATE_ROUTES = [
  { name: 'Home', path: '/' },
  { name: 'Portfolio', path: '/portfolio' },
  { name: 'Purchases', path: '/purchases' },
  { name: 'Purchase Add', path: '/purchases/new' },
  { name: 'Sale Add', path: '/sales/new' },
  { name: 'Opening Add', path: '/openings/new' },
  { name: 'History', path: '/history' },
  { name: 'Profile', path: '/profile' },
  { name: 'Scanner intro', path: '/scan' },
]

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

for (const route of PRIVATE_ROUTES) {
  test.describe(`Private route smoke: ${route.name} (${route.path})`, () => {
    test('renders signed in, no console errors, no horizontal overflow', async ({ page }) => {
      const errors = collectConsoleErrors(page)
      await page.goto(route.path)
      await page.waitForLoadState('networkidle')

      // A real render of the intended route, not a bounce back to sign-in — the same
      // behavior-level proof auth.setup.ts itself uses (waiting for the URL, not guessing at
      // page content).
      expect(page.url()).not.toContain('/login')

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)

      // Scanner's cold OCR/WASM load can log benign warnings during model init; only real errors
      // fail every other route, so this file holds every route to the same standard rather than
      // special-casing scanner's console output.
      expect(errors, `console errors on ${route.path}: ${errors.join(' | ')}`).toEqual([])
    })

    test('fits a mobile viewport (390x844) without horizontal overflow', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(route.path)
      await page.waitForLoadState('networkidle')
      expect(page.url()).not.toContain('/login')

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })

    test('fits a large-phone viewport (430x932) without horizontal overflow', async ({ page }) => {
      await page.setViewportSize({ width: 430, height: 932 })
      await page.goto(route.path)
      await page.waitForLoadState('networkidle')
      expect(page.url()).not.toContain('/login')

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    })

    test('zero axe-core WCAG 2.2 A/AA violations', async ({ page }) => {
      await page.goto(route.path)
      await page.waitForLoadState('networkidle')
      expect(page.url()).not.toContain('/login')

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag22a', 'wcag22aa'])
        .analyze()

      expect(
        results.violations,
        results.violations
          .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`)
          .join('\n'),
      ).toEqual([])
    })
  })
}
