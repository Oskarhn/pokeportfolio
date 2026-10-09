import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import {
  installRealisticBackend,
  makeHoldings,
  uuid,
  type Scenario,
} from './support/realistic-backend'

/**
 * P210: realistic-data layout and accessibility.
 *
 * P202's matrix proved every private route in three EMPTY states (empty, error, expired). This file
 * renders the same built bundle with deterministic realistic rows: a 600-holding portfolio with long
 * Pokémon and set names, several lots in mixed currencies, eight-figure and beyond-2^53 amounts,
 * missing, stale and manual prices, raw, graded and sealed holdings, purchase and history ledgers,
 * slow responses and a partially failing backend. Per cell: no horizontal page overflow, nothing
 * positioned off the right edge of the screen, no placeholder leakage ("NaN", "undefined"), and no
 * axe violations at WCAG 2.2 AA. It is a layout regression net, not a conformance claim and not a
 * financial oracle (the amounts are shown, never asserted as correct totals).
 *
 * Runs on chromium, desktop WebKit and the iPhone project. The service worker is blocked for the
 * same reason as in p202-route-matrix.spec.ts (WebKit's page.route() cannot see its traffic).
 */
test.use({ serviceWorkers: 'block' })

const VIEWPORTS = [
  { name: 'narrow-320', width: 320, height: 568 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

const LARGE: Scenario = { holdings: makeHoldings(600) }
// A multi-lot STALE holding, a multi-lot MISSING-price holding, and a manual one (see makeHoldings).
const STALE_MULTILOT = uuid(18)
const MISSING_MULTILOT = uuid(63)
const MANUAL_VALUED = uuid(22)

/**
 * Failed reads are retried with exponential backoff (react-query: 1 s, 2 s, 4 s) before the failure is
 * shown. The page's timers run on a fast-forwardable clock so that backoff is not waited out in real
 * time; every retry still makes a real (mocked) round trip, hence the short real waits in between.
 */
async function gotoAndLetRetriesRun(page: Page, route: string): Promise<void> {
  await page.clock.install()
  await page.goto(route)
  for (let step = 0; step < 8; step += 1) {
    await page.clock.fastForward(8_000)
    await page.waitForTimeout(150)
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle')
  // One frame for React to commit what the last response produced.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve()
        })
      }),
  )
}

/** The invariants every realistic-data cell must keep. */
async function expectSound(page: Page, label: string): Promise<void> {
  await expect(page.locator('h1:visible'), `${label}: exactly one visible <h1>`).toHaveCount(1)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, `${label}: horizontal page overflow (px)`).toBeLessThanOrEqual(0)

  // Visible text must not be laid out beyond the right edge (an element can overflow without
  // widening the page when an ancestor clips it, which silently truncates a figure).
  const clipped = await page.evaluate(() => {
    const limit = window.innerWidth + 1
    const bad: string[] = []
    for (const el of document.querySelectorAll('main *')) {
      if (!(el instanceof HTMLElement) || el.children.length > 0) continue
      const text = el.textContent.trim()
      if (text === '') continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const style = getComputedStyle(el)
      if (style.position === 'fixed' || style.visibility === 'hidden') continue
      if (rect.right <= limit) continue
      // Content inside a deliberate horizontal scroller (a tab bar, a wide table) that itself fits
      // the screen is reachable by scrolling and is not an overflow defect.
      let scroller = el.parentElement
      let inScroller = false
      while (scroller && scroller !== document.body) {
        const overflowX = getComputedStyle(scroller).overflowX
        if (
          (overflowX === 'auto' || overflowX === 'scroll') &&
          scroller.getBoundingClientRect().right <= limit
        ) {
          inScroller = true
          break
        }
        scroller = scroller.parentElement
      }
      if (!inScroller) bad.push(`${text.slice(0, 40)} → right=${Math.round(rect.right)}`)
    }
    return bad.slice(0, 5)
  })
  expect(clipped, `${label}: text beyond the right edge`).toEqual([])

  const body = (await page.locator('body').innerText()).slice(0, 200_000)
  expect(body, `${label}: placeholder leakage`).not.toMatch(
    /\bNaN\b|\bundefined\b|\[object Object\]|\bInfinity\b/,
  )

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze()
  expect(
    results.violations.map((v) => ({
      id: v.id,
      n: v.nodes.length,
      t: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
    })),
    `${label}: axe`,
  ).toEqual([])
}

for (const vp of VIEWPORTS) {
  test.describe(`p210 realistic data · ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })
    // The iPhone project is device emulation with its own native width: run the narrow cell only.
    test.skip(
      ({ isMobile }) => isMobile && vp.name !== 'narrow-320',
      'The iPhone project runs the narrow cell only.',
    )

    test('home: 600 holdings, eight-figure totals, partial coverage', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto('/')
      await settle(page)
      await expectSound(page, 'home')
    })

    test('portfolio: large list, long names, missing/stale/manual states, paging', async ({
      page,
    }) => {
      const log = await installRealisticBackend(page, LARGE)
      await page.goto('/portfolio')
      await settle(page)
      await expectSound(page, 'portfolio (first page)')

      // Some holdings in the first page have no price: "—", never a fabricated zero.
      const main = page.locator('main')
      await expect(main.getByText('—').first()).toBeVisible()

      // Scrolling asks for further pages; the keyset cursor must keep the page sound.
      const before = log.endpoints.filter((e) => e === 'list_portfolio').length
      for (let i = 0; i < 4; i += 1) {
        // Not mouse.wheel: it is unsupported in mobile WebKit.
        await page.evaluate(() => {
          window.scrollBy(0, 4000)
        })
        await page.waitForTimeout(250)
      }
      await settle(page)
      expect(log.endpoints.filter((e) => e === 'list_portfolio').length).toBeGreaterThan(before)
      await expectSound(page, 'portfolio (after paging)')
    })

    test('holding detail: stale price, seven lots in mixed currencies', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto(`/portfolio/${STALE_MULTILOT}`)
      await settle(page)
      await expectSound(page, 'holding detail (stale, 7 lots)')
    })

    test('holding detail: missing price with several lots is shown as absent', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto(`/portfolio/${MISSING_MULTILOT}`)
      await settle(page)
      await expectSound(page, 'holding detail (missing price)')
      await expect(page.locator('main').getByText('—').first()).toBeVisible()
    })

    test('holding detail: manually valued holding', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto(`/portfolio/${MANUAL_VALUED}`)
      await settle(page)
      await expectSound(page, 'holding detail (manual)')
    })

    test('purchases: mixed currencies, voided entries, long retailer names', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto('/purchases')
      await settle(page)
      await expectSound(page, 'purchases')
    })

    test('purchase detail: card, sealed and accessory lines', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto(`/purchases/${uuid(30_001)}`)
      await settle(page)
      await expectSound(page, 'purchase detail')
    })

    test('history: purchases, sales, valuations and voided events', async ({ page }) => {
      await installRealisticBackend(page, LARGE)
      await page.goto('/history')
      await settle(page)
      await expectSound(page, 'history')
    })

    test('slow network: a loading state is announced, then the data replaces it', async ({
      page,
    }) => {
      await installRealisticBackend(page, { ...LARGE, latencyMs: { list_portfolio: 2500 } })
      await page.goto('/portfolio')
      // While the slow read is in flight the page must already be a proper page (heading, landmark)
      // and clean under axe, not a blank screen.
      await expect(page.locator('main')).toBeVisible()
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
        .analyze()
      expect(results.violations.map((v) => v.id)).toEqual([])
      await expect(page.locator('main a[href^="/portfolio/"]').first()).toBeVisible({
        timeout: 15_000,
      })
      await settle(page)
      await expectSound(page, 'portfolio (after slow response)')
    })

    test('partial failure: the dashboard summary fails, the rest of Home still renders', async ({
      page,
    }) => {
      await installRealisticBackend(page, { ...LARGE, failing: ['get_dashboard_summary'] })
      await gotoAndLetRetriesRun(page, '/')
      await settle(page)
      await expectSound(page, 'home (summary failing)')
    })

    test('partial failure: the portfolio list fails while counts succeed', async ({ page }) => {
      await installRealisticBackend(page, { ...LARGE, failing: ['list_portfolio'] })
      await gotoAndLetRetriesRun(page, '/portfolio')
      await settle(page)
      await expectSound(page, 'portfolio (list failing)')
      await expect(page.getByRole('alert').first()).toBeVisible()
    })
  })
}
