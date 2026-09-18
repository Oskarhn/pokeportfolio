import { test, expect, type Page } from '@playwright/test'
import { createServiceClient } from '../../db/setup'
import {
  armBroadcastCounter,
  armSessionLookupGate,
  createPair,
  deletePair,
  holdRequest,
  installSessionLookupGate,
  openOtherTab,
  recordRequests,
  releaseSessionLookupGate,
  signInThroughForm,
  switchAndSettle,
  waitForSessionLookupParked,
  type Pair,
} from './support/two-tab'

/**
 * P145 — the IN-FLIGHT class of P130-23 (P143 warning W1): a multi-step submission that already
 * started under user A must never continue user-scoped side effects under user B.
 *
 * P143 closed the STALE-MOUNTED-FORM class (the React subtree is remounted when the identity
 * changes). A remount cannot cancel an async continuation, so a mutation that was already running
 * kept going, and every later step read the CURRENT session — B's. These tests pause a REAL
 * submission between its steps, switch the shared browser identity from another tab, release the
 * pause and look at what reached the database, using the service role as the independent witness.
 *
 * Two independent ways of pausing, so the guarded window is named precisely:
 *   - a request held at the network layer (`holdRequest`): the step's request was ALREADY
 *     dispatched with its caller's bearer token; the NEXT step has not started yet;
 *   - a parked session lookup (`installSessionLookupGate`): the mutation has started but Supabase
 *     has not yet chosen the bearer token for its next request — the check-to-dispatch window.
 *
 * Every test signs in its OWN disposable users through the real login form (a sign-out is GLOBAL
 * scope and would revoke the shared e2e session for every other spec — P112).
 */

test.use({ storageState: { cookies: [], origins: [] } })

const MARKER = 'A-ONLY-p145-inflight-marker'
const FX_BODY = {
  ok: true,
  rate: '11.50000000',
  rateDate: '2026-09-01',
  source: 'norges_bank',
}
const FX_URL = '**/functions/v1/fetch-fx-rate'
const CREATE_PURCHASE_REQUEST = /\/rest\/v1\/rpc\/create_purchase/

/** A purchase made of one spend-only line: nothing in it refers to a row of A's. */
async function fillAccessoryPurchase(page: Page, currency: 'NOK' | 'EUR'): Promise<void> {
  await page.goto('/purchases/new')
  await expect(page.getByLabel('Shipping')).toBeVisible()
  if (currency !== 'NOK') await page.getByLabel('Currency').selectOption(currency)
  await page.getByLabel('Type').first().selectOption('accessory')
  await page.getByLabel('Description').fill(MARKER)
  await page.getByLabel('Unit price').fill('12')
  await page.getByLabel('Notes').fill(MARKER)
}

async function markerPurchases(userId: string): Promise<{ id: string }[]> {
  const { data, error } = await createServiceClient()
    .from('purchases')
    .select('id')
    .eq('user_id', userId)
    .eq('notes', MARKER)
  expect(error).toBeNull()
  return data ?? []
}

test.describe('P145 — in-flight purchase submission across an identity change', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test('A -> B between the fx step and create_purchase: nothing is recorded in B (multi-step)', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-fx')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, CREATE_PURCHASE_REQUEST)
    // Step 1 of the submit is the exchange-rate lookup; hold it at the network layer.
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    fx.release()
    // Give the continuation every chance to run: a positive control below proves how quickly the
    // final request follows the last step when nothing interferes.
    await page.waitForTimeout(2_500)

    expect
      .soft(created.urls, 'create_purchase was requested after the identity changed')
      .toEqual([])
    expect(await markerPurchases(pair.b.id)).toEqual([])
    expect(await markerPurchases(pair.a.id)).toEqual([])
    await expect(page.getByText(MARKER)).toHaveCount(0)
  })

  test('A -> B while the session lookup for the FIRST request is parked: nothing is recorded in B (check-to-dispatch window)', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-gate')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'NOK')
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, CREATE_PURCHASE_REQUEST)

    await armSessionLookupGate(page)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await waitForSessionLookupParked(page)

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(2_500)

    expect
      .soft(created.urls, 'create_purchase was requested after the identity changed')
      .toEqual([])
    expect(await markerPurchases(pair.b.id)).toEqual([])
    expect(await markerPurchases(pair.a.id)).toEqual([])
  })

  test('positive control: with no identity change the same submission is recorded for A', async ({
    page,
  }) => {
    pair = await createPair('p145-control')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached
    fx.release()

    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 15_000 })
    expect(await markerPurchases(pair.a.id)).toHaveLength(1)
    expect(await markerPurchases(pair.b.id)).toEqual([])
  })
})
