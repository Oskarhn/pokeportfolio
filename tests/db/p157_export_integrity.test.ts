import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../src/domain/export/build-backup'
import {
  buildCsvSuite,
  EXPORT_CSV_SCHEMA,
  projectionInputFromSnapshot,
  type ExportCsvFilename,
} from '../../src/domain/export/csv-projections'
import { fetchExportSnapshot, type ExportFetchOptions } from '../../src/data/export/fetch-snapshot'
import { AuthIdentityChangedError } from '../../src/auth/identity-lease'
import type { Database } from '../../src/data/database.types'
import { parseCsvRfc } from '../data/csv-rfc-parser'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P157 — the export pipeline against the real schema, real RLS and two real accounts.
 *
 * Expected values come from the database through an INDEPENDENT read (service role, every money
 * column cast `::text`), never from the export's own fetch layer. Covers: cell-for-cell CSV/DB
 * agreement (JPY, extreme amounts, negative proceeds, unknown basis, a graded holding, an
 * opening), no B data in A's files, deterministic repeat exports, raw-vs-prefixed text (JSON vs
 * CSV), an account switch mid-pagination, injected network failures and cancellation, and that
 * an export performs no backend write.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser

const today = new Date().toISOString().slice(0, 10)
const NOTE_RAW = ' =1+1\r\nsecond line, "quoted"' // leading space + formula + CRLF + comma + quote
const B_MARKER = 'B-PRIVATE-MARKER-9f3a'

interface WireCapture {
  method: string
  url: string
}

type Loose = Record<string, unknown>

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

async function signInClient(
  user: SyntheticUser,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<SupabaseClient<Database>> {
  const url = process.env['SUPABASE_URL']
  const anonKey = process.env['SUPABASE_ANON_KEY']
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set')
  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(options.fetchImpl ? { global: { fetch: options.fetchImpl } } : {}),
  })
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`)
  return client
}

/** Independent DB truth: every money column selected `::text` so nothing passes through a float. */
async function dbRows(table: string, select: string, userId: string): Promise<Loose[]> {
  const { data, error } = await service.from(table).select(select).eq('user_id', userId)
  if (error) throw new Error(`${table}: ${error.message}`)
  return data as unknown as Loose[]
}

/** Reads a rendered decimal cell back to integer minor units — the exactness oracle. */
function reconstruct(cell: string, exponent: number): bigint {
  const negative = cell.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? cell.slice(1) : cell).split('.')
  expect(fraction.length).toBe(exponent)
  const magnitude = BigInt(whole) * 10n ** BigInt(exponent) + (fraction ? BigInt(fraction) : 0n)
  return negative ? -magnitude : magnitude
}

function exponentOf(currency: string): number {
  return currency === 'JPY' ? 0 : 2
}

function csvOf(files: ReturnType<typeof buildCsvSuite>, name: ExportCsvFilename) {
  const file = files.find((f) => f.filename === name)
  if (!file) throw new Error(`${name} missing`)
  const [header, ...rows] = parseCsvRfc(file.text).records
  if (!header) throw new Error(`${name} has no header`)
  expect(header).toEqual(EXPORT_CSV_SCHEMA[name].map((c) => c.header))
  for (const row of rows) expect(row).toHaveLength(header.length) // no shifted cells
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])))
}

async function exportCsvAs(
  client: SupabaseClient<Database>,
  options?: ExportFetchOptions,
): Promise<ReturnType<typeof buildCsvSuite>> {
  return buildCsvSuite(projectionInputFromSnapshot(await fetchExportSnapshot(client, options)))
}

let clientA: SupabaseClient<Database>
let seededHoldingId = ''

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p157-export-a')
  userB = await createSyntheticUser(service, 'p157-export-b')
  clientA = await signInClient(userA)
  const uid = userA.id

  const { data: retailer } = await service
    .from('retailers')
    .insert({ user_id: uid, name: '-Local Store' })
    .select('id')
    .single()
  await service.from('storage_locations').insert({ user_id: uid, name: 'Binder α', kind: 'binder' })
  await service.from('tags').insert({ user_id: uid, name: '@trade-bait' })

  // NOK purchase: a 2-unit card line (known basis) and an accessory with a formula-shaped name.
  const { data: nokPurchase, error: nokError } = await clientA.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'NOK',
    p_retailer_id: retailer?.id ?? null,
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'NM',
        quantity: 2,
        unit_price_minor: 10000,
      },
      { line_type: 'accessory', description: '+TOPLOADER', quantity: 1, unit_price_minor: 500 },
    ],
  })
  if (nokError) throw new Error(`create_purchase NOK failed: ${nokError.message}`)

  // JPY purchase (exponent 0): 12345 yen, whole units, with a frozen manual FX triple.
  const { error: jpyError } = await clientA.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'JPY',
    p_fx_rate_to_nok: '0.06000000',
    p_fx_rate_date: today,
    p_fx_source: 'manual',
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 12345,
      },
    ],
  })
  if (jpyError) throw new Error(`create_purchase JPY failed: ${jpyError.message}`)

  const { data: cardLine } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', nokPurchase.id)
    .eq('card_variant_id', seedCatalog.charizardVariantId)
    .single()
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('purchase_line_id', cardLine?.id)
    .single()
  seededHoldingId = lot!.holding_id as string
  await service.from('holdings').update({ notes: NOTE_RAW }).eq('id', seededHoldingId)

  // Known-basis loss: sold at 100 øre with 5000 øre fees → NEGATIVE net proceeds (-4900).
  const { error: lossError } = await clientA.rpc('create_sale', {
    p_sold_on: today,
    p_currency: 'NOK',
    p_marketplace: '=Finn "torget"',
    p_lines: [{ lot_id: lot!.id, quantity: 1, unit_gross_minor: 100 }],
    p_fees_minor: 5000,
    p_idempotency_key: crypto.randomUUID(),
  })
  if (lossError) throw new Error(`create_sale (loss) failed: ${lossError.message}`)

  // Gift lot with genuinely unknown basis, later sold: an UNCOSTED sale line (basis and result NULL).
  const { data: gift } = await service
    .from('holdings')
    .insert({
      user_id: uid,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.grassEnergyVariantId,
      condition: 'GD',
    })
    .select('id')
    .single()
  const { data: giftLot } = await service
    .from('acquisition_lots')
    .insert({
      holding_id: gift!.id,
      user_id: uid,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: today,
      quantity: 2,
      quantity_remaining: 2,
    })
    .select('id')
    .single()
  const { error: uncostedError } = await clientA.rpc('create_sale', {
    p_sold_on: today,
    p_currency: 'NOK',
    p_lines: [{ lot_id: giftLot!.id, quantity: 1, unit_gross_minor: 2000 }],
    p_idempotency_key: crypto.randomUUID(),
  })
  if (uncostedError) throw new Error(`create_sale (uncosted) failed: ${uncostedError.message}`)

  // A graded holding with a formula-shaped cert number and a manual valuation note.
  const { data: graded, error: gradedError } = await service
    .from('holdings')
    .insert({
      user_id: uid,
      holding_kind: 'graded_card',
      card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
      grading_state: 'graded',
      grader: 'psa',
      grade: 9.5,
      cert_number: '=CERT-001',
    })
    .select('id')
    .single()
  if (gradedError) throw new Error(`graded holding insert failed: ${gradedError.message}`)
  await service.from('acquisition_lots').insert({
    holding_id: graded.id,
    user_id: uid,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: today,
    quantity: 1,
    quantity_remaining: 1,
  })
  const { error: valError } = await clientA.rpc('set_manual_valuation', {
    p_holding_id: graded.id,
    p_value_minor: 123456,
    p_note: '@HYPERLINK inert note',
    p_effective_from: today,
  })
  if (valError) throw new Error(`set_manual_valuation failed: ${valError.message}`)

  // An opening: buy 3 sealed packs, open 1.
  const { data: sealedPurchase, error: sealedError } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: 3,
          unit_price_minor: 5990,
        },
      ],
    })
    .single<{ id: string }>()
  if (sealedError) throw new Error(`sealed purchase failed: ${sealedError.message}`)
  const { data: sealedLine } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', sealedPurchase.id)
    .single()
  const { data: sealedLot } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', sealedLine!.id)
    .single()
  const { error: openError } = await clientA.rpc('create_opening', {
    p_source_lot_id: sealedLot!.id,
    p_quantity: 1,
    p_opened_on: today,
    p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
  })
  if (openError) throw new Error(`create_opening failed: ${openError.message}`)

  // Exactness probes past 2^53 and at 2^58 on real lot columns.
  await service
    .from('acquisition_lots')
    .update({ unit_cost_basis_minor: '9007199254740993' })
    .eq('id', lot!.id)
  await service
    .from('acquisition_lots')
    .update({ unit_cost_basis_nok_minor: '288230376151711744' })
    .eq('id', lot!.id)

  // Account B: rows that must never appear in A's files.
  const clientB = await signInClient(userB)
  await service.from('retailers').insert({ user_id: userB.id, name: B_MARKER })
  const { error: bError } = await clientB.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'NOK',
    p_notes: B_MARKER,
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 777,
      },
    ],
  })
  if (bError) throw new Error(`B purchase failed: ${bError.message}`)
  await service.from('tags').insert({ user_id: userB.id, name: B_MARKER })
})

afterAll(async () => {
  await deleteSyntheticUser(service, userB.id)
  await deleteSyntheticUser(service, userA.id)
})

describe('P157 CSV agrees with the database, cell for cell', () => {
  it('every file has exactly the database row count for account A', async () => {
    const files = await exportCsvAs(clientA)
    const expected: Record<string, number> = {
      'purchases.csv': (await dbRows('purchases', 'id', userA.id)).length,
      'purchase_lines.csv': (await dbRows('purchase_lines', 'id', userA.id)).length,
      'sales.csv': (await dbRows('sales', 'id', userA.id)).length,
      'sale_lines.csv': (await dbRows('sale_lines', 'id', userA.id)).length,
      'acquisition_lots.csv': (await dbRows('acquisition_lots', 'id', userA.id)).length,
      'openings.csv': (await dbRows('openings', 'id', userA.id)).length,
      'manual_valuations.csv': (await dbRows('manual_valuations', 'id', userA.id)).length,
      'lot_disposals.csv': (await dbRows('lot_disposals', 'id', userA.id)).length,
    }
    for (const [file, count] of Object.entries(expected)) {
      expect(csvOf(files, file as ExportCsvFilename), file).toHaveLength(count)
      expect(count, `${file} seeded`).toBeGreaterThan(0)
    }
  })

  it('purchase and sale money equals the database digit for digit, JPY included', async () => {
    const files = await exportCsvAs(clientA)
    const purchases = await dbRows(
      'purchases',
      'id, currency, subtotal_minor::text, total_minor::text, total_nok_minor::text',
      userA.id,
    )
    const rows = csvOf(files, 'purchases.csv')
    expect(new Set(purchases.map((p) => p['currency']))).toEqual(new Set(['NOK', 'JPY']))
    for (const p of purchases) {
      const row = rows.find((r) => r['Purchase ID'] === p['id'])
      const currency = p['currency'] as string
      expect(row?.['Currency']).toBe(currency)
      expect(reconstruct(row?.['Total'] ?? '', exponentOf(currency))).toBe(
        BigInt(p['total_minor'] as string),
      )
      expect(reconstruct(row?.['Total NOK'] ?? '', 2)).toBe(BigInt(p['total_nok_minor'] as string))
    }
    // The JPY line is whole yen with its currency in the same row — never 123.45.
    const lines = csvOf(files, 'purchase_lines.csv')
    const jpyLine = lines.find((r) => r['Currency'] === 'JPY')
    expect(jpyLine?.['Unit price']).toBe('12345')
  })

  it('negative net proceeds keep their sign and stay numeric', async () => {
    const files = await exportCsvAs(clientA)
    const sales = await dbRows(
      'sales',
      'id, net_proceeds_minor::text, net_proceeds_nok_minor::text, realized_result_nok_minor::text',
      userA.id,
    )
    const negative = sales.find((s) => BigInt(s['net_proceeds_minor'] as string) < 0n)
    expect(negative, 'the seeded loss-making sale exists').toBeDefined()
    const row = csvOf(files, 'sales.csv').find((r) => r['Sale ID'] === negative?.['id'])
    expect(row?.['Net proceeds']).toBe('-49.00')
    expect(row?.['Net proceeds']?.startsWith("'")).toBe(false)
    expect(reconstruct(row?.['Net proceeds NOK'] ?? '', 2)).toBe(
      BigInt(negative?.['net_proceeds_nok_minor'] as string),
    )
  })

  it('unknown basis is an empty cell, never 0.00 — in the lot and in the sale line', async () => {
    const files = await exportCsvAs(clientA)
    const lots = await dbRows(
      'acquisition_lots',
      'id, cost_basis_state, unit_cost_basis_minor::text, unit_cost_basis_nok_minor::text',
      userA.id,
    )
    const unknownLots = lots.filter((l) => l['unit_cost_basis_minor'] === null)
    expect(unknownLots.length).toBeGreaterThanOrEqual(2)
    const lotRows = csvOf(files, 'acquisition_lots.csv')
    for (const lot of unknownLots) {
      const row = lotRows.find((r) => r['Lot ID'] === lot['id'])
      expect(row?.['Unit cost']).toBe('')
      expect(row?.['Unit cost NOK']).toBe('')
    }
    const saleLines = await dbRows(
      'sale_lines',
      'id, cost_basis_at_sale_nok_minor::text, realized_result_nok_minor::text',
      userA.id,
    )
    const uncosted = saleLines.filter((l) => l['cost_basis_at_sale_nok_minor'] === null)
    expect(uncosted.length).toBeGreaterThanOrEqual(1)
    const lineRows = csvOf(files, 'sale_lines.csv')
    for (const line of uncosted) {
      const row = lineRows.find((r) => r['Line ID'] === line['id'])
      expect(row?.['Cost basis NOK']).toBe('')
      expect(row?.['Realized result NOK']).toBe('')
    }
  })

  it('amounts beyond 2^53 and at 2^58 arrive exactly (the ::text transport)', async () => {
    const files = await exportCsvAs(clientA)
    const lots = await dbRows(
      'acquisition_lots',
      'id, unit_cost_basis_minor::text, unit_cost_basis_nok_minor::text',
      userA.id,
    )
    const huge = lots.find((l) => l['unit_cost_basis_minor'] === '9007199254740993')
    expect(huge, 'the 2^53+1 probe exists in the database').toBeDefined()
    const row = csvOf(files, 'acquisition_lots.csv').find((r) => r['Lot ID'] === huge?.['id'])
    expect(row?.['Unit cost']).toBe('90071992547409.93')
    expect(row?.['Unit cost NOK']).toBe('2882303761517117.44') // 2^58 øre
  })

  it('a graded holding, an opening and their formula-shaped text are all present and safe', async () => {
    const files = await exportCsvAs(clientA)
    const holdings = csvOf(files, 'holdings.csv')
    const graded = holdings.find((r) => r['Kind'] === 'graded_card')
    expect(graded?.['Grader']).toBe('psa')
    expect(graded?.['Grade']).toBe('9.5')
    expect(graded?.['Cert number']).toBe("'=CERT-001")
    expect(csvOf(files, 'openings.csv')).toHaveLength(1)
    const note = holdings.find((r) => r['Holding ID'] === seededHoldingId)?.['Notes']
    expect(note).toBe(`'${NOTE_RAW}`) // documented CSV-only prefix; CRLF and quote survive intact
    const purchaseLine = csvOf(files, 'purchase_lines.csv').find(
      (r) => r['Description'] === "'+TOPLOADER",
    )
    expect(purchaseLine).toBeDefined()
    expect(csvOf(files, 'sales.csv').some((r) => r['Marketplace'] === `'=Finn "torget"`)).toBe(true)
    expect(csvOf(files, 'purchases.csv').some((r) => r['Retailer'] === "'-Local Store")).toBe(true)
  })
})

describe('P157 account isolation of the files', () => {
  it("none of B's rows or markers appear in A's CSV or JSON", async () => {
    const snapshot = await fetchExportSnapshot(clientA)
    const csvText = buildCsvSuite(projectionInputFromSnapshot(snapshot))
      .map((f) => f.text)
      .join('\n')
    const json = serializeBackupEnvelope(
      buildBackupEnvelope(snapshot, { exportedAt: '2026-09-20T00:00:00.000Z', appVersion: 'p157' }),
    )
    const bHoldings = await dbRows('holdings', 'id', userB.id)
    expect(bHoldings.length).toBeGreaterThan(0)
    for (const haystack of [csvText, json]) {
      expect(haystack).not.toContain(B_MARKER)
      expect(haystack).not.toContain(userB.id)
      for (const h of bHoldings) expect(haystack).not.toContain(h['id'] as string)
    }
    expect(json).not.toContain(userA.email) // no account email in the backup either
  })

  it('repeated exports of unchanged data are byte-identical', async () => {
    const first = (await exportCsvAs(clientA)).map((f) => f.text)
    const second = (await exportCsvAs(clientA)).map((f) => f.text)
    expect(second).toEqual(first)
  })

  it('the JSON backup keeps the RAW text and exact wire numbers; only the CSV is prefixed', async () => {
    const snapshot = await fetchExportSnapshot(clientA)
    const parsed = JSON.parse(
      serializeBackupEnvelope(
        buildBackupEnvelope(snapshot, {
          exportedAt: '2026-09-20T00:00:00.000Z',
          appVersion: 'p157',
        }),
      ),
    ) as { data: { holdings: Loose[]; acquisition_lots: Loose[] } }
    const holding = parsed.data.holdings.find((h) => h['id'] === seededHoldingId)
    expect(holding?.['notes']).toBe(NOTE_RAW) // no apostrophe in the lossless artifact
    const huge = parsed.data.acquisition_lots.find(
      (l) => l['unit_cost_basis_minor'] === '9007199254740993',
    )
    expect(huge?.['unit_cost_basis_nok_minor']).toBe('288230376151711744') // string, not a number
  })

  it('an account switch in the middle of pagination fails the export — nothing is kept', async () => {
    // Real shared client: A signs in, then B signs in on the SAME client between two requests
    // (what a second tab does through shared session storage).
    let restRequests = 0
    let switched = false
    let swap: (() => Promise<unknown>) | null = null
    const baseFetch = globalThis.fetch
    const switching = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const isRest = urlOf(input).includes('/rest/v1/')
      if (isRest) restRequests++
      if (isRest && restRequests === 6 && !switched && swap) {
        switched = true
        await swap()
      }
      return baseFetch(input, init)
    }) as typeof fetch
    const client = await signInClient(userA, { fetchImpl: switching })
    swap = () => client.auth.signInWithPassword({ email: userB.email, password: userB.password })
    const outcome = await fetchExportSnapshot(client, { pageSize: 1 }).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error }),
    )
    expect(switched).toBe(true)
    expect('snapshot' in outcome).toBe(false)
    expect((outcome as { error: unknown }).error).toBeInstanceOf(AuthIdentityChangedError)
  })
})

describe('P157 failure, cancellation and side effects', () => {
  it('a network failure on any request rejects — no partial file', async () => {
    for (const failAt of [1, 12]) {
      let restRequests = 0
      const baseFetch = globalThis.fetch
      // The outage persists from request N onward: postgrest-js retries a single failed GET, so
      // one dropped request is (correctly) survived — a sustained outage must reject.
      const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).includes('/rest/v1/') && ++restRequests >= failAt) {
          throw new TypeError('fetch failed (injected)')
        }
        return baseFetch(input, init)
      }) as typeof fetch
      const client = await signInClient(userA, { fetchImpl: flaky })
      await expect(
        fetchExportSnapshot(client, { pageSize: 2 }),
        `fail at ${String(failAt)}`,
      ).rejects.toThrow()
    }
  }, 120_000)

  it('a failing PAGE request (counts succeed) rejects — never a partial-success snapshot', async () => {
    let pageRequests = 0
    const baseFetch = globalThis.fetch
    // A burst of data-page failures (GET with a row window; postgrest-js retries a failed GET, so
    // several in a row are needed); counts and auth keep working, so the export gets as far as
    // reading pages and must still refuse to finish.
    const flakyPages = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (
        method === 'GET' &&
        urlOf(input).includes('limit=') &&
        ++pageRequests >= 2 &&
        pageRequests <= 6
      ) {
        throw new TypeError('fetch failed (injected page outage)')
      }
      return baseFetch(input, init)
    }) as typeof fetch
    const client = await signInClient(userA, { fetchImpl: flakyPages })
    await expect(fetchExportSnapshot(client, { pageSize: 2 })).rejects.toThrow()
    expect(pageRequests).toBeGreaterThanOrEqual(2)
  }, 120_000)

  it('a cancelled export stops issuing requests', async () => {
    const controller = new AbortController()
    let requests = 0
    const baseFetch = globalThis.fetch
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).includes('/rest/v1/') && ++requests === 3) controller.abort()
      return baseFetch(input, init)
    }) as typeof fetch
    const client = await signInClient(userA, { fetchImpl: counting })
    await expect(
      fetchExportSnapshot(client, { pageSize: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const atAbort = requests
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(requests).toBe(atAbort) // nothing was issued after the cancellation was observed
  })

  it('an export performs no backend write: read-only HTTP and unchanged rows', async () => {
    const wire: WireCapture[] = []
    const baseFetch = globalThis.fetch
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      wire.push({ method: (init?.method ?? 'GET').toUpperCase(), url: urlOf(input) })
      return baseFetch(input, init)
    }) as typeof fetch
    const client = await signInClient(userA, { fetchImpl: recording })
    wire.length = 0
    const fingerprint = async () =>
      JSON.stringify(
        await Promise.all(
          ['purchases', 'sales', 'holdings', 'acquisition_lots', 'sale_lines'].map(async (t) => {
            const { data } = await service
              .from(t)
              .select('*', { count: 'exact' })
              .eq('user_id', userA.id)
              .order('id')
            return data
          }),
        ),
      )
    const before = await fingerprint()
    await exportCsvAs(client)
    expect(await fingerprint()).toBe(before)
    const writes = wire.filter(
      (r) => r.url.includes('/rest/v1/') && !['GET', 'HEAD'].includes(r.method),
    )
    expect(writes).toEqual([])
    expect(wire.length).toBeGreaterThan(20)
    // The only non-REST calls are the session reads (verified user / session), never a mutation
    // of account state.
    const nonRest = wire.filter((r) => !r.url.includes('/rest/v1/'))
    expect(nonRest.every((r) => r.method === 'GET' && r.url.includes('/auth/v1/user'))).toBe(true)
  })
})
