import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { installFakeSession } from './support/fake-session'

/**
 * P202: route × state × viewport matrix against the placeholder-backend preview build.
 *
 * Every private route is reached with a synthetic session (support/fake-session.ts) and a
 * network-boundary stand-in for the backend (page.route), so the SAME built bundle is exercised in
 * three data states without a database:
 *   - empty:   every read succeeds with no rows
 *   - error:   every backend call fails with HTTP 500
 *   - expired: the stored session is already expired and the token endpoint refuses to refresh it
 *
 * Per cell the test asserts the invariants that are cheap to state and expensive to regress:
 * no horizontal page overflow, exactly one <h1>, a <main> landmark, and no axe violations at
 * WCAG 2.2 AA. This is a regression net, not a WCAG conformance claim — automated checks find a
 * fraction of real barriers (docs/DESIGN_SYSTEM.md §9 lists the manual checks).
 */

type DataState = 'empty' | 'error' | 'expired'

const VIEWPORTS = [
  { name: '320', width: 320, height: 568 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
] as const

const U = '00000000-0000-4000-8000-0000000000aa'

const ROUTES = [
  '/',
  '/portfolio',
  `/portfolio/${U}`,
  '/portfolio/manual/new',
  '/portfolio/sealed/new',
  '/add',
  '/catalog',
  `/catalog/${U}`,
  '/catalog/sets/base1',
  `/catalog/sealed/${U}`,
  '/purchases',
  '/purchases/new',
  `/purchases/${U}`,
  `/purchases/${U}/edit`,
  '/sales/new',
  `/sales/${U}`,
  `/sales/${U}/edit`,
  '/history',
  '/market-movers',
  '/openings/new',
  `/openings/${U}`,
  '/price-check',
  '/profile',
  '/profile/export',
  '/admin/invitations',
  '/scan',
] as const

async function installBackend(page: Page, state: DataState): Promise<void> {
  await installFakeSession(page, {
    expiresAtSeconds: state === 'expired' ? Math.floor(Date.now() / 1000) - 60 : undefined,
  })
  await page.route(/\/(rest|functions|auth)\/v1\//, async (route) => {
    const request = route.request()
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const url = new URL(request.url())
    if (url.pathname.includes('/auth/v1/')) {
      return route.fulfill({
        status: 400,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'refresh refused' }),
      })
    }
    if (state === 'error') {
      return route.fulfill({
        status: 500,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'synthetic failure' }),
      })
    }
    const wantsObject = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object')
    if (wantsObject) {
      return route.fulfill({
        status: 406,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '', hint: null }),
      })
    }
    return route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: '[]',
    })
  })
}

for (const state of ['empty', 'error', 'expired'] as const) {
  for (const vp of VIEWPORTS) {
    test.describe(`p202 matrix · ${state} · ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } })
      // Run with --project=desktop-chromium: the viewport is set per cell, so the iPhone project
      // would only repeat the matrix under a different user agent.

      for (const route of ROUTES) {
        test(`${route}`, async ({ page }) => {
          await installBackend(page, state)
          await page.goto(route)
          // Let loading → settled transitions finish; the matrix asserts the settled state.
          await page.waitForTimeout(state === 'error' ? 2500 : 1200)
          if (state === 'expired') {
            // An expired session must land on the sign-in page, never a half-rendered private page.
            await expect(page).toHaveURL(/\/login/)
          }
          const h1 = await page.locator('h1:visible').count()
          expect(h1, 'exactly one visible <h1>').toBe(1)
          expect(await page.locator('main').count(), 'a <main> landmark').toBeGreaterThanOrEqual(1)
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          )
          expect(overflow, 'horizontal page overflow (px)').toBeLessThanOrEqual(0)
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
            .analyze()
          expect(
            results.violations.map((v) => ({
              id: v.id,
              n: v.nodes.length,
              t: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
            })),
          ).toEqual([])
        })
      }
    })
  }
}
