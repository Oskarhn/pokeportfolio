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

// M15 scanner (P66): the route exists behind feature wiring but is session-guarded like every
// other protected route, and — deliberately — nothing in the signed-out chrome advertises it.
// The signed-in scanner flow itself needs a real session (standing no-sign-in boundary), so its
// behaviour is covered by tests/ui/scanner-*.test.ts instead of here.
test('the scanner route is session-guarded and loads with no console errors', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message)
  })

  await page.goto('/scan')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(consoleErrors).toEqual([])
})
