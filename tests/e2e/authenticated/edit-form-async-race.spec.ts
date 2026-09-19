import { test, expect, type Page } from '@playwright/test'
import { createFixturePurchase, createFixtureSale } from './fixtures'
import { seedCatalog } from '../../db/setup'

/**
 * P125 integration gap-closure (prompt §24-25): P124 fixed a real stale-mutation-callback race in
 * PurchaseEditPage/SaleEditPage (`useIsMountedRef` guarding `submit`'s onSuccess/onError) but only
 * ever proved it with a from-scratch state-machine reproduction
 * (`tests/ui/edit-form-async-race.test.ts` — "no React renderer exists in this project"). That
 * proves the guard SHAPE is correct in isolation; it does not prove the real PurchaseEditPage/
 * SaleEditPage components, real TanStack Router navigation and a real (delayed) network response
 * compose the same way. This file closes that gap against the real, signed-in app.
 */

async function navigateWithinApp(page: Page, path: string) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

/** Intercepts one RPC call, holding it until the returned `release` is invoked, then lets it
 *  through unmodified (success) or fulfills it with a given error body. */
function delayRpc(page: Page, rpcName: string) {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let mode: 'continue' | { status: number; message: string } = 'continue'
  let held = 0
  let handledResolve: () => void = () => {}
  const handled = new Promise<void>((resolve) => {
    handledResolve = resolve
  })
  // The data layer calls these RPCs as `.rpc(...).select(<columns>)`, so the request URL carries a
  // query string. A glob such as `**/rest/v1/rpc/update_purchase` does NOT match that URL
  // (checked: it matches the bare path only), which is how these specs held nothing at all for
  // three sessions and passed or failed on timing luck (P147). Match the path with or without a
  // query, and make every test prove the request really was held (`expectHeld`).
  const pattern = new RegExp(`/rest/v1/rpc/${rpcName}(?:\\?.*)?$`)
  const routePromise = page.route(pattern, async (route) => {
    held += 1
    await released
    if (mode === 'continue') {
      await route.continue()
    } else {
      await route.fulfill({
        status: mode.status,
        contentType: 'application/json',
        body: JSON.stringify({ message: mode.message, code: 'P0001' }),
      })
    }
    handledResolve()
  })
  return {
    routePromise,
    release,
    failWith(status: number, message: string) {
      mode = { status, message }
    },
    /** The request was intercepted and is being held. Without this a route that silently matches
     *  nothing lets the save finish at once and the test asserts on a race it never created. */
    async expectHeld() {
      await expect.poll(() => held, { timeout: 5_000 }).toBe(1)
    },
    async unroute() {
      // Let a held request finish being answered first: unrouting while the handler is still about to
      // continue()/fulfill() the request makes Playwright treat the route as already handled.
      if (held > 0) await handled
      await page.unroute(pattern)
    },
  }
}

// Every test creates real fixture rows for the one synthetic e2e user auth.setup.ts created;
// run serially for the same reason entity-switch-regression.spec.ts does (concurrent workers
// hammering one user's rows hit a real Postgres deadlock unrelated to the race being tested).
test.describe.configure({ mode: 'serial' })

test.describe('PurchaseEditPage — stale onSuccess/onError after an in-app entity switch (P124/P125)', () => {
  test('a slow A save completing after switching to B does not navigate back to A', async ({
    page,
  }) => {
    const { purchaseId: purchaseA } = await createFixturePurchase({
      cardVariantId: seedCatalog.pikachuVariantId,
    })
    const { purchaseId: purchaseB } = await createFixturePurchase({
      cardVariantId: seedCatalog.charizardVariantId,
    })

    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    const rpc = delayRpc(page, 'update_purchase')
    // The interception must be in place BEFORE the click: an unawaited page.route() is a latent race
    // (P147) — a request that overtakes it is not held, the save finishes at once and the
    // "Saving…" state these tests wait for is gone before it can be observed.
    await rpc.routePromise
    await page.getByLabel('Shipping').fill('77')
    await page.getByRole('button', { name: /save changes/i }).click()
    await rpc.expectHeld()
    await expect(page.getByRole('button', { name: /saving/i })).toBeVisible()

    // Switch away from A while its save is still in flight — the real regression trigger
    // (client-side SPA navigation, same mechanism as browser back/forward).
    await navigateWithinApp(page, `/purchases/${purchaseB}/edit`)
    await expect(page.getByText(/charizard/i).first()).toBeVisible({ timeout: 10_000 })

    // Now let A's save resolve successfully. Pre-fix, its unguarded onSuccess would call
    // navigate({ to: '/purchases/$purchaseId', params: { purchaseId: purchaseA } }) and yank the
    // user off B and onto A's detail page.
    rpc.release()
    await rpc.unroute()
    await page.waitForTimeout(500)

    await expect(page).toHaveURL(new RegExp(`/purchases/${purchaseB}/edit`))
    await expect(page.getByText(/charizard/i).first()).toBeVisible()
    await expect(page.getByText(/pikachu/i)).toHaveCount(0)

    // The edit still genuinely happened server-side (onSuccess's invalidation is unguarded by
    // design) — confirmed by loading A fresh and seeing the new shipping value.
    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByLabel('Shipping')).toHaveValue('77.00')
  })

  test('a slow A save failing after switching to B does not surface A error on B', async ({
    page,
  }) => {
    const { purchaseId: purchaseA } = await createFixturePurchase({
      cardVariantId: seedCatalog.pikachuVariantId,
    })
    const { purchaseId: purchaseB } = await createFixturePurchase({
      cardVariantId: seedCatalog.charizardVariantId,
    })

    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    const rpc = delayRpc(page, 'update_purchase')
    // The interception must be in place BEFORE the click: an unawaited page.route() is a latent race
    // (P147) — a request that overtakes it is not held, the save finishes at once and the
    // "Saving…" state these tests wait for is gone before it can be observed.
    await rpc.routePromise
    rpc.failWith(400, 'a purchase line has already been disposed elsewhere')
    await page.getByRole('button', { name: /save changes/i }).click()
    await rpc.expectHeld()
    await expect(page.getByRole('button', { name: /saving/i })).toBeVisible()

    await navigateWithinApp(page, `/purchases/${purchaseB}/edit`)
    await expect(page.getByText(/charizard/i).first()).toBeVisible({ timeout: 10_000 })

    // Pre-fix, A's unguarded onError would call setError on an instance no longer backing any
    // visible form — a harmless no-op react-wise, but this proves it never renders on B either.
    rpc.release()
    await rpc.unroute()
    await page.waitForTimeout(500)

    await expect(page).toHaveURL(new RegExp(`/purchases/${purchaseB}/edit`))
    await expect(page.getByText(/already been disposed/i)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('A -> B -> A: a fresh second A instance is never controlled by the first A save', async ({
    page,
  }) => {
    const { purchaseId: purchaseA } = await createFixturePurchase({
      cardVariantId: seedCatalog.pikachuVariantId,
    })
    const { purchaseId: purchaseB } = await createFixturePurchase({
      cardVariantId: seedCatalog.charizardVariantId,
    })

    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })

    const rpc = delayRpc(page, 'update_purchase')
    // The interception must be in place BEFORE the click: an unawaited page.route() is a latent race
    // (P147) — a request that overtakes it is not held, the save finishes at once and the
    // "Saving…" state these tests wait for is gone before it can be observed.
    await rpc.routePromise
    await page.getByLabel('Shipping').fill('55')
    await page.getByRole('button', { name: /save changes/i }).click()
    await rpc.expectHeld()

    await navigateWithinApp(page, `/purchases/${purchaseB}/edit`)
    await expect(page.getByText(/charizard/i).first()).toBeVisible({ timeout: 10_000 })

    // Back to A again BEFORE the first save resolves — this second A instance is a fresh mount
    // (key={purchaseId} forces it) with its own isMountedRef, unrelated to the first one's.
    await navigateWithinApp(page, `/purchases/${purchaseA}/edit`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })
    // The fresh mount reloads from the server — the first instance's locally-typed '55' (never
    // submitted from this instance's perspective) must not appear here.
    await expect(page.getByLabel('Shipping')).not.toHaveValue('55.00')

    rpc.release()
    await rpc.unroute()
    await page.waitForTimeout(500)

    // The first save's guarded onSuccess must not touch the second, current instance: still on
    // A's edit page, not force-navigated to A's detail page a second time.
    await expect(page).toHaveURL(new RegExp(`/purchases/${purchaseA}/edit`))
  })
})

test.describe('SaleEditPage — stale onSuccess/onError after an in-app entity switch (P124/P125)', () => {
  test('a slow A save completing after switching to B does not navigate back to A', async ({
    page,
  }) => {
    const { saleId: saleA } = await createFixtureSale()
    const { saleId: saleB } = await createFixtureSale()

    await page.goto(`/sales/${saleA}/edit`)
    await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible({
      timeout: 10_000,
    })

    const rpc = delayRpc(page, 'update_sale')
    // The interception must be in place BEFORE the click: an unawaited page.route() is a latent race
    // (P147) — a request that overtakes it is not held, the save finishes at once and the
    // "Saving…" state these tests wait for is gone before it can be observed.
    await rpc.routePromise
    const feesField = page.getByLabel('Fees')
    await feesField.fill('33')
    await page.getByRole('button', { name: /save changes/i }).click()
    await rpc.expectHeld()

    await navigateWithinApp(page, `/sales/${saleB}/edit`)
    await expect(page).toHaveURL(new RegExp(`/sales/${saleB}/edit`))

    rpc.release()
    await rpc.unroute()
    await page.waitForTimeout(500)

    // Pre-fix, A's unguarded onSuccess would navigate to /sales/$saleId for saleA, yanking the
    // user off B's edit page.
    await expect(page).toHaveURL(new RegExp(`/sales/${saleB}/edit`))
  })

  test('a slow A save failing after switching to B does not surface A error on B', async ({
    page,
  }) => {
    const { saleId: saleA } = await createFixtureSale()
    const { saleId: saleB } = await createFixtureSale()

    await page.goto(`/sales/${saleA}/edit`)
    await expect(page.getByRole('button', { name: /save changes/i })).toBeVisible({
      timeout: 10_000,
    })

    const rpc = delayRpc(page, 'update_sale')
    // The interception must be in place BEFORE the click: an unawaited page.route() is a latent race
    // (P147) — a request that overtakes it is not held, the save finishes at once and the
    // "Saving…" state these tests wait for is gone before it can be observed.
    await rpc.routePromise
    rpc.failWith(400, 'sale line quantity exceeds the original disposal')
    await page.getByRole('button', { name: /save changes/i }).click()
    await rpc.expectHeld()

    await navigateWithinApp(page, `/sales/${saleB}/edit`)
    await expect(page).toHaveURL(new RegExp(`/sales/${saleB}/edit`))

    rpc.release()
    await rpc.unroute()
    await page.waitForTimeout(500)

    await expect(page).toHaveURL(new RegExp(`/sales/${saleB}/edit`))
    await expect(page.getByText(/exceeds the original disposal/i)).toHaveCount(0)
  })
})
