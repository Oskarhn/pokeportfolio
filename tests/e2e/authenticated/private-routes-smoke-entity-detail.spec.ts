import AxeBuilder from '@axe-core/playwright'
import { test, expect, type Page } from '@playwright/test'
import { createFixtureHolding, createFixturePurchase, createFixtureSale } from './fixtures'

/**
 * P111 §31 — companion to private-routes-smoke.spec.ts (P104), covering the entity-detail-shaped
 * private routes that file could not: each needs a REAL fixture row to navigate to (a holding,
 * purchase or sale id), which P104's static route list didn't have available. Same three checks
 * per route (mobile/large-phone overflow, zero axe-core WCAG 2.2 A/AA violations) against the same
 * real signed-in session.
 */

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

async function checkRoute(page: Page, path: string) {
  const errors = collectConsoleErrors(page)
  await page.goto(path)
  await page.waitForLoadState('networkidle')
  expect(page.url()).not.toContain('/login')

  for (const size of [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(100)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `horizontal overflow at ${size.width}px on ${path}`).toBeLessThanOrEqual(0)
  }

  expect(errors, `console errors on ${path}: ${errors.join(' | ')}`).toEqual([])

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22a', 'wcag22aa'])
    .analyze()
  expect(
    results.violations,
    results.violations
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`)
      .join('\n'),
  ).toEqual([])
}

// Each test creates a real fixture row for the SAME synthetic e2e user (auth.setup.ts creates
// exactly one) — serial to avoid the Postgres deadlock already observed under concurrent fixture
// creation for a shared user (entity-switch-regression.spec.ts's own note).
test.describe.configure({ mode: 'serial' })

test.describe('Private route smoke: entity-detail routes', () => {
  test('Holding detail (/portfolio/$holdingId)', async ({ page }) => {
    const { holdingId } = await createFixtureHolding()
    await checkRoute(page, `/portfolio/${holdingId}`)
  })

  test('Catalog (/catalog)', async ({ page }) => {
    await checkRoute(page, '/catalog')
  })

  test('Purchase Edit (/purchases/$purchaseId/edit)', async ({ page }) => {
    const { purchaseId } = await createFixturePurchase()
    await checkRoute(page, `/purchases/${purchaseId}/edit`)
  })

  test('Sale Edit (/sales/$saleId/edit)', async ({ page }) => {
    const { saleId } = await createFixtureSale()
    await checkRoute(page, `/sales/${saleId}/edit`)
  })
})
