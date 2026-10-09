import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { installBackend } from './support/generic-backend'

// The service worker takes control of the page shortly after the first load. In WebKit, page.route()
// does not see requests a service worker forwards, so the later retries of a failed read reached the
// real (absent) backend and the error state never settled. The matrix is about the rendered UI, not
// the service worker (p202-pwa.spec.ts covers that), so the worker is blocked here (P210).
test.use({ serviceWorkers: 'block' })

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

for (const state of ['empty', 'error', 'expired'] as const) {
  for (const vp of VIEWPORTS) {
    test.describe(`p202 matrix · ${state} · ${vp.name}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } })
      // The iPhone project is a device emulation (touch, mobile viewport meta handling): it runs the
      // device-native width only. desktop-chromium and desktop-webkit run all four widths.
      test.skip(
        ({ isMobile }) => isMobile && vp.name !== '390',
        'The iPhone project runs the device-native cell only.',
      )

      for (const route of ROUTES) {
        test(route, async ({ page }) => {
          await installBackend(page, state)
          if (state === 'error') {
            // Failed reads are retried with exponential backoff (react-query: 1 s, 2 s, 4 s) before the
            // error state shows, and the matrix has 104 such cells per browser project: waiting that
            // out in real time was ~10 minutes of CI per project (P210). The page's own timers run on
            // a fast-forwardable clock instead; each retry still makes a real (mocked) round trip, so
            // the clock is advanced between short real waits until the settled heading is there.
            await page.clock.install()
            await page.goto(route)
            for (let step = 0; step < 12; step += 1) {
              await page.clock.fastForward(8_000)
              if ((await page.locator('h1:visible').count()) === 1) break
              await page.waitForTimeout(150)
            }
          } else {
            await page.goto(route)
            // Let loading → settled transitions finish; the matrix asserts the settled state.
            await page.waitForTimeout(1200)
          }
          if (state === 'expired') {
            // An expired session must land on the sign-in page, never a half-rendered private page.
            await expect(page).toHaveURL(/\/login/)
          }
          // Failed requests are retried (react-query default: 3, ~7 s) before the error state shows.
          await expect(page.locator('h1:visible'), 'exactly one visible <h1>').toHaveCount(1, {
            timeout: 12_000,
          })
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
