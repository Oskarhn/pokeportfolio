import { fileURLToPath } from 'node:url'
import { test, expect, type Page, type Route } from '@playwright/test'
import type { Client as PgClient } from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'

/**
 * P153 — the ledger non-mutation proof. Price Check must be unable to change anything a person
 * owns, and "the page never navigated to Add Card" is not evidence of that. This spec proves it
 * at the DATABASE:
 *
 *   1. a synthetic account is given a known ledger through the real RPCs (holdings, lots,
 *      purchases, purchase lines, sales, sale lines, disposals, an opening…);
 *   2. a baseline is recorded straight from Postgres: for EVERY public table that has a `user_id`
 *      column (discovered from `information_schema`, not from a list this file maintains), the
 *      row count and an md5 over every row's full text, plus the account's own portfolio
 *      aggregate as the app computes it;
 *   3. the real signed-in UI is driven through repeated Price Check searches, price lookups,
 *      variant switches, scans (real on-device scanner over a synthetic photo) and a click into
 *      the Add page — against the real local catalog, real RLS and real Auth;
 *   4. the snapshot is taken again and must be byte-for-byte identical, and the browser's request
 *      log must contain no write.
 *
 * Only the provider price lookup (`search-prices` — no provider exists on a laptop) is answered by
 * the test, with synthetic observations. Everything else is the real local stack.
 *
 * Local stack ONLY: the spec refuses to run against anything but a loopback Supabase URL.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const SCAN_IMAGE = fileURLToPath(
  new URL('../../fixtures/scanner/synthetic-card-modern.png', import.meta.url),
)

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const DB_URL = process.env.P153_DB_URL ?? ''

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}

/** The synthetic scan fixture reads "FAUXOSAUR EX 049/197". A catalog card with that identity (and
 *  two variants) is added to the LOCAL catalog so a real scan finds a real candidate and the confirm
 *  path is genuinely exercised. Catalog data, not user data; removed again afterwards. */
const FAUX = {
  cardId: 'c0000000-0000-0000-0000-000000000f01',
  variantIds: ['c0000000-0000-0000-0000-0000000af011', 'c0000000-0000-0000-0000-0000000af012'],
}

interface Snapshot {
  tables: Record<string, { rows: number; hash: string }>
  portfolioCounts: unknown
}

let pgClient: PgClient
let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let ledgerIdsA: string[] = []

function assertLocalStack(): void {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(SUPABASE_URL)) {
    throw new Error(
      `Refusing to run: SUPABASE_URL must be a loopback local stack, got ${SUPABASE_URL || '(unset)'}`,
    )
  }
  if (!/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) {
    throw new Error('Refusing to run: P153_DB_URL must be a loopback local database')
  }
}

/** A known ledger, built only through the real production RPCs. Returns every row id it created. */
async function buildLedger(client: TestClient): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10)
  const ids: string[] = []
  for (const variant of [seedCatalog.pikachuVariantId, seedCatalog.charizardVariantId]) {
    const { data, error } = await client
      .rpc('add_card_acquisition', {
        p_card_variant_id: variant,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 2,
        p_acquired_on: today,
        p_client_request_key: crypto.randomUUID(),
      })
      .single<{ holding_id: string; lot_id: string }>()
    if (error) throw new Error(`ledger: add_card_acquisition failed: ${error.message}`)
    ids.push(data.holding_id, data.lot_id)
  }
  const purchase = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 3,
          unit_price_minor: 4321,
        },
      ],
    })
    .select('id')
    .single<{ id: string }>()
  if (purchase.error) throw new Error(`ledger: create_purchase failed: ${purchase.error.message}`)
  ids.push(purchase.data.id)

  const sold = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
      p_client_request_key: crypto.randomUUID(),
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (sold.error) throw new Error(`ledger: sale lot failed: ${sold.error.message}`)
  const sale = await client
    .rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: sold.data.lot_id, quantity: 1, unit_gross_minor: 8000 }],
      p_idempotency_key: crypto.randomUUID(),
    })
    .select('id')
    .single<{ id: string }>()
  if (sale.error) throw new Error(`ledger: create_sale failed: ${sale.error.message}`)
  ids.push(sold.data.holding_id, sold.data.lot_id, sale.data.id)

  const opening = await client
    .rpc('create_opening_from_provisional', {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_total_paid_minor: 29900,
      p_purchased_on: today,
      p_opened_on: today,
      p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
    })
    .single<{ id: string }>()
  if (opening.error) throw new Error(`ledger: opening failed: ${opening.error.message}`)
  ids.push(opening.data.id)
  return ids
}

/** The ledger triggers enqueue a portfolio recompute that a pg_cron worker later drains into
 *  `portfolio_snapshots` (m12). That is derived bookkeeping, written by the scheduler, not by any
 *  page — so it is drained NOW, before each baseline, leaving nothing for the scheduler to change
 *  mid-test while every table (including those two) is still compared strictly. */
async function settleDerivedTables(): Promise<void> {
  const { error } = await service.rpc('drain_portfolio_recompute_queue', { p_batch_users: 100 })
  if (error) throw new Error(`drain_portfolio_recompute_queue failed: ${error.message}`)
}

/** Every user-owned table, discovered from the catalog: count + md5 of every row's full text. */
async function snapshot(userId: string, client: TestClient): Promise<Snapshot> {
  const tableRows = await pgClient.query<{ table_name: string }>(
    `select c.table_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE'
      order by c.table_name`,
  )
  const tables: Snapshot['tables'] = {}
  for (const { table_name } of tableRows.rows) {
    const result = await pgClient.query<{ n: number; h: string }>(
      `select count(*)::int as n,
              coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h
         from public.${pgClient.escapeIdentifier(table_name)} t
        where t.user_id = $1`,
      [userId],
    )
    tables[table_name] = { rows: result.rows[0]?.n ?? 0, hash: result.rows[0]?.h ?? '' }
  }
  const counts = await client.rpc('portfolio_counts', { p_custom_collection_id: null })
  if (counts.error) throw new Error(`portfolio_counts failed: ${counts.error.message}`)
  return { tables, portfolioCounts: counts.data }
}

const LEDGER_TABLES = [
  'holdings',
  'acquisition_lots',
  'purchases',
  'purchase_lines',
  'sales',
  'sale_lines',
  'lot_disposals',
  'openings',
]

/** Rows in the tables that make up a person's portfolio and finances. */
function ledgerRows(s: Snapshot): number {
  return LEDGER_TABLES.reduce((sum, name) => sum + (s.tables[name]?.rows ?? 0), 0)
}

function totalRows(s: Snapshot): number {
  return Object.values(s.tables).reduce((sum, t) => sum + t.rows, 0)
}

async function signIn(page: Page, user: SyntheticUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
  // Let the Home page it lands on finish loading, so its own reads are not mistaken for Price Check.
  await page.waitForLoadState('networkidle')
}

interface RequestLog {
  method: string
  url: string
}

/** Records every request to the backend and answers `search-prices` with synthetic observations. */
async function instrument(page: Page): Promise<{ log: RequestLog[]; bodies: string[] }> {
  const log: RequestLog[] = []
  const bodies: string[] = []
  page.on('request', (request) => {
    if (request.url().startsWith(SUPABASE_URL)) {
      log.push({ method: request.method(), url: request.url() })
    }
  })
  page.on('response', (response) => {
    if (response.url().startsWith(SUPABASE_URL) && response.url().includes('/rest/v1/')) {
      void response
        .text()
        .then((text) => bodies.push(text))
        .catch(() => undefined)
    }
  })
  await page.route('**/functions/v1/search-prices', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    const { cardIds } = JSON.parse(route.request().postData() ?? '{}') as { cardIds?: string[] }
    const { data } = (await service
      .from('card_variants')
      .select('id, card_id')
      .in('card_id', cardIds ?? [])) as { data: { id: string; card_id: string }[] | null }
    const observedAt = new Date(Date.now() - 86_400_000).toISOString()
    const results = (data ?? []).map((v) => ({
      cardVariantId: v.id,
      cardId: v.card_id,
      priceState: 'available',
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      sourceCurrency: 'EUR',
      sourceValueMinor: 1234,
      valueNokMinor: null,
      providerUpdatedAt: observedAt,
      observations: [
        {
          provider: 'tcgdex_cardmarket',
          priceKind: 'cm_trend',
          sourceCurrency: 'EUR',
          valueMinor: '1234',
          providerUpdatedAt: observedAt,
        },
        {
          provider: 'tcgdex_tcgplayer',
          priceKind: 'tp_market',
          sourceCurrency: 'USD',
          valueMinor: '1500',
          providerUpdatedAt: observedAt,
        },
      ],
    }))
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, results, providerErrorCount: 0 }),
    })
  })
  return { log, bodies }
}

/** Requests that could change state, in the Price Check phase only (after sign-in — signing in and
 *  the Home page it lands on are not Price Check). Strict: outside GET, only `search_cards` and
 *  `search-prices` are allowed, so ANY other RPC — read or write — fails the phase. */
function writes(log: RequestLog[]): RequestLog[] {
  return log.filter(({ method, url }) => {
    const path = new URL(url).pathname
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
    if (path.endsWith('/rest/v1/rpc/search_cards')) return false
    if (path.endsWith('/functions/v1/search-prices')) return false
    return true
  })
}

async function priceCheckSession(page: Page): Promise<void> {
  // Manual search → a multi-variant card → both variants, one after the other.
  await page.goto('/price-check')
  await page.getByLabel('Card name, set or number').fill('Charizard')
  const result = page.getByTestId('price-check-result').first()
  await expect(result).toBeVisible()
  await result.click()
  await expect(page.getByTestId('choose-variant')).toBeVisible()
  const options = page.getByTestId('variant-option')
  for (let i = 0; i < (await options.count()); i += 1) {
    await options.nth(i).click()
    await expect(page.getByTestId('observation').first()).toContainText('€12.34')
  }
  // A single-variant card.
  await page.goto('/price-check?q=Pikachu')
  await page.getByTestId('price-check-result').first().click()
  await expect(page.getByTestId('observation').first()).toContainText('€12.34')
  await expect(page.getByTestId('unavailable').first()).toHaveAttribute(
    'data-reason',
    'graded_source_not_configured',
  )
  // The explicit Add link only navigates.
  const add = page.getByRole('link', { name: /Add to collection/ })
  await expect(add).toBeVisible()
  await add.click()
  await expect(page).toHaveURL(/\/add\?variantId=/)
  await page.goBack()
}

async function scanSession(page: Page): Promise<'candidates' | 'no-match' | 'error'> {
  await page.goto('/price-check/scan')
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  const candidate = page.getByTestId('scan-candidate').first()
  const noMatch = page.getByTestId('scan-no-match')
  const notice = page.getByRole('alert')
  await expect(candidate.or(noMatch).or(notice)).toBeVisible({ timeout: 150_000 })
  if (await candidate.isVisible()) {
    if ((await candidate.getAttribute('aria-checked')) !== 'true') await candidate.click()
    await page.getByRole('button', { name: 'Check price' }).click()
    await expect(page).toHaveURL(/\/price-check\/[0-9a-f-]{36}/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    return 'candidates'
  }
  return (await noMatch.isVisible()) ? 'no-match' : 'error'
}

test.beforeAll(async () => {
  assertLocalStack()
  const { Client } = await import('pg')
  pgClient = new Client({ connectionString: DB_URL })
  await pgClient.connect()
  service = createServiceClient()
  await pgClient.query(
    `insert into public.cards (id, set_id, local_id, name, rarity, category, language, tcgdex_card_id)
     values ($1, $2, '049', 'Fauxosaur EX', 'Double Rare', 'Pokemon', 'en', 'faux-049')
     on conflict (id) do nothing`,
    [FAUX.cardId, seedCatalog.cardSetId],
  )
  await pgClient.query(
    `insert into public.card_variants (id, card_id, finish, stamp, subtype, size)
     values ($1, $3, 'normal', '', '', 'standard'), ($2, $3, 'reverse', '', '', 'standard')
     on conflict (id) do nothing`,
    [FAUX.variantIds[0], FAUX.variantIds[1], FAUX.cardId],
  )
  userA = await createSyntheticUser(service, 'p153-a')
  userB = await createSyntheticUser(service, 'p153-b')
  clientA = await signInAs(userA)
  ledgerIdsA = await buildLedger(clientA)
  // Market data (not user data): a cached Norges Bank rate so the NOK reference can be shown.
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  for (const [currency, rate] of [
    ['EUR', 11.54],
    ['USD', 10.5],
  ] as const) {
    const { error } = await service.from('fx_rates').upsert(
      {
        base_currency: currency,
        quote_currency: 'NOK',
        rate,
        rate_date: today,
        source: 'norges_bank',
      },
      { onConflict: 'base_currency,quote_currency,rate_date,source' },
    )
    if (error) throw new Error(`fx seed failed: ${error.message}`)
  }
})

test.afterAll(async () => {
  await pgClient.query('delete from public.card_variants where card_id = $1', [FAUX.cardId])
  await pgClient.query('delete from public.cards where id = $1', [FAUX.cardId])
  await pgClient.end()
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

test('the baseline is a real, non-trivial ledger (guards against a vacuous proof)', async () => {
  await settleDerivedTables()
  const baseline = await snapshot(userA.id, clientA)
  expect(ledgerIdsA.length).toBeGreaterThanOrEqual(9)
  const populated = Object.entries(baseline.tables).filter(([, t]) => t.rows > 0)
  const names = populated.map(([name]) => name)
  for (const expected of [
    'holdings',
    'acquisition_lots',
    'purchases',
    'purchase_lines',
    'sales',
    'sale_lines',
    'lot_disposals',
    'openings',
  ]) {
    expect(names, `ledger table ${expected} must hold rows in the baseline`).toContain(expected)
  }
  expect(totalRows(baseline)).toBeGreaterThan(15)
  test.info().annotations.push({
    type: 'baseline',
    description: `${String(Object.keys(baseline.tables).length)} user-owned tables discovered, ${String(populated.length)} populated, ${String(totalRows(baseline))} rows`,
  })
})

test('repeated searches, price lookups, variant switches and scans leave every user-owned table unchanged', async ({
  page,
}) => {
  test.setTimeout(600_000)
  await settleDerivedTables()
  const before = await snapshot(userA.id, clientA)
  const { log } = await instrument(page)
  await signIn(page, userA)
  const phaseStart = log.length

  await priceCheckSession(page)
  const scans: string[] = []
  scans.push(await scanSession(page))
  scans.push(await scanSession(page))
  await priceCheckSession(page)

  // The page really talked to THIS local stack, and only read.
  // Both real scans must have found the seeded card, so the confirm hand-off really ran.
  expect(scans).toEqual(['candidates', 'candidates'])
  expect(log.length).toBeGreaterThan(20)
  expect(log.every((r) => r.url.startsWith(SUPABASE_URL))).toBe(true)
  expect(writes(log.slice(phaseStart))).toEqual([])
  expect(log.some((r) => /add_card_acquisition|create_purchase|create_sale/.test(r.url))).toBe(
    false,
  )

  const after = await snapshot(userA.id, clientA)
  expect(after.tables).toEqual(before.tables)
  expect(after.portfolioCounts).toEqual(before.portfolioCounts)
  test.info().annotations.push({
    type: 'scans',
    description: `scan outcomes: ${scans.join(', ')}; ${String(log.length)} backend requests, 0 writes`,
  })
})

test('a scan that fails or is abandoned writes nothing', async ({ page }) => {
  test.setTimeout(300_000)
  await settleDerivedTables()
  const before = await snapshot(userA.id, clientA)
  const { log } = await instrument(page)
  await signIn(page, userA)
  const phaseStart = log.length

  // Not an image → error path.
  await page.goto('/price-check/scan')
  await page.locator('input[type=file]').setInputFiles({
    name: 'x.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('nope'),
  })
  await expect(page.getByRole('alert')).toBeVisible()
  // Start a real scan and leave mid-flight.
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  await page.getByRole('link', { name: '← Back to price check' }).click()
  // Start another and cancel it.
  await page.goto('/price-check/scan')
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  // The real scanner can finish before Cancel is reachable; either way nothing may be written, so
  // the cancel is best-effort here (the deterministic cancel/abandon cases live in the unit and
  // placeholder-backend suites).
  await page
    .getByRole('button', { name: 'Cancel' })
    .click({ timeout: 3000 })
    .catch(() => undefined)
  await page.waitForTimeout(3000)

  expect(writes(log.slice(phaseStart))).toEqual([])
  const after = await snapshot(userA.id, clientA)
  expect(after.tables).toEqual(before.tables)
  expect(after.portfolioCounts).toEqual(before.portfolioCounts)
})

test('account A → B in one browser: B sees none of A’s private data, and neither ledger changes', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const clientB = await signInAs(userB)
  await settleDerivedTables()
  const beforeA = await snapshot(userA.id, clientA)
  const beforeB = await snapshot(userB.id, clientB)
  // B has no portfolio or finances at all (signup itself may create bookkeeping rows).
  expect(ledgerRows(beforeB)).toBe(0)

  const { log, bodies } = await instrument(page)
  await signIn(page, userA)
  const phaseStart = log.length
  await page.goto('/price-check?q=Charizard')
  await page.getByTestId('price-check-result').first().click()
  await page.getByTestId('variant-option').first().click()
  await expect(page.getByTestId('observation').first()).toBeVisible()
  const priceRequestsForA = log.filter((r) => r.url.endsWith('/functions/v1/search-prices')).length
  expect(priceRequestsForA).toBeGreaterThanOrEqual(1)

  const phaseEndA = log.length
  // A signs out through the real button; B signs in in the same tab.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  bodies.length = 0
  const requestsBeforeB = log.length
  await signIn(page, userB)
  const phaseStartB = log.length
  await page.goto('/price-check?q=Charizard')
  await page.getByTestId('price-check-result').first().click()
  await page.getByTestId('variant-option').first().click()
  await expect(page.getByTestId('observation').first()).toBeVisible()

  // The in-memory cache did not carry A's lookups into B's session: B triggered its own.
  const priceRequestsForB = log
    .slice(requestsBeforeB)
    .filter((r) => r.url.endsWith('/functions/v1/search-prices')).length
  expect(priceRequestsForB).toBeGreaterThanOrEqual(1)

  // Nothing B's page received mentions A or any row A owns.
  await page.waitForTimeout(500)
  const seenByB = bodies.join('\n')
  for (const secret of [userA.id, userA.email, ...ledgerIdsA]) {
    expect(seenByB, `B's traffic must not contain ${secret.slice(0, 8)}…`).not.toContain(secret)
  }

  expect(writes(log.slice(phaseStart, phaseEndA))).toEqual([])
  expect(writes(log.slice(phaseStartB))).toEqual([])
  const afterA = await snapshot(userA.id, clientA)
  const afterB = await snapshot(userB.id, clientB)
  expect(afterA.tables).toEqual(beforeA.tables)
  expect(afterB.tables).toEqual(beforeB.tables)
  expect(ledgerRows(afterB)).toBe(0)
})
