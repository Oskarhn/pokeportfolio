import { test, expect } from '@playwright/test'

/**
 * P101 launch-readiness coverage that doesn't already live in auth.spec.ts/a11y.spec.ts/
 * smoke.spec.ts: per-route document metadata (title/robots/canonical — src/ui/useDocumentMeta.ts),
 * keyboard submit and the double-submit guard on the sign-in form, the legal-page footer links, and
 * a representative viewport sweep over the public pages. Scoped to what's reachable without a
 * session — see a11y.spec.ts's header comment for why authenticated pages aren't here.
 */

test.describe('per-route document metadata', () => {
  test('private routes stay noindex by default', async ({ page }) => {
    await page.goto('/portfolio') // bounces to /login, never calls useDocumentMeta
    const robots = await page.locator('meta[name="robots"]').getAttribute('content')
    expect(robots).toBe('noindex, nofollow')
  })

  test('privacy/terms/faq opt into index,follow with a real title and canonical while mounted', async ({
    page,
  }) => {
    for (const [path, title] of [
      ['/privacy', 'Privacy'],
      ['/terms', 'Terms'],
      ['/faq', 'FAQ'],
    ] as const) {
      await page.goto(path)
      await expect(page).toHaveTitle(`${title} · PokePortfolio`)
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow')
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(`${path}$`),
      )
    }
  })

  test('robots reverts to noindex after navigating away from a public page', async ({ page }) => {
    await page.goto('/privacy')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow')
    await page.getByRole('link', { name: '← Back' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    )
    // The canonical tag public pages set must not leak onto a route that never asked for one.
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0)
  })

  test('404 page stays noindex and sets its own title', async ({ page }) => {
    await page.goto('/this-path-does-not-exist')
    await expect(page).toHaveTitle('Page not found · PokePortfolio')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    )
  })
})

test.describe('legal page footer links', () => {
  test('privacy/terms/faq are reachable from the sign-in screen', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
    await expect(page.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    await expect(page.getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '/faq')
  })

  test('each legal page links out to the other two', async ({ page }) => {
    await page.goto('/privacy')
    await expect(page.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    await expect(page.getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '/faq')
  })
})

test.describe('sign-in form: keyboard submit and double-submit guard', () => {
  test('Enter in the password field submits the form', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('nobody@example.invalid')
    await page.getByLabel('Password').fill('not-the-right-password')
    await page.getByLabel('Password').press('Enter')
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 })
  })

  test('the button disables itself for the duration of one in-flight submit', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('nobody@example.invalid')
    await page.getByLabel('Password').fill('not-the-right-password')
    const submit = page.getByRole('button', { name: /Sign in|Signing in/ })
    await submit.click()
    // Busy state disables the button and relabels it — a second click cannot fire a second
    // request while the first is still in flight.
    await expect(submit).toBeDisabled()
    await expect(submit).toHaveText('Signing in…')
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 })
    await expect(submit).toBeEnabled()
  })
})

test.describe('representative viewport sweep (public pages)', () => {
  // playwright.config.ts already runs every spec at both a 1440×900 desktop project and an
  // iPhone-14 mobile project; this adds the small-phone and tablet points the checklist names
  // that aren't otherwise covered by the project matrix.
  const viewports = [
    { name: '320x568 (iPhone SE)', width: 320, height: 568 },
    { name: '768x1024 (tablet portrait)', width: 768, height: 1024 },
    { name: '1920x1080 (desktop)', width: 1920, height: 1080 },
  ]

  for (const { name, width, height } of viewports) {
    test(`login and privacy fit without horizontal scroll at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      for (const path of ['/login', '/privacy']) {
        await page.goto(path)
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow).toBeLessThanOrEqual(0)
      }
    })
  }
})
