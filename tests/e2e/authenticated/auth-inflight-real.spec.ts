import { test, expect, type Page } from '@playwright/test'
import { createServiceClient, seedCatalog, signInAs, type SyntheticUser } from '../../db/setup'
import {
  AUTH_STORAGE_KEY,
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
const FX_BODY = { ok: true, rate: '11.50000000', rateDate: '2026-09-01', source: 'norges_bank' }
const FX_URL = '**/functions/v1/fetch-fx-rate'
const MANUAL_CARD_URL = '**/rest/v1/manual_card_definitions*'
const REQ = {
  createPurchase: /\/rest\/v1\/rpc\/create_purchase/,
  updatePurchase: /\/rest\/v1\/rpc\/update_purchase/,
  createSale: /\/rest\/v1\/rpc\/create_sale/,
  updateSale: /\/rest\/v1\/rpc\/update_sale/,
  createOpening: /\/rest\/v1\/rpc\/create_opening/,
  profiles: new RegExp('/rest/v1/profiles'),
  exportLaterSections: new RegExp(
    '/rest/v1/(retailers|holdings|acquisition_lots|purchases|purchase_lines|sales|sale_lines|openings)',
  ),
  addAcquisition: /\/rest\/v1\/rpc\/add_card_acquisition/,
  resetPortfolio: /\/rest\/v1\/rpc\/reset_my_portfolio_data/,
}

const service = () => createServiceClient()
const today = () => new Date().toISOString().slice(0, 10)

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
  const { data, error } = await service()
    .from('purchases')
    .select('id')
    .eq('user_id', userId)
    .eq('notes', MARKER)
  expect(error).toBeNull()
  return data ?? []
}

async function fixturePurchase(user: SyntheticUser, notes?: string): Promise<string> {
  const client = await signInAs(user)
  const { data, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today(),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 5000,
        },
      ],
      p_notes: notes,
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`fixture purchase: ${error.message}`)
  return data.id
}

async function fixtureHolding(user: SyntheticUser): Promise<{ holdingId: string; lotId: string }> {
  const client = await signInAs(user)
  const { data, error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 2,
      p_acquired_on: today(),
      p_client_request_key: crypto.randomUUID(),
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (error) throw new Error(`fixture holding: ${error.message}`)
  return { holdingId: data.holding_id, lotId: data.lot_id }
}

async function fixtureSale(user: SyntheticUser, lotId: string): Promise<string> {
  const client = await signInAs(user)
  const { data, error } = await client
    .rpc('create_sale', {
      p_sold_on: today(),
      p_currency: 'NOK',
      p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: 8000 }],
      p_idempotency_key: crypto.randomUUID(),
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`fixture sale: ${error.message}`)
  return data.id
}

/** The browser-stored user id of the signed-in page (read for the test, never by the app). */
async function storedUserId(page: Page): Promise<string> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return (JSON.parse(raw ?? '{}') as { user: { id: string } }).user.id
  }, AUTH_STORAGE_KEY)
}

/** A fixed wait for the continuation to have had every chance to run (see the positive controls). */
const SETTLE_MS = 2_500

test.describe('P145 — in-flight PURCHASE CREATE across an identity change', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test('A -> B between the fx step and create_purchase: nothing is recorded in B (multi-step read-then-write)', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-fx')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, REQ.createPurchase)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    fx.release()
    await page.waitForTimeout(SETTLE_MS)

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
    const created = recordRequests(page, REQ.createPurchase)

    await armSessionLookupGate(page)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(SETTLE_MS)

    expect
      .soft(created.urls, 'create_purchase was requested after the identity changed')
      .toEqual([])
    expect(await markerPurchases(pair.b.id)).toEqual([])
    expect(await markerPurchases(pair.a.id)).toEqual([])
  })

  test('A -> B between manual-card creation and create_purchase: the definition stays A-only and no B purchase can reference it', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-manual')
    const cardName = `${MARKER}-manual-card`
    await signInThroughForm(page, pair.a)
    await page.goto('/purchases/new')
    await page.getByRole('button', { name: "Catalog doesn't have it" }).click()
    await page.getByLabel('Card name').fill(cardName)
    await page.getByLabel('Unit price').fill('10')
    await page.getByLabel('Notes').fill(MARKER)
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, REQ.createPurchase)
    // Step 1 (the manual-card definition) is HELD before it reaches the database; releasing it lets
    // the already-dispatched request complete as A, exactly the allowed outcome.
    const definition = await holdRequest(page, MANUAL_CARD_URL, 'POST')

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await definition.reached
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    definition.release()
    await page.waitForTimeout(SETTLE_MS)

    const cards = await service()
      .from('manual_card_definitions')
      .select('id, user_id')
      .eq('name', cardName)
    expect(cards.error).toBeNull()
    // The request that was already on its way completed as A; nothing was ever created for B.
    expect(cards.data).toEqual([{ id: expect.any(String), user_id: pair.a.id }])
    const cardId = (cards.data as { id: string }[])[0]?.id ?? ''
    // A purchase of a manual card lands as a holding that points at the definition: none exists.
    const holdings = await service()
      .from('holdings')
      .select('id, user_id')
      .eq('manual_card_id', cardId)
    expect(holdings.error).toBeNull()
    expect(holdings.data).toEqual([])
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

  test('same-user TOKEN_REFRESHED and USER_UPDATED while paused do NOT abort the submission', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-sameuser')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached
    await switchAndSettle(page, other, { kind: 'refresh' })
    await switchAndSettle(page, other, { kind: 'update-user' })
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.a })
    fx.release()

    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 15_000 })
    expect(await markerPurchases(pair.a.id)).toHaveLength(1)
    expect(await markerPurchases(pair.b.id)).toEqual([])
  })

  test('the other tab SIGNS OUT while the submission is paused: it stops, nothing is written afterwards', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-signout')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, REQ.createPurchase)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached
    await switchAndSettle(page, other, { kind: 'sign-out' })
    fx.release()
    await page.waitForTimeout(SETTLE_MS)

    await expect(page).toHaveURL(/\/login/)
    expect.soft(created.urls, 'create_purchase was requested after sign-out').toEqual([])
    expect(await markerPurchases(pair.a.id)).toEqual([])
    expect(await markerPurchases(pair.b.id)).toEqual([])
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), AUTH_STORAGE_KEY),
    ).toBeNull()
  })

  test('this tab SIGNS OUT itself while the submission is paused: it stops, nothing is written afterwards', async ({
    page,
  }) => {
    pair = await createPair('p145-selfsignout')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    const created = recordRequests(page, REQ.createPurchase)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached
    await page.getByRole('button', { name: 'Sign out' }).first().click()
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
    fx.release()
    await page.waitForTimeout(SETTLE_MS)

    expect.soft(created.urls, 'create_purchase was requested after sign-out').toEqual([])
    expect(await markerPurchases(pair.a.id)).toEqual([])
  })

  test('A -> B -> A while paused: the FIRST session’s submission is dead even though the bearer is A again', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-aba')
    await signInThroughForm(page, pair.a)
    await fillAccessoryPurchase(page, 'EUR')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, REQ.createPurchase)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await fx.reached
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.a })
    fx.release()
    await page.waitForTimeout(SETTLE_MS)

    expect.soft(created.urls, 'the old lease resurrected after A -> B -> A').toEqual([])
    expect(await markerPurchases(pair.a.id)).toEqual([])
    expect(await markerPurchases(pair.b.id)).toEqual([])
  })
})

test.describe('P145 — in-flight PURCHASE EDIT across an identity change', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test('A -> B between "click" and "bearer" of A’s purchase edit: no purchase of A or B is touched', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-pedit')
    const purchaseA = await fixturePurchase(pair.a)
    const purchaseB = await fixturePurchase(pair.b, 'B-untouched')
    await signInThroughForm(page, pair.a)
    await page.goto(`/purchases/${purchaseA}/edit`)
    await expect(page.getByLabel('Shipping')).toBeVisible({ timeout: 15_000 })
    await page.getByLabel('Notes').fill(MARKER)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const updated = recordRequests(page, REQ.updatePurchase)

    await armSessionLookupGate(page)
    await page.getByRole('button', { name: 'Save changes' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(SETTLE_MS)

    expect
      .soft(updated.urls, 'update_purchase was requested after the identity changed')
      .toEqual([])
    const rows = await service()
      .from('purchases')
      .select('id, notes')
      .in('id', [purchaseA, purchaseB])
    const notes = new Map(
      ((rows.data ?? []) as { id: string; notes: string | null }[]).map((r) => [r.id, r.notes]),
    )
    expect(notes.get(purchaseA) ?? null).not.toBe(MARKER)
    expect(notes.get(purchaseB)).toBe('B-untouched')
  })
})

test.describe('P145 — in-flight SALE CREATE / EDIT across an identity change', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  async function fillSale(page: Page, holdingId: string): Promise<void> {
    await page.goto(`/sales/new?holdingId=${holdingId}`)
    await page.getByLabel(/Quantity of .* from the lot acquired/).fill('1', { timeout: 20_000 })
    await page.getByLabel('Sale price per unit').fill('80')
    await page.getByLabel('Currency').selectOption('EUR')
    await page.getByLabel('Notes').fill(MARKER)
  }

  test('A -> B between the fx step and create_sale: no sale for B, A’s lot is not disposed, B’s stock is untouched', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-sale')
    const holdingA = await fixtureHolding(pair.a)
    const holdingB = await fixtureHolding(pair.b)
    await signInThroughForm(page, pair.a)
    await fillSale(page, holdingA.holdingId)
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, REQ.createSale)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save sale' }).click()
    await fx.reached
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    fx.release()
    await page.waitForTimeout(SETTLE_MS)

    expect.soft(created.urls, 'create_sale was requested after the identity changed').toEqual([])
    const sales = await service().from('sales').select('id, user_id').eq('notes', MARKER)
    expect(sales.data).toEqual([])
    const lots = await service()
      .from('acquisition_lots')
      .select('id, quantity_remaining')
      .in('id', [holdingA.lotId, holdingB.lotId])
    const remaining = new Map(
      ((lots.data ?? []) as { id: string; quantity_remaining: number }[]).map((l) => [
        l.id,
        l.quantity_remaining,
      ]),
    )
    expect(remaining.get(holdingA.lotId)).toBe(2)
    expect(remaining.get(holdingB.lotId)).toBe(2)
  })

  test('positive control: with no identity change the same sale is recorded for A, in ONE request', async ({
    page,
  }) => {
    pair = await createPair('p145-salectl')
    const holdingA = await fixtureHolding(pair.a)
    await signInThroughForm(page, pair.a)
    await fillSale(page, holdingA.holdingId)
    const created = recordRequests(page, REQ.createSale)
    const fx = await holdRequest(page, FX_URL, 'POST', { status: 200, body: FX_BODY })

    await page.getByRole('button', { name: 'Save sale' }).click()
    await fx.reached
    fx.release()

    await page.waitForURL(/\/sales\/[0-9a-f-]{36}/, { timeout: 15_000 })
    expect(created.urls).toHaveLength(1)
    const sales = await service().from('sales').select('id, user_id').eq('notes', MARKER)
    expect(sales.data).toEqual([{ id: expect.any(String), user_id: pair.a.id }])
  })

  test('A -> B between "click" and "bearer" of A’s sale edit: nothing is updated', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-saleedit')
    const holdingA = await fixtureHolding(pair.a)
    const saleA = await fixtureSale(pair.a, holdingA.lotId)
    await signInThroughForm(page, pair.a)
    await page.goto(`/sales/${saleA}/edit`)
    await expect(page.getByLabel('Notes')).toBeVisible({ timeout: 15_000 })
    await page.getByLabel('Notes').fill(MARKER)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const updated = recordRequests(page, REQ.updateSale)

    await armSessionLookupGate(page)
    await page.getByRole('button', { name: 'Save changes' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(SETTLE_MS)

    expect.soft(updated.urls, 'update_sale was requested after the identity changed').toEqual([])
    const row = await service().from('sales').select('notes').eq('id', saleA).single()
    expect(row.data?.notes ?? null).not.toBe(MARKER)
  })
})

test.describe('P145 — in-flight OPENING across an identity change', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  /** Builds the wizard's review-step draft with the app's own reducer, exactly as typing would. */
  async function preloadOpeningDraft(page: Page, cardName: string): Promise<void> {
    const userId = await storedUserId(page)
    await page.evaluate(
      async ([id, sealedProductId, name]) => {
        const draftPath = '/src/features/openings/draft.ts'
        const { draftStore, initialDraft, reduceDraft } = (await import(
          /* @vite-ignore */ draftPath
        )) as {
          draftStore: { save: (userId: string, draft: unknown) => void }
          initialDraft: () => unknown
          reduceDraft: (state: unknown, action: unknown) => unknown
        }
        let draft = initialDraft()
        const steps: unknown[] = [
          { type: 'SET_MODE', mode: 'bought_now' },
          { type: 'SELECT_PRODUCT', productId: sealedProductId, productName: 'P145 sealed' },
          { type: 'SET_TOTAL_PAID_INPUT', value: '299' },
          {
            type: 'ADD_PULL',
            pull: {
              cardVariantId: null,
              manualCardId: null,
              manualIdentity: { name },
              displayName: name,
              subtitle: null,
              imageBaseUrl: null,
              finishLabel: null,
              condition: 'NM',
            },
            quantity: 1,
            makeKey: () => 'p145-pull',
          },
          { type: 'GO_TO_STEP', step: 'review' },
        ]
        for (const action of steps) draft = reduceDraft(draft, action)
        draftStore.save(id, draft)
      },
      [userId, seedCatalog.sealedProductId, cardName] as [string, string, string],
    )
    await page.evaluate(() => {
      window.history.pushState({}, '', '/openings/new')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByRole('button', { name: 'Finish opening' })).toBeVisible({
      timeout: 20_000,
    })
  }

  test('A -> B between manual-card creation and the opening: A’s pull is A-only, B receives no purchase and no opening', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-opening')
    const cardName = `${MARKER}-pulled-card`
    await signInThroughForm(page, pair.a)
    await page.goto('/privacy')
    await preloadOpeningDraft(page, cardName)
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, REQ.createOpening)
    const definition = await holdRequest(page, MANUAL_CARD_URL, 'POST')

    await page.getByRole('button', { name: 'Finish opening' }).click()
    await definition.reached
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    definition.release()
    await page.waitForTimeout(SETTLE_MS)

    expect.soft(created.urls, 'an opening was requested after the identity changed').toEqual([])
    const cards = await service()
      .from('manual_card_definitions')
      .select('user_id')
      .eq('name', cardName)
    expect(cards.data).toEqual([{ user_id: pair.a.id }])
    const openingsB = await service().from('openings').select('id').eq('user_id', pair.b.id)
    expect(openingsB.data).toEqual([])
    const purchasesB = await service().from('purchases').select('id').eq('user_id', pair.b.id)
    expect(purchasesB.data).toEqual([])
    const openingsA = await service().from('openings').select('id').eq('user_id', pair.a.id)
    expect(openingsA.data).toEqual([])
  })
})

test.describe('P145 — the other user-typed writes', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test('profile: a display name typed under A is never saved into B’s profile', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-profile')
    await signInThroughForm(page, pair.a)
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Add a display name' }).click()
    await page.getByLabel('Display name').fill(MARKER)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const written = recordRequests(page, REQ.profiles, 'PATCH')

    await armSessionLookupGate(page)
    await page
      .locator('form', { has: page.getByLabel('Display name') })
      .getByRole('button', { name: 'Save' })
      .click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(SETTLE_MS)

    expect
      .soft(written.urls, 'a profile write was requested after the identity changed')
      .toEqual([])
    const profiles = await service()
      .from('profiles')
      .select('id, display_name')
      .in('id', [pair.a.id, pair.b.id])
    const names = new Map(
      ((profiles.data ?? []) as { id: string; display_name: string | null }[]).map((p) => [
        p.id,
        p.display_name,
      ]),
    )
    expect(names.get(pair.b.id) ?? null).toBeNull()
    expect(names.get(pair.a.id) ?? null).toBeNull()
  })

  test('reset: A’s confirmation of "reset my portfolio data" never wipes B’s portfolio', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-reset')
    const purchaseA = await fixturePurchase(pair.a)
    const purchaseB = await fixturePurchase(pair.b)
    await signInThroughForm(page, pair.a)
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Reset portfolio data' }).click()
    await expect(page.getByRole('button', { name: 'Yes, reset portfolio' })).toBeVisible()
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const reset = recordRequests(page, REQ.resetPortfolio)

    await armSessionLookupGate(page)
    await page.getByRole('button', { name: 'Yes, reset portfolio' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(SETTLE_MS)

    expect
      .soft(reset.urls, 'reset_my_portfolio_data was requested after the identity changed')
      .toEqual([])
    const survivors = await service()
      .from('purchases')
      .select('id, user_id')
      .in('id', [purchaseA, purchaseB])
    const alive = new Set((survivors.data ?? []).map((p) => String(p.id)))
    expect.soft(alive.has(purchaseB), 'the purchase of B was deleted by the reset of A').toBe(true)
    expect(alive.has(purchaseA)).toBe(true)
  })

  test('export: a file being assembled for A is never continued under B (many sequential reads)', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-export')
    await fixturePurchase(pair.a)
    await fixturePurchase(pair.b)
    await signInThroughForm(page, pair.a)
    await page.goto('/profile/export')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)
    const later = recordRequests(page, REQ.exportLaterSections)
    // The export reads roughly twenty sections one after another; hold the third.
    const section = await holdRequest(page, '**/rest/v1/custom_collection_members*', 'GET')

    await page.getByRole('button', { name: 'Prepare CSV export' }).click()
    await section.reached
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    section.release()
    await page.waitForTimeout(SETTLE_MS)

    expect.soft(later.urls, 'export sections were requested after the identity changed').toEqual([])
    // B's remounted page shows nothing of A's export, no error text, no ready file.
    await expect(page.getByRole('button', { name: 'Prepare CSV export' })).toBeVisible()
    await expect(page.getByText(/ready|failed|went wrong/i)).toHaveCount(0)
  })

  test('add to collection: A’s typed acquisition is never recorded for B', async ({
    context,
    page,
  }) => {
    pair = await createPair('p145-add')
    await signInThroughForm(page, pair.a)
    await page.goto(`/add?variantId=${seedCatalog.pikachuVariantId}`)
    await expect(page.getByLabel('Quantity')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Existing collection' }).click()
    await page.getByLabel('Notes').fill(MARKER)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const added = recordRequests(page, REQ.addAcquisition)

    await armSessionLookupGate(page)
    await page.getByRole('button', { name: 'Add to collection' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    await page.waitForTimeout(SETTLE_MS)

    expect
      .soft(added.urls, 'add_card_acquisition was requested after the identity changed')
      .toEqual([])
    const holdings = await service().from('holdings').select('id, user_id').eq('notes', MARKER)
    expect(holdings.data).toEqual([])
  })
})
