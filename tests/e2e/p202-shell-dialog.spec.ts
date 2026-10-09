import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { installBackend } from './support/generic-backend'

// See p202-route-matrix.spec.ts: WebKit's page.route() does not see service-worker traffic (P210).
test.use({ serviceWorkers: 'block' })

/**
 * P202: app-shell behaviour that every private screen inherits — skip link, route announcements,
 * offline notice — and the shared dialog primitive (Sheet) on a short phone screen.
 * Run with --project=desktop-chromium (viewports are set per test).
 */

test.describe('p202 shell', () => {
  test('skip link is the first tab stop and moves keyboard focus into <main>', async ({
    page,
    browserName,
  }) => {
    await installBackend(page, 'empty')
    await page.goto('/portfolio')
    await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeAttached()
    const skip = page.getByRole('link', { name: 'Skip to content' })
    if (browserName === 'webkit') {
      // WebKit's Tab order skips links by default (macOS Safari needs Option+Tab or the "Press Tab to
      // highlight each item" preference; iOS needs Full Keyboard Access), so Tab can never land on the
      // skip link here. That is browser behaviour, not an application defect: assert what the link
      // does once focus reaches it by the means a WebKit user actually has.
      await skip.focus()
    } else {
      await page.keyboard.press('Tab')
    }
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('main#main-content')).toBeFocused()
  })

  test('route change is announced and the tab is titled after the new heading', async ({
    page,
  }) => {
    await installBackend(page, 'empty')
    await page.goto('/portfolio')
    await expect(page).toHaveTitle(/Portfolio · PokePortfolio/)
    await page.getByRole('link', { name: 'Search' }).first().click()
    await expect(page.getByRole('status').filter({ hasText: 'Search' }).first()).toBeAttached()
    await expect(page).toHaveTitle(/Search · PokePortfolio/)
  })

  test('offline: a single status notice appears, and clears when the connection returns', async ({
    page,
    context,
  }) => {
    await installBackend(page, 'empty')
    await page.goto('/portfolio')
    await expect(page.getByText("You're offline")).toHaveCount(0)
    await context.setOffline(true)
    await expect(page.getByRole('status').filter({ hasText: "You're offline" })).toBeVisible()
    await context.setOffline(false)
    await expect(page.getByText("You're offline")).toHaveCount(0)
  })
})

test.describe('p202 dialog (Sheet) on a short phone screen', () => {
  test.use({ viewport: { width: 320, height: 420 } })

  test('stays inside the viewport, traps focus, closes on Escape and restores focus', async ({
    page,
  }) => {
    await installBackend(page, 'empty')
    await page.goto('/portfolio')
    const trigger = page.getByRole('button', { name: 'Filters' })
    await trigger.focus()
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Filters' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toBeFocused()

    // The panel is capped to the visible height; content beyond that scrolls inside it.
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(420 + 1)

    // Exactly one close control is exposed to assistive technology (the scrim is aria-hidden).
    await expect(page.getByRole('button', { name: 'Close' })).toHaveCount(1)

    // Tab never escapes the dialog.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(
        () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
      )
      expect(inside, `Tab ${i + 1} left the dialog`).toBe(true)
    }

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze()
    expect(results.violations.map((v) => v.id)).toEqual([])

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})
