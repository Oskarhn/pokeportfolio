import { test, expect } from '@playwright/test'

/**
 * P189: the public account-deletion information page. Reachable WITHOUT a session (this suite runs
 * against the placeholder backend: no sign-in, no network to Supabase), crawlable like the other
 * public pages, and truthful: no retention period, no invented contact.
 */

test('is reachable signed-out, with a real title, canonical and index,follow', async ({ page }) => {
  await page.goto('/account-deletion')
  await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible()
  await expect(page).toHaveTitle('Delete your account · PokePortfolio')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow')
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/account-deletion$/)
  // It did not bounce to the sign-in page.
  expect(new URL(page.url()).pathname).toBe('/account-deletion')
})

test('explains how to delete in the app, what is covered and what is not', async ({ page }) => {
  await page.goto('/account-deletion')
  const body = page.locator('main, body').first()
  await expect(body).toContainText('Delete it in the app')
  await expect(body).toContainText('Profile')
  await expect(body).toContainText('Delete account')
  await expect(body).toContainText('What is deleted')
  await expect(body).toContainText('What deletion does not reach')
  await expect(body).toContainText('Database backups')
  await expect(body).toContainText('Restoring a backup')
  await expect(body).toContainText('Logs')
})

test('states no retention period and invents no contact', async ({ page }) => {
  await page.goto('/account-deletion')
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  // No "N days / weeks / months" claim anywhere on the page.
  expect(text).not.toMatch(/\b\d+\s*(days?|weeks?|months?|years?)\b/i)
  expect(text).not.toMatch(/permanently erased from (all|every) backups?/i)
  expect(text).not.toMatch(/within\s+\d+/i)
  // Exactly the one address the Privacy page already publishes.
  const mails = await page
    .locator('a[href^="mailto:"]')
    .evaluateAll((a) => a.map((x) => (x as HTMLAnchorElement).getAttribute('href')))
  expect(new Set(mails)).toEqual(new Set(['mailto:oskarhn06@outlook.com']))
  await page.goto('/privacy')
  const privacyMails = await page
    .locator('a[href^="mailto:"]')
    .evaluateAll((a) => a.map((x) => (x as HTMLAnchorElement).getAttribute('href')))
  expect(new Set(privacyMails)).toEqual(new Set(['mailto:oskarhn06@outlook.com']))
})

test('is linked from the sign-in footer and from the Privacy page', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByRole('link', { name: 'Delete account' })).toHaveAttribute(
    'href',
    '/account-deletion',
  )
  await page.goto('/privacy')
  await expect(page.getByRole('link', { name: 'account deletion page' })).toHaveAttribute(
    'href',
    '/account-deletion',
  )
})
