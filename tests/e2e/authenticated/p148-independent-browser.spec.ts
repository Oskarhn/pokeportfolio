import { expect, test, type Page } from '@playwright/test'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
} from '../../db/setup'
import {
  AUTH_STORAGE_KEY,
  armBroadcastCounter,
  armSessionLookupGate,
  createPair,
  deletePair,
  openOtherTab,
  recordRequests,
  releaseSessionLookupGate,
  signInThroughForm,
  switchAndSettle,
  waitForSessionLookupParked,
  installSessionLookupGate,
  type Pair,
} from './support/two-tab'

/**
 * P148 - independent browser verification of the integrated candidate (real Chromium, real local
 * GoTrue/PostgREST/PostgreSQL, the app's own Vite dev server).
 *
 * What this adds to the P143/P145/P146/P147 browser specs:
 *   - BOTH invariants in one browser run: every identity scenario here types an amount a JavaScript
 *     number cannot hold (2^53+1 minor units) into the real purchase form;
 *   - a sign-out (not only a user switch) while the operation is parked, and a same-user token
 *     refresh, each with that amount;
 *   - a mobile-width audit of every page that renders a large money value.
 * The witness is the service role reading `col::text`, never the page.
 */

test.use({ storageState: { cookies: [], origins: [] } })

const TYPED = '90071992547409,93' // 2^53 + 1 minor units of NOK
const EXACT_MINOR = '9007199254740993'
const EXACT_DISPLAY = /90\s071\s992\s547\s409,93/
const MARKER = 'p148-A-only-marker'
const service = () => createServiceClient()
const today = () => new Date().toISOString().slice(0, 10)

async function fillLargePurchase(page: Page, note: string): Promise<void> {
  await page.goto('/purchases/new')
  await expect(page.getByLabel('Shipping')).toBeVisible()
  await page.getByLabel('Type').first().selectOption('accessory')
  await page.getByLabel('Description').fill('p148 large')
  await page.getByLabel('Unit price').fill(TYPED)
  await page.getByLabel('Notes').fill(note)
}

async function purchasesWithNote(note: string) {
  const { data, error } = await service()
    .from('purchases')
    .select('id, user_id, total_minor::text')
    .eq('notes', note)
  expect(error).toBeNull()
  return (data ?? []) as unknown as { id: string; user_id: string; total_minor: string }[]
}

test.describe('large exact amount x identity events, in the real browser', () => {
  let pair: Pair | null = null
  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test('positive control: the amount is sent as text and stored exactly under A', async ({
    page,
  }) => {
    pair = await createPair('p148-pos')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-control-${Date.now()}`
    await fillLargePurchase(page, note)
    const created = recordRequests(page, /\/rest\/v1\/rpc\/create_purchase/)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 15_000 })
    const rows = await purchasesWithNote(note)
    expect(rows.map((r) => [r.user_id, r.total_minor])).toEqual([[pair.a.id, EXACT_MINOR]])
    expect(created.urls).toHaveLength(1)
    await expect(page.getByText(EXACT_DISPLAY).first()).toBeVisible()
  })

  test("A -> B while the credential lookup is parked: no request, no row for A or B, A's amount not on B's screen", async ({
    context,
    page,
  }) => {
    pair = await createPair('p148-a2b')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-a2b-${Date.now()}`
    await fillLargePurchase(page, note)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, /\/rest\/v1\/rpc\/create_purchase/)
    await armSessionLookupGate(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await releaseSessionLookupGate(page)
    // wait for the outcome to be observable instead of sleeping: the screen belongs to B now
    await expect(page.getByLabel('Notes')).not.toHaveValue(note, { timeout: 10_000 })

    expect(created.urls).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])
    await expect(page.getByText(EXACT_DISPLAY)).toHaveCount(0)
    await expect(page.getByText(note)).toHaveCount(0)
    // B, on the same screen, can still do a normal purchase of its own
    await page.getByLabel('Type').first().selectOption('accessory')
    await page.getByLabel('Description').fill('p148 B own')
    await page.getByLabel('Unit price').fill('12')
    const noteB = `${MARKER}-b-own-${Date.now()}`
    await page.getByLabel('Notes').fill(noteB)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 15_000 })
    expect((await purchasesWithNote(noteB)).map((r) => r.user_id)).toEqual([pair.b.id])
  })

  test('sign-out in another tab while parked: no request, no row, and the sign-in form is shown', async ({
    context,
    page,
  }) => {
    pair = await createPair('p148-out')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-out-${Date.now()}`
    await fillLargePurchase(page, note)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, /\/rest\/v1\/rpc\/create_purchase/)
    await armSessionLookupGate(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-out' })
    await releaseSessionLookupGate(page)
    await page.waitForURL(/\/login/, { timeout: 15_000 })

    expect(created.urls).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), AUTH_STORAGE_KEY)
    expect(stored).toBeNull()
  })

  test('same-user REAL token refresh in another tab while parked: completes, as A, with the exact amount', async ({
    context,
    page,
  }) => {
    pair = await createPair('p148-refresh')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-refresh-${Date.now()}`
    await fillLargePurchase(page, note)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    await armSessionLookupGate(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'refresh' })
    await releaseSessionLookupGate(page)
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 15_000 })

    const rows = await purchasesWithNote(note)
    expect(rows.map((r) => [r.user_id, r.total_minor])).toEqual([[pair.a.id, EXACT_MINOR]])
  })

  test('A -> B -> A while parked: the original operation stays dead (no request, no row)', async ({
    context,
    page,
  }) => {
    pair = await createPair('p148-aba')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-aba-${Date.now()}`
    await fillLargePurchase(page, note)
    await armBroadcastCounter(page)
    await installSessionLookupGate(page)
    const other = await openOtherTab(context)
    const created = recordRequests(page, /\/rest\/v1\/rpc\/create_purchase/)
    await armSessionLookupGate(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await waitForSessionLookupParked(page)
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.a })
    await releaseSessionLookupGate(page)
    await expect(page.getByLabel('Notes')).not.toHaveValue(note, { timeout: 10_000 })

    expect(created.urls).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])
  })
})

/* ------------------------------------------------------------------------------------------------ */

const BIG_CARD = '4611686018427400249' // 2^62 + 12345
const BIG_SHIP = '1234567890123456'
const BIG_GROSS = '9007199254740993'
const BIG_FEES = '4611686018427400249'

interface Seeded {
  purchaseId: string
  holdingId: string
  saleIds: string[]
}

async function seedLargeLedger(user: SyntheticUser): Promise<Seeded> {
  const client = await signInAs(user)
  const purchase = await client
    .rpc('create_purchase', {
      p_purchased_on: today(),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: BIG_CARD,
        },
      ],
      p_shipping_minor: BIG_SHIP,
      p_notes: 'p148 big purchase',
      p_idempotency_key: crypto.randomUUID(),
    } as never)
    .select('id')
    .single<{ id: string }>()
  if (purchase.error) throw new Error(`seed purchase: ${purchase.error.message}`)

  const { data: lines } = await service()
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.data.id)
  const { data: lots } = await service()
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('purchase_line_id', (lines as { id: string }[])[0]!.id)
  const costed = (lots as { id: string; holding_id: string }[])[0]!

  const unknown = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today(),
      p_client_request_key: crypto.randomUUID(),
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (unknown.error) throw new Error(`seed lot: ${unknown.error.message}`)

  const saleIds: string[] = []
  for (const [lotId, gross, fees] of [
    [costed.id, BIG_GROSS, '100'],
    [unknown.data.lot_id, '100', BIG_FEES], // unknown basis, negative net above 2^62
  ] as const) {
    const sale = await client
      .rpc('create_sale', {
        p_sold_on: today(),
        p_currency: 'NOK',
        p_lines: [{ lot_id: lotId, quantity: 1, unit_gross_minor: gross }],
        p_fees_minor: fees,
        p_idempotency_key: crypto.randomUUID(),
      } as never)
      .select('id')
      .single<{ id: string }>()
    if (sale.error) throw new Error(`seed sale: ${sale.error.message}`)
    saleIds.push(sale.data.id)
  }
  // a second, still-open holding with a huge manual value
  const open = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_grading_state: 'graded',
      p_grader: 'psa',
      p_grade: 10,
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: BIG_GROSS,
      p_manual_value_minor: BIG_GROSS, // 2^53+1: a tile value; see the P148 finding on 2^62-scale tiles (recorded, not fixed)
      p_quantity: 1,
      p_acquired_on: today(),
      p_client_request_key: crypto.randomUUID(),
    } as never)
    .single<{ holding_id: string; lot_id: string }>()
  if (open.error) throw new Error(`seed open lot: ${open.error.message}`)
  return { purchaseId: purchase.data.id, holdingId: open.data.holding_id, saleIds }
}

interface Overflow {
  route: string
  scrollWidth: number
  clientWidth: number
  offenders: string[]
}

async function measure(page: Page, route: string): Promise<Overflow> {
  await page.goto(route)
  await page.waitForLoadState('networkidle')
  return page.evaluate((r) => {
    const root = document.documentElement
    const vw = root.clientWidth
    const offenders: string[] = []
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const box = el.getBoundingClientRect()
      if (box.width > 0 && box.right > vw + 0.5) {
        const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 50)
        offenders.push(
          `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + (el.className.split(' ')[0] ?? '') : ''} right=${Math.round(box.right)} "${text}"`,
        )
        if (offenders.length >= 4) break
      }
    }
    return { route: r, scrollWidth: root.scrollWidth, clientWidth: vw, offenders }
  }, route)
}

test.describe('mobile width: pages that render a large money value', () => {
  let owner: SyntheticUser
  let seeded: Seeded

  test.beforeAll(async () => {
    owner = await createSyntheticUser(createServiceClient(), 'p148-mobile')
    seeded = await seedLargeLedger(owner)
  })
  test.afterAll(async () => {
    await deleteSyntheticUser(createServiceClient(), owner.id)
  })

  for (const width of [390, 430]) {
    test(`no horizontal overflow at ${String(width)}px on any page that shows 2^53 to 2^62 scale amounts`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 })
      await signInThroughForm(page, owner)
      const routes = [
        '/',
        '/purchases',
        `/purchases/${seeded.purchaseId}`,
        `/purchases/${seeded.purchaseId}/edit`,
        '/sales',
        `/sales/${seeded.saleIds[0]!}`,
        `/sales/${seeded.saleIds[1]!}`,
        '/portfolio',
        `/portfolio/${seeded.holdingId}`,
        '/history',
        '/profile',
      ]
      const report: Overflow[] = []
      for (const route of routes) report.push(await measure(page, route))
      const bad = report.filter((r) => r.scrollWidth > r.clientWidth)
      test.info().annotations.push({ type: 'overflow-report', description: JSON.stringify(bad) })
      expect(bad, JSON.stringify(bad, null, 1)).toEqual([])
    })
  }
})

/* ------------------------------------------------------------------------------------------------ */

test.describe('sale with UNKNOWN basis and NEGATIVE net proceeds, through the real form', () => {
  let owner: SyntheticUser
  test.beforeAll(async () => {
    owner = await createSyntheticUser(createServiceClient(), 'p148-negsale')
  })
  test.afterAll(async () => {
    await deleteSyntheticUser(createServiceClient(), owner.id)
  })

  test('is recorded with its sign, realized stays unknown (NULL, not 0); a blank price is refused, an explicit 0 is a known zero', async ({
    page,
  }) => {
    const client = await signInAs(owner)
    const lot = await client
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.grassEnergyVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 2,
        p_acquired_on: today(),
        p_client_request_key: crypto.randomUUID(),
      })
      .single<{ holding_id: string; lot_id: string }>()
    if (lot.error) throw new Error(lot.error.message)

    await signInThroughForm(page, owner)
    const calls = recordRequests(page, /\/rest\/v1\/rpc\/create_sale/)
    await page.goto(`/sales/new?holdingId=${lot.data.holding_id}`)
    await page
      .getByLabel(/^Quantity of .* from the lot acquired/)
      .first()
      .fill('1')

    // blank price: nothing is sent
    await page.getByLabel('Sale price per unit').fill('')
    await page.getByRole('button', { name: 'Save sale' }).click()
    expect(calls.urls).toHaveLength(0)

    // price 10, fees 25: net proceeds -15,00 on a lot whose cost is unknown
    await page.getByLabel('Sale price per unit').fill('10')
    await page.getByLabel('Fees').fill('25')
    await page.getByRole('button', { name: 'Save sale' }).click()
    await page.waitForURL(/\/sales\/[0-9a-f-]{36}/, { timeout: 15_000 })
    expect(calls.urls).toHaveLength(1)

    const { data } = await createServiceClient()
      .from('sales')
      .select(
        'gross_minor::text, fees_minor::text, net_proceeds_minor::text, ' +
          'proceeds_from_uncosted_nok_minor::text, realized_result_nok_minor::text',
      )
      .eq('user_id', owner.id)
      .single()
    expect(data).toEqual({
      gross_minor: '1000',
      fees_minor: '2500',
      net_proceeds_minor: '-1500',
      proceeds_from_uncosted_nok_minor: '-1500',
      realized_result_nok_minor: null,
    })
    // the page shows the loss with its sign and does not invent a realized result of 0
    const body = page.locator('body')
    await expect(body).toContainText(/Net proceeds\s*-15\.00 NOK/)
    await expect(body).toContainText('Cost basis unavailable — proceeds only, not a profit.')
    await expect(body).toContainText(/Cost basis\s*—\s*Result\s*—/)

    // an explicit 0 on the remaining unit is a KNOWN zero: recorded, gross 0
    await page.goto(`/sales/new?holdingId=${lot.data.holding_id}`)
    await page
      .getByLabel(/^Quantity of .* from the lot acquired/)
      .first()
      .fill('1')
    await page.getByLabel('Sale price per unit').fill('0')
    await page.getByRole('button', { name: 'Save sale' }).click()
    await page.waitForURL(/\/sales\/[0-9a-f-]{36}/, { timeout: 15_000 })
    const { data: rows } = await createServiceClient()
      .from('sales')
      .select('gross_minor::text')
      .eq('user_id', owner.id)
      .order('created_at')
    expect((rows as unknown as { gross_minor: string }[]).map((r) => r.gross_minor)).toEqual([
      '1000',
      '0',
    ])
  })
})
