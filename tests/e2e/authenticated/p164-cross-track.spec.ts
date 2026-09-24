import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test, expect, type Download, type Page, type Route, type Worker } from '@playwright/test'
import type { Client as PgClient } from 'pg'
import { EXPORT_CSV_FILENAMES } from '../../../src/domain/export/csv-projections'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'
import {
  AUTH_STORAGE_KEY,
  actInOtherTab,
  armBroadcastCounter,
  openOtherTab,
  signInThroughForm,
  switchAndSettle,
} from './support/two-tab'

/**
 * P164 — the three integrated tracks in ONE real browser against the real local stack:
 *
 *   P149  identity-bound operations (leases, AuthIdentityBoundary remount, credential-lookup failure)
 *   P162  safe exports (identity-bound, Cancel, typed CSV writer)
 *   P161  the hardened scanner and the read-only Price Check
 *
 * Every scenario here needs at least two of them at once, and each was previously proven only on
 * its own branch. Witnesses, all independent of the code under test:
 *   - the browser's own request log, with the account each request's bearer token BELONGS to (the
 *     JWT `sub`), so "under which identity was this sent" is a fact, not an inference;
 *   - the database, read through a direct connection: every `user_id` table's row count and md5 for
 *     BOTH accounts before and after;
 *   - what the person can see (text of the page), and the files a download really wrote.
 *
 * Only two things are answered by the test instead of the stack: the provider price lookup
 * (`search-prices` would call an external provider; the test answers with a per-ACCOUNT value so a
 * mixed-up answer is visible as text) and, where a scenario needs a stalled step, the network layer
 * holds one chosen request. LOCAL ONLY: the spec refuses any non-loopback stack.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const SCAN_IMAGE = fileURLToPath(
  new URL('../../fixtures/scanner/synthetic-card-modern.png', import.meta.url),
)

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const DB_URL = process.env['DB_URL'] ?? ''

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}

const A_MARKER = 'A-PRIVATE-MARKER-p164-7c1e'
const B_MARKER = 'B-PRIVATE-MARKER-p164-93d0'
/** Price the test's provider answers with, per ACCOUNT: a lookup answered for the wrong account is
 *  visible as the wrong number on screen. */
const PRICE_TEXT = { a: '€12.34', b: '€99.99' } as const
const PRICE_MINOR = { a: '1234', b: '9999' } as const

/** The synthetic scan fixture reads "FAUXOSAUR EX 049/197": a catalog card with that identity and
 *  two variants lets a real scan find a real candidate. Catalog data, removed afterwards. */
const FAUX = {
  cardId: 'c0000000-0000-0000-0000-000000000f64',
  variantIds: ['c0000000-0000-0000-0000-0000000af641', 'c0000000-0000-0000-0000-0000000af642'],
}

let pgClient: PgClient
let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

function assertLocalStack(): void {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(SUPABASE_URL)) {
    throw new Error(
      `Refusing to run: SUPABASE_URL must be loopback, got ${SUPABASE_URL || '(unset)'}`,
    )
  }
  if (!/@(127\.0\.0\.1|localhost):\d+\//.test(DB_URL)) {
    throw new Error('Refusing to run: DB_URL must be a loopback local database')
  }
}

// ---------------------------------------------------------------------------------------------
// Witness 1: what the browser sent, and as whom.
// ---------------------------------------------------------------------------------------------

interface Sent {
  method: string
  path: string
  /** JWT `sub` of the bearer token; null for the publishable key (no user) or no header. */
  sub: string | null
}

function subOf(authorization: string | undefined): string | null {
  const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
  const payload = token?.split('.')[1]
  if (payload === undefined) return null
  try {
    return (
      (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub ??
      null
    )
  } catch {
    return null
  }
}

function recordBackend(page: Page): Sent[] {
  const log: Sent[] = []
  page.on('request', (request) => {
    if (!request.url().startsWith(SUPABASE_URL)) return
    log.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      sub: subOf(request.headers()['authorization']),
    })
  })
  return log
}

/** Data requests (not the auth service itself, not preflights). */
function dataRequests(log: Sent[], from = 0, to = log.length): Sent[] {
  return log
    .slice(from, to)
    .filter(
      (r) =>
        r.method !== 'OPTIONS' &&
        (r.path.startsWith('/rest/v1/') || r.path.startsWith('/functions/v1/')),
    )
}

/** Every data request in the window carried THIS account's token — and none carried another's. */
function expectOnlyAccount(log: Sent[], from: number, to: number, who: SyntheticUser): void {
  const window = dataRequests(log, from, to)
  const wrong = window.filter((r) => r.sub !== who.id)
  expect(wrong, `every data request must be sent as ${who.id.slice(0, 8)}…`).toEqual([])
}

/** Requests that could change state: outside GET/HEAD only search_cards and search-prices. */
function priceCheckWrites(log: Sent[], from = 0, to = log.length): Sent[] {
  return log.slice(from, to).filter(({ method, path }) => {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
    if (path.startsWith('/auth/v1/')) return false
    if (path.endsWith('/rest/v1/rpc/search_cards')) return false
    if (path.endsWith('/functions/v1/search-prices')) return false
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Witness 2: the database, for every account, table by table.
// ---------------------------------------------------------------------------------------------

interface Snapshot {
  tables: Record<string, { rows: number; hash: string }>
  portfolioCounts: unknown
}

async function settleDerivedTables(): Promise<void> {
  // pg_cron is switched off on this stack, so the portfolio recompute queue is drained by hand:
  // derived bookkeeping, not a page write.
  const { error } = await service.rpc('drain_portfolio_recompute_queue', { p_batch_users: 100 })
  if (error) throw new Error(`drain_portfolio_recompute_queue failed: ${error.message}`)
}

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

async function countRows(table: string, userId: string): Promise<number> {
  const result = await pgClient.query<{ n: number }>(
    `select count(*)::int as n from public.${pgClient.escapeIdentifier(table)} where user_id = $1`,
    [userId],
  )
  return result.rows[0]?.n ?? 0
}

const LEDGER_TABLES = [
  'holdings',
  'acquisition_lots',
  'purchases',
  'purchase_lines',
  'sales',
  'sale_lines',
  'lot_disposals',
]

// ---------------------------------------------------------------------------------------------
// Helpers for driving the app.
// ---------------------------------------------------------------------------------------------

/** Answers every `search-prices` call with the value of the ACCOUNT that asked, and records who
 *  asked. An optional per-test hook can stall or fail the call. */
interface PriceCalls {
  subs: (string | null)[]
}

async function answerPricesPerAccount(
  page: Page,
  hook?: (route: Route, sub: string | null, nth: number) => Promise<'handled' | 'answer'>,
): Promise<PriceCalls> {
  const calls: PriceCalls = { subs: [] }
  await page.route('**/functions/v1/search-prices', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    const sub = subOf(route.request().headers()['authorization'])
    calls.subs.push(sub)
    if (hook !== undefined && (await hook(route, sub, calls.subs.length)) === 'handled') return
    const who = sub === userB.id ? 'b' : 'a'
    const { cardIds } = JSON.parse(route.request().postData() ?? '{}') as { cardIds?: string[] }
    const { data } = (await service
      .from('card_variants')
      .select('id, card_id')
      .in('card_id', cardIds ?? [])) as { data: { id: string; card_id: string }[] | null }
    const observedAt = new Date(Date.now() - 86_400_000).toISOString()
    await route
      .fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          providerErrorCount: 0,
          results: (data ?? []).map((v) => ({
            cardVariantId: v.id,
            cardId: v.card_id,
            priceState: 'available',
            provider: 'tcgdex_cardmarket',
            priceKind: 'cm_trend',
            sourceCurrency: 'EUR',
            sourceValueMinor: Number(PRICE_MINOR[who]),
            valueNokMinor: null,
            providerUpdatedAt: observedAt,
            observations: [
              {
                provider: 'tcgdex_cardmarket',
                priceKind: 'cm_trend',
                sourceCurrency: 'EUR',
                valueMinor: PRICE_MINOR[who],
                providerUpdatedAt: observedAt,
              },
            ],
          })),
        }),
      })
      .catch(() => undefined)
  })
  return calls
}

/** Every dedicated scanner worker (Tesseract or the visual model) the page currently has alive. */
function trackScannerWorkers(page: Page): { live: () => number } {
  const live = new Set<Worker>()
  page.on('worker', (worker) => {
    live.add(worker)
    worker.on('close', () => {
      live.delete(worker)
    })
  })
  return {
    live: () =>
      [...live].filter((w) => /scanner-assets\/v7\/worker\.min\.js|visual-worker/.test(w.url()))
        .length,
  }
}

/** Slows the scanner's runtime assets so a state change provably lands MID-scan. */
async function slowScanner(page: Page, ms = 2_500): Promise<void> {
  await page.route('**/scanner-assets/v7/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    await route.continue().catch(() => undefined)
  })
}

/** A client-side (non-reloading) navigation: a reload would destroy any in-flight work for free. */
async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

async function signOutViaUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
}

/** Price Check scan → the first candidate → its price for the FIRST variant. Returns to a result. */
async function scanConfirmAndPrice(page: Page, expected: string): Promise<void> {
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  const candidate = page.getByTestId('scan-candidate').first()
  await expect(candidate).toBeVisible({ timeout: 150_000 })
  if ((await candidate.getAttribute('aria-checked')) !== 'true') await candidate.click()
  await page.getByRole('button', { name: 'Check price' }).click()
  await expect(page).toHaveURL(/\/price-check\/[0-9a-f-]{36}/)
  // The card has two printings: nothing is priced until the person chooses one.
  await expect(page.getByTestId('choose-variant')).toBeVisible()
  await expect(page.getByTestId('observation')).toHaveCount(0)
  await page.getByTestId('variant-option').first().click()
  await expect(page.getByTestId('observation').first()).toContainText(expected)
}

/** Opens the first search result and prices it; a card with several printings needs an explicit choice. */
async function openFirstResultAndPrice(page: Page, expected: string): Promise<void> {
  await page.getByTestId('price-check-result').first().click()
  const choose = page.getByTestId('choose-variant')
  const observation = page.getByTestId('observation').first()
  await expect(choose.or(observation)).toBeVisible()
  if (await choose.isVisible()) await page.getByTestId('variant-option').first().click()
  await expect(observation).toContainText(expected)
}

function collectDownloads(page: Page): Download[] {
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  return downloads
}

test.beforeAll(async () => {
  assertLocalStack()
  const { Client } = await import('pg')
  pgClient = new Client({ connectionString: DB_URL })
  await pgClient.connect()
  service = createServiceClient()
  try {
    await pgClient.query(
      `insert into public.cards (id, set_id, local_id, name, rarity, category, language, tcgdex_card_id)
       values ($1, $2, '049', 'Fauxosaur EX', 'Double Rare', 'Pokemon', 'en', 'faux-049-p164')
       on conflict (id) do nothing`,
      [FAUX.cardId, seedCatalog.cardSetId],
    )
  } catch (error) {
    // The scanner fixture PRINTS this identity, so the catalog row cannot differ, and it is unique
    // per set: price-check-ledger.spec.ts uses the same printed card. Run the two one after the other.
    throw new Error(
      `fixture card 'Fauxosaur EX 049' already exists (price-check-ledger.spec.ts running at the same time?). Run the authenticated project with --workers=1.`,
      { cause: error },
    )
  }
  await pgClient.query(
    `insert into public.card_variants (id, card_id, finish, stamp, subtype, size)
     values ($1, $3, 'normal', '', '', 'standard'), ($2, $3, 'reverse', '', '', 'standard')
     on conflict (id) do nothing`,
    [FAUX.variantIds[0], FAUX.variantIds[1], FAUX.cardId],
  )
  userA = await createSyntheticUser(service, 'p164-a')
  userB = await createSyntheticUser(service, 'p164-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
  const today = new Date().toISOString().slice(0, 10)

  // A: a known, non-trivial ledger built only through the real RPCs, and a LARGE purchase — 620
  // lines, one of them 2^53 + 1 minor units — so exporting it takes several 500-row pages and
  // carries an amount a JavaScript number cannot hold.
  for (const variant of [seedCatalog.pikachuVariantId, seedCatalog.charizardVariantId]) {
    const { error } = await clientA.rpc('add_card_acquisition', {
      p_card_variant_id: variant,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 2,
      p_acquired_on: today,
      p_client_request_key: crypto.randomUUID(),
    })
    if (error) throw new Error(`A ledger: add_card_acquisition failed: ${error.message}`)
  }
  const lines = Array.from({ length: 620 }, (_, i) => ({
    line_type: 'card',
    card_variant_id: seedCatalog.pikachuVariantId,
    condition: 'NM',
    quantity: 1,
    unit_price_minor: i === 0 ? '9007199254740993' : String(100 + i),
  }))
  const big = await clientA.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'NOK',
    p_notes: A_MARKER,
    p_lines: lines,
  })
  if (big.error) throw new Error(`A ledger: large purchase failed: ${big.error.message}`)
  const sold = await clientA
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
      p_client_request_key: crypto.randomUUID(),
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (sold.error) throw new Error(`A ledger: sale lot failed: ${sold.error.message}`)
  const sale = await clientA.rpc('create_sale', {
    p_sold_on: today,
    p_currency: 'NOK',
    p_lines: [{ lot_id: sold.data.lot_id, quantity: 1, unit_gross_minor: 8000 }],
    p_idempotency_key: crypto.randomUUID(),
  })
  if (sale.error) throw new Error(`A ledger: create_sale failed: ${sale.error.message}`)

  // B: a small ledger with its own marker, plus a retailer carrying it.
  const b = await clientB.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'NOK',
    p_notes: B_MARKER,
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'NM',
        quantity: 2,
        unit_price_minor: 777,
      },
    ],
  })
  if (b.error) throw new Error(`B ledger: create_purchase failed: ${b.error.message}`)
  await service.from('retailers').insert({ user_id: userB.id, name: B_MARKER })

  // Market data (not user data): a cached Norges Bank rate so the NOK reference can be shown.
  const rateDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  for (const [currency, rate] of [
    ['EUR', 11.54],
    ['USD', 10.5],
  ] as const) {
    const { error } = await service.from('fx_rates').upsert(
      {
        base_currency: currency,
        quote_currency: 'NOK',
        rate,
        rate_date: rateDate,
        source: 'norges_bank',
      },
      { onConflict: 'base_currency,quote_currency,rate_date,source' },
    )
    if (error) throw new Error(`fx seed failed: ${error.message}`)
  }
})

test.afterAll(async () => {
  // Users first: their purchase lines reference the fixture printings.
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
  // Best effort: rows left by an aborted earlier run still reference the fixture (harmless catalog data).
  try {
    await pgClient.query('delete from public.card_variants where card_id = $1', [FAUX.cardId])
    await pgClient.query('delete from public.cards where id = $1', [FAUX.cardId])
  } catch (error) {
    console.warn('fixture catalog rows kept:', (error as Error).message)
  }
  await pgClient.end()
})

test('the baselines are real, non-trivial ledgers (guards against a vacuous proof)', async () => {
  await settleDerivedTables()
  const a = await snapshot(userA.id, clientA)
  const b = await snapshot(userB.id, clientB)
  for (const table of LEDGER_TABLES) {
    expect(a.tables[table]?.rows ?? 0, `A must hold rows in ${table}`).toBeGreaterThan(0)
  }
  expect(a.tables['purchase_lines']?.rows).toBeGreaterThanOrEqual(620)
  expect(b.tables['purchases']?.rows).toBe(1)
})

// ---------------------------------------------------------------------------------------------
// Scenario A: authenticated → scan → explicit variant → market price; nothing owned changes.
// ---------------------------------------------------------------------------------------------

test('A · authenticated scan → explicit variant choice → market price; every request is A’s and no row of A or B changes', async ({
  page,
}) => {
  test.setTimeout(400_000)
  await settleDerivedTables()
  const beforeA = await snapshot(userA.id, clientA)
  const beforeB = await snapshot(userB.id, clientB)
  const log = recordBackend(page)
  const calls = await answerPricesPerAccount(page)
  await signInThroughForm(page, userA)
  await page.waitForLoadState('networkidle')
  const start = log.length

  await page.goto('/price-check/scan')
  await scanConfirmAndPrice(page, PRICE_TEXT.a)
  // A second printing is a different lookup target: choosing it never shows the first one's number
  // as its own without a lookup, and the choice is never inferred.
  await expect(page.getByText(PRICE_TEXT.b)).toHaveCount(0)

  expectOnlyAccount(log, start, log.length, userA)
  expect(calls.subs.length).toBeGreaterThanOrEqual(1)
  expect(calls.subs.every((s) => s === userA.id)).toBe(true)
  expect(priceCheckWrites(log, start)).toEqual([])
  expect(
    log.slice(start).some((r) => /add_card_acquisition|create_purchase|create_sale/.test(r.path)),
  ).toBe(false)

  const afterA = await snapshot(userA.id, clientA)
  const afterB = await snapshot(userB.id, clientB)
  expect(afterA.tables).toEqual(beforeA.tables)
  expect(afterA.portfolioCounts).toEqual(beforeA.portfolioCounts)
  expect(afterB.tables).toEqual(beforeB.tables)
})

// ---------------------------------------------------------------------------------------------
// Scenario B: a DIRECT A → B switch (another tab signs in; this tab never passes through
// "signed out"), A → B → A, and a same-user token refresh.
// ---------------------------------------------------------------------------------------------

test('B · direct A → B while A’s scan is being read: B starts empty, A’s late result never surfaces, B scans and is priced as B', async ({
  page,
  context,
}) => {
  test.setTimeout(500_000)
  await settleDerivedTables()
  const beforeA = await snapshot(userA.id, clientA)
  const beforeB = await snapshot(userB.id, clientB)
  const workers = trackScannerWorkers(page)
  const log = recordBackend(page)
  const calls = await answerPricesPerAccount(page)
  await slowScanner(page)

  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  await page.goto('/price-check/scan')
  await armBroadcastCounter(page)
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  await expect(page.getByAltText('Card being scanned')).toBeVisible()

  // The other tab signs in as B. This tab never signs out: it hears SIGNED_IN(B) while A's scan is
  // mid-read.
  await switchAndSettle(page, other, { kind: 'sign-in', user: userB })
  await page.waitForTimeout(500)
  const startOfB = log.length

  await expect(page.getByText('Take or choose a photo')).toBeVisible()
  await expect(page.getByAltText('Card being scanned')).toHaveCount(0)
  // Long enough for A's abandoned scan to have finished had it survived the identity change.
  await page.waitForTimeout(20_000)
  await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
  await expect(page.getByTestId('scan-no-match')).toHaveCount(0)
  // Only B's own prewarmed reader may be alive (one OCR + one visual worker) — never A's.
  expect(workers.live()).toBeLessThanOrEqual(2)

  // B can scan and is priced as B; nothing of A's is in B's requests or on B's screen.
  await scanConfirmAndPrice(page, PRICE_TEXT.b)
  await expect(page.getByText(PRICE_TEXT.a)).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(A_MARKER)
  expectOnlyAccount(log, startOfB, log.length, userB)
  expect(calls.subs.filter((s) => s === userB.id).length).toBeGreaterThanOrEqual(1)
  expect(priceCheckWrites(log, startOfB)).toEqual([])

  // Leaving the scan screen releases every scanner worker.
  await expect.poll(() => workers.live(), { timeout: 30_000 }).toBe(0)

  const afterA = await snapshot(userA.id, clientA)
  const afterB = await snapshot(userB.id, clientB)
  expect(afterA.tables).toEqual(beforeA.tables)
  expect(afterB.tables).toEqual(beforeB.tables)
})

test('B · direct A → B → A: the original scan of A stays invalid, A’s new session is empty and works', async ({
  page,
  context,
}) => {
  test.setTimeout(500_000)
  await settleDerivedTables()
  const beforeA = await snapshot(userA.id, clientA)
  const beforeB = await snapshot(userB.id, clientB)
  const workers = trackScannerWorkers(page)
  const log = recordBackend(page)
  await answerPricesPerAccount(page)
  await slowScanner(page)

  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  await page.goto('/price-check/scan')
  await armBroadcastCounter(page)
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  await expect(page.getByAltText('Card being scanned')).toBeVisible()

  await switchAndSettle(page, other, { kind: 'sign-in', user: userB })
  await expect(page.getByText('Take or choose a photo')).toBeVisible()
  // Back to A (the SAME user id as when the scan began — a user-id comparison cannot tell).
  await switchAndSettle(page, other, { kind: 'sign-in', user: userA })
  await page.waitForTimeout(500)
  const startOfA2 = log.length

  await expect(page.getByText('Take or choose a photo')).toBeVisible()
  await expect(page.getByAltText('Card being scanned')).toHaveCount(0)
  await page.waitForTimeout(25_000)
  await expect(page.getByTestId('scan-candidate')).toHaveCount(0)
  await expect(page.getByTestId('scan-no-match')).toHaveCount(0)
  expect(workers.live()).toBeLessThanOrEqual(2)

  // A's new session is fully functional.
  await scanConfirmAndPrice(page, PRICE_TEXT.a)
  expectOnlyAccount(log, startOfA2, log.length, userA)
  expect(priceCheckWrites(log, startOfA2)).toEqual([])
  await expect.poll(() => workers.live(), { timeout: 30_000 }).toBe(0)

  expect((await snapshot(userA.id, clientA)).tables).toEqual(beforeA.tables)
  expect((await snapshot(userB.id, clientB)).tables).toEqual(beforeB.tables)
})

test('B · same-user TOKEN_REFRESHED corrupts neither a confirmed result nor a scan in progress', async ({
  page,
  context,
}) => {
  test.setTimeout(400_000)
  await settleDerivedTables()
  const beforeA = await snapshot(userA.id, clientA)
  const log = recordBackend(page)
  const calls = await answerPricesPerAccount(page)
  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  await page.goto('/price-check/scan')
  await armBroadcastCounter(page)

  // (1) a scan that is in progress when the token is refreshed keeps going and delivers.
  await slowScanner(page, 1_500)
  await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
  await expect(page.getByAltText('Card being scanned')).toBeVisible()
  await switchAndSettle(page, other, { kind: 'refresh' })
  const candidate = page.getByTestId('scan-candidate').first()
  await expect(candidate).toBeVisible({ timeout: 150_000 })

  // (2) a confirmed result survives a refresh untouched: same DOM node, same price, no new lookup.
  if ((await candidate.getAttribute('aria-checked')) !== 'true') await candidate.click()
  await page.getByRole('button', { name: 'Check price' }).click()
  await expect(page.getByTestId('choose-variant')).toBeVisible()
  await page.getByTestId('variant-option').first().click()
  const observation = page.getByTestId('observation').first()
  await expect(observation).toContainText(PRICE_TEXT.a)
  await observation.evaluate((el) => {
    el.setAttribute('data-p164-marker', 'same-node')
  })
  const lookupsBefore = calls.subs.length
  const startRefresh = log.length
  await switchAndSettle(page, other, { kind: 'refresh' })
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('observation').first()).toHaveAttribute(
    'data-p164-marker',
    'same-node',
  )
  await expect(page.getByTestId('observation').first()).toContainText(PRICE_TEXT.a)
  expect(calls.subs.length).toBe(lookupsBefore)
  // Refresh changed the token, never the account: everything after it is still A's.
  expectOnlyAccount(log, startRefresh, log.length, userA)

  expect((await snapshot(userA.id, clientA)).tables).toEqual(beforeA.tables)
})

// ---------------------------------------------------------------------------------------------
// Scenario C: A exports a large financial file while B takes over the browser and prices a card.
// ---------------------------------------------------------------------------------------------

test('C · A’s large export is held while B signs in and checks a price: no file reaches B, no A card/price/scanner state appears in B', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(400_000)
  await settleDerivedTables()
  const beforeA = await snapshot(userA.id, clientA)
  const beforeB = await snapshot(userB.id, clientB)
  const log = recordBackend(page)
  const calls = await answerPricesPerAccount(page)
  const downloads = collectDownloads(page)

  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  await page.goto('/price-check?q=Pikachu')
  await armBroadcastCounter(page)
  // A has looked at a price (A's value is now in the client cache).
  await openFirstResultAndPrice(page, PRICE_TEXT.a)

  // Client-side navigation to the export page (a reload would end the export for free).
  await spaNavigate(page, '/profile/export')
  await expect(page.getByRole('button', { name: 'Prepare CSV export' })).toBeVisible()
  await page.waitForLoadState('networkidle')

  // Hold the export's 6th data request (mid-way through the first big table).
  let count = 0
  let armed = false
  let releaseHeld: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  let reachedHold: () => void = () => undefined
  const holding = new Promise<void>((resolve) => {
    reachedHold = resolve
  })
  await page.route('**/rest/v1/**', async (route) => {
    if (!armed) {
      await route.continue()
      return
    }
    count += 1
    if (count === 6) {
      reachedHold()
      await gate
    }
    await route.continue()
  })
  armed = true
  const startOfExport = log.length
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await holding
  const endOfA = log.length

  // B takes over (another tab signs in). This tab hears it without reloading.
  await switchAndSettle(page, other, { kind: 'sign-in', user: userB })
  await page.waitForTimeout(500)
  const startOfB = log.length

  // B is on the export route, freshly mounted: A's "preparing/ready" state did not follow.
  await expect(page.getByText(/Ready —/)).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(A_MARKER)

  // B checks a price, client-side, while A's export is still parked.
  await spaNavigate(page, '/price-check?q=Pikachu')
  await openFirstResultAndPrice(page, PRICE_TEXT.b)
  await expect(page.getByText(PRICE_TEXT.a)).toHaveCount(0)

  // A's held request finally completes; the export must go no further and deliver nothing.
  const heldBefore = count
  releaseHeld()
  await page.waitForTimeout(6_000)
  expect(count - heldBefore).toBeLessThanOrEqual(1)
  expect(downloads).toHaveLength(0)
  await expect(page.getByText(/Ready —/)).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(A_MARKER)
  expect(page.url()).not.toContain('login')

  // Account by account: everything before the switch was A's, everything after it was B's.
  expectOnlyAccount(log, startOfExport, endOfA, userA)
  expectOnlyAccount(log, startOfB, log.length, userB)
  expect(calls.subs.filter((s) => s === userB.id).length).toBeGreaterThanOrEqual(1)

  // Control: B's OWN export works, and contains B and nothing of A.
  await spaNavigate(page, '/profile/export')
  await page.unroute('**/rest/v1/**')
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(page.getByText(/Ready — CSV export, 11 files/)).toBeVisible({ timeout: 120_000 })
  await page.getByRole('button', { name: /Save \/ Share CSV export/ }).click()
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(11)
  expect(downloads.map((d) => d.suggestedFilename()).sort()).toEqual(
    [...EXPORT_CSV_FILENAMES].sort(),
  )
  let sawBMarker = false
  for (const download of downloads) {
    const target = `${testInfo.outputDir}/${download.suggestedFilename()}`
    await download.saveAs(target)
    const text = (await readFile(target)).toString('utf8')
    expect(text).not.toContain(A_MARKER)
    expect(text).not.toContain(userA.id)
    if (text.includes(B_MARKER)) sawBMarker = true
  }
  expect(sawBMarker).toBe(true)

  expect((await snapshot(userA.id, clientA)).tables).toEqual(beforeA.tables)
  expect((await snapshot(userB.id, clientB)).tables).toEqual(beforeB.tables)
})

test('C · A’s large export completes exactly (2^53+1, several pages) when nothing changes, all requests A’s', async ({
  page,
}, testInfo) => {
  test.setTimeout(400_000)
  const log = recordBackend(page)
  const downloads = collectDownloads(page)
  await signInThroughForm(page, userA)
  await page.goto('/profile/export')
  await page.waitForLoadState('networkidle')
  const start = log.length
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(page.getByText(/Ready — CSV export, 11 files/)).toBeVisible({ timeout: 180_000 })
  await page.getByRole('button', { name: /Save \/ Share CSV export/ }).click()
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(11)
  expectOnlyAccount(log, start, log.length, userA)
  let lines: string | null = null
  for (const download of downloads) {
    const target = `${testInfo.outputDir}/${download.suggestedFilename()}`
    await download.saveAs(target)
    const bytes = await readFile(target)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.toString('utf8')
    expect(text).not.toContain(B_MARKER)
    if (download.suggestedFilename() === 'purchase_lines.csv') lines = text
  }
  expect(lines).not.toBeNull()
  // 2^53 + 1 minor units of NOK = 90071992547409.93, written with every digit (P157/P162/P149).
  expect(lines).toContain('90071992547409.93')
  expect((lines ?? '').split('\r\n').filter((l) => l !== '').length).toBe(621) // header + 620
})

// ---------------------------------------------------------------------------------------------
// Scenario D: a temporary credential-refresh failure is a recoverable error, not a sign-out, and
// nothing is presented as a result.
// ---------------------------------------------------------------------------------------------

const REFRESH_ENDPOINT = /\/auth\/v1\/token\?grant_type=refresh_token/
const COOLDOWN_MS = 62_000 // auth-js keeps a refresh failure for 60 s

async function breakRefreshEndpoint(page: Page): Promise<{ attempts: () => number }> {
  let attempts = 0
  await page.route(REFRESH_ENDPOINT, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fallback()
      return
    }
    attempts += 1
    await route.abort('connectionrefused')
  })
  return { attempts: () => attempts }
}

async function expireAccessToken(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (raw === null) throw new Error('no stored session to expire')
    const session = JSON.parse(raw) as { expires_at: number }
    session.expires_at = Math.floor(Date.now() / 1000) - 120
    window.localStorage.setItem(key, JSON.stringify(session))
  }, AUTH_STORAGE_KEY)
}

async function storedUserId(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    return (JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null
  }, AUTH_STORAGE_KEY)
}

test('D · refresh outage during Price Check: a recoverable error, never a price or an empty "no match", identity untouched, retry works', async ({
  page,
}) => {
  test.setTimeout(400_000)
  const log = recordBackend(page)
  await answerPricesPerAccount(page)
  await signInThroughForm(page, userA)
  await page.goto('/price-check')
  await expect(page.getByLabel('Card name, set or number')).toBeVisible()
  await page.waitForLoadState('networkidle')

  const refresh = await breakRefreshEndpoint(page)
  await expireAccessToken(page)
  const start = log.length
  await page.getByLabel('Card name, set or number').fill('Pikachu')

  // The lookup fails after the library's backoff. The page must SAY so (an alert), must not show
  // "no cards found" (that would be a false statement about the catalog) and must not show results.
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('price-check-result')).toHaveCount(0)
  await expect(page.getByText(/no (matching )?cards?/i)).toHaveCount(0)
  expect(refresh.attempts()).toBeGreaterThan(0)
  // Still signed in as A: not redirected, the stored session is intact.
  expect(page.url()).not.toContain('/login')
  expect(await storedUserId(page)).toBe(userA.id)
  // Whatever was sent during the outage was never sent as another account.
  for (const r of dataRequests(log, start)) {
    expect(r.sub === userA.id || r.sub === null, 'no request as another account').toBe(true)
  }

  // The service recovers; once the library's 60 s failure cache has run out, retry works.
  await page.unroute(REFRESH_ENDPOINT)
  await page.waitForTimeout(COOLDOWN_MS)
  const retry = page.getByRole('button', { name: /try again|retry/i }).first()
  if (await retry.isVisible().catch(() => false)) await retry.click()
  else await page.getByLabel('Card name, set or number').fill('Pikachu ')
  await expect(page.getByTestId('price-check-result').first()).toBeVisible({ timeout: 60_000 })
  expect(await storedUserId(page)).toBe(userA.id)
})

test('D · refresh outage during an export: it fails closed with the session message, nothing is saved, and the same export works after recovery', async ({
  page,
}) => {
  test.setTimeout(500_000)
  const downloads = collectDownloads(page)
  await signInThroughForm(page, userA)
  await page.goto('/profile/export')
  await expect(page.getByRole('button', { name: 'Prepare CSV export' })).toBeVisible()
  await page.waitForLoadState('networkidle')

  const refresh = await breakRefreshEndpoint(page)
  await expireAccessToken(page)
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(
    page.getByText(/Could not verify your session\. Check your connection and try again\./),
  ).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText(/Ready —/)).toHaveCount(0)
  expect(downloads).toHaveLength(0)
  expect(refresh.attempts()).toBeGreaterThan(0)
  expect(page.url()).not.toContain('/login')
  expect(await storedUserId(page)).toBe(userA.id)

  await page.unroute(REFRESH_ENDPOINT)
  await page.waitForTimeout(COOLDOWN_MS)
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await expect(page.getByText(/Ready — CSV export, 11 files/)).toBeVisible({ timeout: 180_000 })
  expect(downloads).toHaveLength(0) // nothing is saved until the person saves
})

// ---------------------------------------------------------------------------------------------
// Scenario E: sign-out during scanner start-up leaves no orphan worker.
// ---------------------------------------------------------------------------------------------

test('E · A signs out during scanner start-up (Price Check and /scan): no worker outlives the start-up it interrupted, no page error', async ({
  page,
  context,
}) => {
  test.setTimeout(400_000)
  const workers = trackScannerWorkers(page)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await slowScanner(page, 4_000)
  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)

  for (const route of ['/price-check/scan', '/scan']) {
    await page.goto(route)
    // The scanner is cold-starting (its assets are slowed): sign out before it is ready. /scan is a
    // full-screen overlay without the app's Sign out button, so there the OTHER tab signs out.
    await page.waitForTimeout(600)
    const signedOutAt = Date.now()
    if (route === '/scan') {
      await actInOtherTab(other, { kind: 'sign-out' })
      await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 15_000 })
    } else {
      await signOutViaUi(page)
    }
    // A Tesseract worker whose construction had already begun cannot be interrupted: it is
    // terminated the moment its initialisation completes (P151, ocr-engine.ts). What must hold is
    // that this is BOUNDED, that nothing new is ever created afterwards, and that it ends at zero.
    let lastAliveAt = 0
    let zeroSince: number | null = null
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (workers.live() > 0) {
        lastAliveAt = Date.now()
        zeroSince = null
      } else {
        zeroSince ??= Date.now()
        if (Date.now() - zeroSince >= 12_000) break
      }
      await page.waitForTimeout(500)
    }
    expect(zeroSince, `no scanner worker may remain after signing out from ${route}`).not.toBeNull()
    expect(workers.live()).toBe(0)
    expect(lastAliveAt === 0 ? 0 : lastAliveAt - signedOutAt).toBeLessThan(45_000)
    test.info().annotations.push({
      type: 'orphan-window',
      description: `${route}: last worker alive ${
        lastAliveAt === 0
          ? 'never after sign-out'
          : `${String(lastAliveAt - signedOutAt)} ms after sign-out (assets slowed 4 s each)`
      }`,
    })
    await signInThroughForm(page, userA)
  }
  expect(pageErrors).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// Scenario F: a confirmed scan may lead to Add to Collection, but only an explicit submit writes.
// ---------------------------------------------------------------------------------------------

test('F · scan → price → “Add to collection” only navigates; the holding exists only after the explicit submit, as A', async ({
  page,
}) => {
  test.setTimeout(400_000)
  await settleDerivedTables()
  const beforeB = await snapshot(userB.id, clientB)
  const log = recordBackend(page)
  await answerPricesPerAccount(page)
  await signInThroughForm(page, userA)
  await page.goto('/price-check/scan')
  await scanConfirmAndPrice(page, PRICE_TEXT.a)

  const holdingsBefore = await countRows('holdings', userA.id)
  const lotsBefore = await countRows('acquisition_lots', userA.id)
  const start = log.length
  await page.getByRole('link', { name: /Add to collection/ }).click()
  await expect(page).toHaveURL(/\/add\?variantId=/)
  await expect(page.getByRole('button', { name: 'Add to collection' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  // On the Add page and nothing has been written.
  expect(await countRows('holdings', userA.id)).toBe(holdingsBefore)
  expect(await countRows('acquisition_lots', userA.id)).toBe(lotsBefore)
  expect(log.slice(start).some((r) => /add_card_acquisition/.test(r.path))).toBe(false)

  await page.getByLabel('Cost per card (NOK)').fill('149,50')
  await page.getByRole('button', { name: 'Add to collection' }).click()
  await expect
    .poll(async () => countRows('holdings', userA.id), { timeout: 30_000 })
    .toBe(holdingsBefore + 1)
  expect(await countRows('acquisition_lots', userA.id)).toBe(lotsBefore + 1)

  const writes = log
    .slice(start)
    .filter((r) => r.method === 'POST' && /add_card_acquisition/.test(r.path))
  expect(writes).toHaveLength(1)
  expect(writes[0]?.sub).toBe(userA.id)
  // The row belongs to A and to the variant that was chosen; B is untouched.
  const owner = await pgClient.query<{ user_id: string; card_variant_id: string }>(
    `select user_id, card_variant_id from public.holdings
      where user_id = $1 and card_variant_id = any($2::uuid[])`,
    [userA.id, FAUX.variantIds],
  )
  expect(owner.rows).toHaveLength(1)
  expect(FAUX.variantIds).toContain(owner.rows[0]?.card_variant_id)
  expect((await snapshot(userB.id, clientB)).tables).toEqual(beforeB.tables)
})

// ---------------------------------------------------------------------------------------------
// Scenario G: the scanner's own (leased) acquisition path across an account switch.
// ---------------------------------------------------------------------------------------------

test('G · /scan batch of two: A → B while the first write is in flight — the write completes as A only, the second is never attempted, B owns nothing', async ({
  page,
  context,
}) => {
  test.setTimeout(500_000)
  await settleDerivedTables()
  const lotsA = await countRows('acquisition_lots', userA.id)
  const holdingsB = await countRows('holdings', userB.id)
  const log = recordBackend(page)
  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  await page.goto('/scan')
  await armBroadcastCounter(page)

  // Two items: both printings of the same scanned card (the scanner never picks a printing).
  for (const index of FAUX.variantIds.keys()) {
    await page.locator('input[type=file]').setInputFiles(SCAN_IMAGE)
    await page.getByRole('button', { name: 'Use photo' }).click()
    await expect(page.getByRole('button', { name: 'Confirm card' })).toBeVisible({
      timeout: 150_000,
    })
    await page.getByRole('button', { name: 'Confirm card' }).click()
    await expect(page.getByRole('heading', { name: 'Confirm card' })).toBeVisible()
    await page
      .getByRole('group', { name: 'Version' })
      .getByRole('button', { name: index === 0 ? 'Normal' : 'Reverse holo', exact: true })
      .click()
    await page.getByRole('button', { name: 'Add to batch' }).click()
    if (index === 0) {
      await page.getByRole('button', { name: 'Scan next' }).click()
      // Headless Chromium has no camera: the start attempt fails and settles the screen. A photo
      // chosen before that settles would be discarded with the abandoned camera step.
      await expect(page.getByRole('alert')).toBeVisible()
    }
  }
  await page.getByRole('button', { name: 'Review batch' }).click()
  await expect(page.getByText('Total: 2 cards')).toBeVisible()

  // Hold the FIRST acquisition write at the network.
  let commitRequests = 0
  let releaseHeld: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  let reached: () => void = () => undefined
  const holding = new Promise<void>((resolve) => {
    reached = resolve
  })
  await page.route('**/rest/v1/rpc/add_card_acquisition**', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    commitRequests += 1
    if (commitRequests === 1) {
      reached()
      await gate
    }
    await route.continue()
  })
  const start = log.length
  await page.getByRole('button', { name: 'Add cards' }).click()
  await holding
  const heldSub = log.slice(start).filter((r) => /add_card_acquisition/.test(r.path))[0]?.sub
  expect(heldSub).toBe(userA.id)

  await switchAndSettle(page, other, { kind: 'sign-in', user: userB })
  await page.waitForTimeout(500)
  const endOfA = log.length
  releaseHeld()
  await page.waitForTimeout(8_000)

  // Exactly one write ever left this browser, it was A's, and B's screen shows none of A's batch.
  expect(commitRequests).toBe(1)
  const writes = log.filter((r) => /add_card_acquisition/.test(r.path) && r.method === 'POST')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.sub).toBe(userA.id)
  await expect(page.getByText('Total: 2 cards')).toHaveCount(0)
  // B's scanner is a fresh screen: no batch counter, no committed-batch summary.
  await expect(page.getByRole('heading', { name: 'Scan cards' })).toBeVisible()
  await expect(page.getByText(/\d+ scanned/)).toHaveCount(0)
  expect(await countRows('acquisition_lots', userA.id)).toBe(lotsA + 1)
  expect(await countRows('holdings', userB.id)).toBe(holdingsB)
  // Nothing sent after the switch is A's.
  expectOnlyAccount(log, endOfA, log.length, userB)
})
