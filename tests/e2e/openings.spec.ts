import { test, expect } from '@playwright/test'

/**
 * M16 openings — what is verifiable without a signed-in session (the standing no-sign-in
 * boundary): the routes exist, sit behind RequireSession like every other protected route, and
 * an anonymous visit lands on the sign-in form rather than leaking the feature shell.
 *
 * The wizard's real flows are exercised by tests/ui/opening-*.test.ts against mocked controllers;
 * authenticated browser walkthroughs remain an owner-device item until P53 wires the backend.
 */
test('opening routes are registered and session-guarded', async ({ page }) => {
  const response = await page.goto('/openings/new')
  expect(response?.ok()).toBe(true)
  // Guard: anonymous visitors see sign-in, never half of the wizard.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  const detail = await page.goto('/openings/00000000-0000-0000-0000-000000000001')
  expect(detail?.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})
