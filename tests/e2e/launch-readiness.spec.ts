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

  test('P103: token-bearing and private routes never set a canonical tag or leak their query/path value into meta', async ({
    page,
  }) => {
    const SECRET_INVITE_TOKEN = 'p103-test-invite-secret-do-not-index'
    const SECRET_RESET_TOKEN = 'p103-test-reset-secret-do-not-index'
    const routes = [
      `/invite/${SECRET_INVITE_TOKEN}`,
      `/reset-password?token=${SECRET_RESET_TOKEN}`,
      '/scanner?scannerDebug=1',
      '/portfolio?holdingId=11111111-1111-1111-1111-111111111111',
    ]
    for (const route of routes) {
      await page.goto(route)
      // None of these routes call useDocumentMeta — robots must stay the safe default and no
      // canonical tag may exist (a canonical pointing at a URL that embeds the secret would be
      // exactly the leak vector DECISIONS.md D-116 calls out).
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex, nofollow',
      )
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(0)
      // Belt-and-suspenders: the secret string itself must not appear in ANY meta/link tag's
      // content/href, however it got there.
      const headHtml = await page.locator('head').innerHTML()
      expect(headHtml).not.toContain(SECRET_INVITE_TOKEN)
      expect(headHtml).not.toContain(SECRET_RESET_TOKEN)
    }
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
    // Against a local/CI Supabase instance the real sign-in round trip can resolve faster than
    // Playwright's assertion polling interval, so the disabled window can open and close entirely
    // between polls (observed flake: CI run 34119058670). Delaying the auth response — the app
    // never sees anything different about the request or response — gives that window a duration
    // long enough to reliably observe.
    await page.route('**/auth/v1/token*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await route.continue()
    })
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
  // iPhone-14 mobile project; this covers the P103 prompt's full named matrix (§9) explicitly,
  // independent of whatever the two projects happen to use.
  const viewports = [
    { name: '320x568 (iPhone SE)', width: 320, height: 568 },
    { name: '375x667 (iPhone 8)', width: 375, height: 667 },
    { name: '390x844 (iPhone 12/13/14)', width: 390, height: 844 },
    { name: '430x932 (iPhone 14 Pro Max)', width: 430, height: 932 },
    { name: '768x1024 (tablet portrait)', width: 768, height: 1024 },
    { name: '1280x720 (small desktop)', width: 1280, height: 720 },
    { name: '1920x1080 (desktop)', width: 1920, height: 1080 },
  ]
  const pages = [
    '/login',
    '/privacy',
    '/terms',
    '/faq',
    '/this-path-does-not-exist',
    '/forgot-password',
    '/invite/p103-viewport-sweep-token',
  ]

  for (const { name, width, height } of viewports) {
    test(`every public page fits without horizontal scroll at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      for (const path of pages) {
        await page.goto(path)
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow, `${path} at ${name}`).toBeLessThanOrEqual(0)
      }
    })
  }
})
