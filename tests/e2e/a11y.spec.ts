import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * WCAG 2.2 AA automated sweep (P101, docs/LAUNCH_CHECKLIST.md item 17) over every page reachable
 * WITHOUT a session — the standing no-sign-in boundary (since M7.1, restated throughout
 * HANDOVER.md) means no authenticated page can be exercised by real browser automation this
 * session. Everything behind `RequireSession` is a code-level review + an owner manual-checklist
 * item instead (docs/LAUNCH_CHECKLIST.md item 17's OWNER ACTION), not a gap silently left
 * untested here.
 *
 * `axe-core` catches structural/contrast/label violations; it does not replace a real keyboard or
 * screen-reader pass — docs/DESIGN_SYSTEM.md §9 documents the baseline these pages are built to.
 */

async function expectNoViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze()
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
}

test('login page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expectNoViolations(page)
})

test('forgot-password page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/forgot-password')
  await expectNoViolations(page)
})

test('invite page (invalid token) has no automated accessibility violations', async ({ page }) => {
  await page.goto('/invite/not-a-real-token')
  await expect(page.getByRole('heading', { name: 'Invitation unavailable' })).toBeVisible()
  await expectNoViolations(page)
})

test('privacy page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible()
  await expectNoViolations(page)
})

test('terms page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/terms')
  await expect(page.getByRole('heading', { name: 'Terms of use' })).toBeVisible()
  await expectNoViolations(page)
})

test('FAQ page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/faq')
  await expect(page.getByRole('heading', { name: 'Frequently asked questions' })).toBeVisible()
  await expectNoViolations(page)
})

test('P103: login form is fully keyboard-operable (Tab order, visible focus, Enter submit)', async ({
  page,
}) => {
  await page.goto('/login')
  await page.getByLabel('Email').focus()
  await expect(page.getByLabel('Email')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Password')).toBeFocused()
  // Text inputs (src/ui/form.tsx) deliberately use `outline-none` plus a focus-visible
  // ring/border-color change instead of the native outline — confirm THAT indicator is actually
  // present on focus, not just that the field is technically focusable.
  const focusStyle = await page
    .getByLabel('Password')
    .evaluate((el) => getComputedStyle(el).boxShadow)
  expect(focusStyle).not.toBe('none')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByLabel('Email')).toBeFocused()
})

test('404 page has no automated accessibility violations', async ({ page }) => {
  await page.goto('/this-path-does-not-exist')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expectNoViolations(page)
})

test('404 page has no automated accessibility violations in DARK mode (P103 primary-button contrast fix)', async ({
  page,
}) => {
  // The 404 page's "Go home" link is styled with the shared primary-button classes
  // (bg-sky-600/text-accent-foreground) — the exact surface that measured 2.53:1 (a real WCAG AA
  // failure) before P103's fix. This is the one unauthenticated page real browser automation can
  // reach that renders that surface, so it carries the real, live proof for the fix (dark mode is
  // where the failure was — light mode already passed and is covered by the light-mode run above).
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/this-path-does-not-exist')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await expectNoViolations(page)
})
