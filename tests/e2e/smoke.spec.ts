import { test, expect } from '@playwright/test'

test('the app shell loads with no console errors', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message)
  })

  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)

  // `/` is protected, so an anonymous visit lands on the sign-in form rather than the app.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('the manifest is reachable and installable', async ({ page, baseURL }) => {
  const response = await page.request.get(`${baseURL ?? ''}/manifest.webmanifest`)
  expect(response.ok()).toBe(true)
  const manifest = (await response.json()) as { name?: string; icons?: unknown[] }
  expect(manifest.name).toBe('PokePortfolio')
  expect(Array.isArray(manifest.icons)).toBe(true)
  expect((manifest.icons ?? []).length).toBeGreaterThan(0)
})
