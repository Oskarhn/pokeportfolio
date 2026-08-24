import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createServiceClient, createSyntheticUser, deleteSyntheticUser } from './setup'
import type { SyntheticUser, TestClient } from './setup'

/**
 * M13 export performance audit (prompt §24) — D-059-style single generous threshold.
 *
 * Opt-in via environment so it never runs in the standard suites:
 *
 *   M13_EXPORT_PERF=1 pnpm exec vitest run --config vitest.db.config.ts tests/db/m13_export_perf.test.ts
 *
 * Seeds one synthetic account at the documented target scale — ~10,000 acquisition lots over
 * ~10,000 holdings plus purchases, sales with frozen bases, disposal history and valuation
 * history — then times the REAL client-side export pipeline under the owner's own JWT:
 * fetchExportSnapshot → buildBackupEnvelope → serializeBackupEnvelope. Reports duration,
 * PostgREST request count, page count and artifact size. Fails only past a catastrophic
 * 60-second budget (TESTING.md §7 policy), never on a tight race.
 *
 * SAFETY: ephemeral/local stack or throwaway synthetic account only — never a project holding
 * real data. The account is deleted on exit, success or failure.
 */

const RUN = process.env['M13_EXPORT_PERF'] === '1' && Boolean(process.env['SUPABASE_URL'])

const LOTS = 10_000
const SOLD = 2_000
const VALUATION_HOLDINGS = 2_000
const PURCHASES = 250
const CATASTROPHIC_MS = 60_000

let service: TestClient
let user: SyntheticUser

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

async function insertBatches(
  client: TestClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (const batch of chunk(rows, 1000)) {
    const { error } = await client.from(table).insert(batch)
    if (error !== null) throw new Error(`seeding ${table}: ${error.message}`)
  }
}

async function allIds(client: TestClient, table: string, userId: string): Promise<string[]> {
  const ids: string[] = []
  // Bounded reads over the service client purely to collect seeded ids for FK wiring.
  for (let from = 0; ; from += 5000) {
    const { data } = await client
      .from(table)
      .select('id')
      .eq('user_id', userId)
      .order('created_at')
      .range(from, from + 4999)
    const rows = (data ?? []) as { id: string }[]
    ids.push(...rows.map((r) => r.id))
    if (rows.length < 5000) break
  }
  return ids
}

describe.skipIf(!RUN)('M13 export performance audit', () => {
  beforeAll(async () => {
    service = createServiceClient()
    user = await createSyntheticUser(service, 'm13-perf')

    await insertBatches(service, 'storage_locations', [
      { user_id: user.id, name: 'Binder A', kind: 'binder' },
      { user_id: user.id, name: 'Box B', kind: 'box' },
    ])
    const locations = await allIds(service, 'storage_locations', user.id)

    const purchaseRows = Array.from({ length: PURCHASES }, (_, i) => ({
      user_id: user.id,
      origin: 'manual',
      purchased_on: '2026-01-15',
      currency: 'NOK',
      subtotal_minor: 40_000,
      shipping_minor: 5_000,
      customs_minor: 0,
      discount_minor: 0,
      total_minor: 45_000,
      fx_rate_to_nok: 1,
      fx_rate_date: '2026-01-15',
      fx_source: 'manual',
      total_nok_minor: 45_000,
      notes: i % 25 === 0 ? '=SUM(A1:A9) hostile note' : null,
    }))
    await insertBatches(service, 'purchases', purchaseRows)
    const purchaseIds = await allIds(service, 'purchases', user.id)

    const purchaseLineRows = purchaseIds.flatMap((pid) => [
      {
        purchase_id: pid,
        user_id: user.id,
        line_type: 'card',
        spend_class: 'collectible',
        description: 'Seeded line A',
        condition: 'NM',
        quantity: 20,
        unit_price_minor: 1_000,
        line_total_minor: 20_000,
        allocated_shipping_minor: 2_500,
        attributable_cost_minor: 22_500,
        attributable_cost_nok_minor: 22_500,
      },
      {
        purchase_id: pid,
        user_id: user.id,
        line_type: 'card',
        spend_class: 'collectible',
        description: 'Seeded line B',
        condition: 'EX',
        quantity: 20,
        unit_price_minor: 1_000,
        line_total_minor: 20_000,
        allocated_shipping_minor: 2_500,
        attributable_cost_minor: 22_500,
        attributable_cost_nok_minor: 22_500,
      },
    ])
    await insertBatches(service, 'purchase_lines', purchaseLineRows)

    // One manual card per holding keeps identity unique without catalog dependencies; the
    // export path treats these rows exactly like any other canonical row.
    const cardRows = Array.from({ length: LOTS }, (_, i) => ({
      user_id: user.id,
      name: `Perf Card ${String(i).padStart(5, '0')}`,
      set_name: 'Perf Set',
      collector_number: String(i),
      language: 'en',
      finish: 'normal',
      notes: i % 100 === 0 ? '+cmd leading trigger' : null,
    }))
    await insertBatches(service, 'manual_card_definitions', cardRows)
    const cardIds = await allIds(service, 'manual_card_definitions', user.id)

    await insertBatches(
      service,
      'holdings',
      cardIds.map((cid, i) => ({
        user_id: user.id,
        holding_kind: 'raw_card',
        manual_card_id: cid,
        grading_state: 'raw',
        is_favorite: i % 7 === 0,
        notes: i % 50 === 0 ? '＝full-width trigger' : null,
      })),
    )
    const holdingIds = await allIds(service, 'holdings', user.id)

    await insertBatches(
      service,
      'acquisition_lots',
      holdingIds.map((hid) => ({
        user_id: user.id,
        holding_id: hid,
        origin: 'gift',
        cost_basis_state: 'not_paid',
        acquired_on: '2026-01-20',
        quantity: 1,
        quantity_remaining: 1,
        residual_minor: 0,
        storage_location_id: locations[0],
      })),
    )
    const lotIds = await allIds(service, 'acquisition_lots', user.id)

    // Sales dispose the first SOLD lots; formulas satisfy the DB's own CHECK constraints
    // (net = gross − fees − shipping_cost + charged; NOK frozen at rate 1).
    const soldLotIds = lotIds.slice(0, SOLD)
    const saleRows = soldLotIds.map(() => ({
      user_id: user.id,
      sold_on: '2026-02-20',
      marketplace: 'Finn',
      currency: 'NOK',
      gross_minor: 15_000,
      fees_minor: 360,
      shipping_cost_minor: 6_400,
      shipping_charged_minor: 5_000,
      net_proceeds_minor: 13_240,
      fx_rate_to_nok: 1,
      fx_rate_date: '2026-02-20',
      fx_source: 'manual',
      net_proceeds_nok_minor: 13_240,
      realized_result_nok_minor: 8_630,
      proceeds_from_uncosted_nok_minor: 0,
      idempotency_key: randomUUID(),
    }))
    await insertBatches(service, 'sales', saleRows)
    const saleIds = await allIds(service, 'sales', user.id).then((ids) => ids.slice(0, SOLD))

    const saleLineRows = saleIds.map((sid, i) => ({
      sale_id: sid,
      user_id: user.id,
      lot_id: soldLotIds[i],
      quantity: 1,
      unit_gross_minor: 15_000,
      line_gross_minor: 15_000,
      allocated_fees_minor: 360,
      allocated_shipping_minor: 1_400,
      net_proceeds_minor: 13_240,
      net_proceeds_nok_minor: 13_240,
      cost_basis_at_sale_nok_minor: 4_610,
      realized_result_nok_minor: 8_630,
    }))
    await insertBatches(service, 'sale_lines', saleLineRows)
    const saleLineIds = (
      ((await service.from('sale_lines').select('id').eq('user_id', user.id)).data ?? []) as {
        id: string
      }[]
    ).map((r) => r.id)

    await insertBatches(
      service,
      'lot_disposals',
      saleLineIds.map((slid, i) => ({
        user_id: user.id,
        lot_id: soldLotIds[i],
        kind: 'sale',
        quantity: 1,
        disposed_on: '2026-02-20',
        sale_line_id: slid,
        cost_basis_at_disposal_nok_minor: 4_610,
      })),
    )

    const valuationRows = holdingIds.slice(0, VALUATION_HOLDINGS).flatMap((hid) => [
      {
        user_id: user.id,
        holding_id: hid,
        value_minor: 12_000,
        currency: 'NOK',
        value_nok_minor: 12_000,
        effective_from: '2026-03-01',
        note: 'superseded',
      },
      {
        user_id: user.id,
        holding_id: hid,
        value_minor: 13_500,
        currency: 'NOK',
        value_nok_minor: 13_500,
        effective_from: '2026-04-01',
        note: null,
      },
    ])
    await insertBatches(service, 'manual_valuations', valuationRows)
  }, 600_000)

  afterAll(async () => {
    // service/user are always assigned here: skipIf gates the whole suite before beforeAll runs.
    await deleteSyntheticUser(service, user.id)
  }, 120_000)

  it('exports ~10k lots inside the catastrophic budget and reports real numbers', async () => {
    const url = process.env['SUPABASE_URL']
    const anonKey = process.env['SUPABASE_ANON_KEY']
    if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set')
    const { createClient } = await import('@supabase/supabase-js')
    const browserClient = createClient(url, anonKey, { auth: { persistSession: false } })
    const { error } = await browserClient.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    })
    if (error) throw new Error(`sign-in failed: ${error.message}`)

    const { fetchExportSnapshot } = await import('../../src/data/export/fetch-snapshot')
    const { buildBackupEnvelope, serializeBackupEnvelope } =
      await import('../../src/domain/export/build-backup')

    let pagesLanded = 0
    let requestCount = 0 // one COUNT per section + one per landed page + manifest chunks
    const started = Date.now()
    const snapshot = await fetchExportSnapshot(browserClient as never, {
      onPage: () => {
        pagesLanded += 1
        requestCount += 1
      },
    })
    const envelope = buildBackupEnvelope(snapshot, {
      exportedAt: new Date().toISOString(),
      appVersion: 'perf-audit',
    })
    const text = serializeBackupEnvelope(envelope)
    const totalMs = Date.now() - started

    const sections = Object.entries(snapshot).filter(([, v]) => Array.isArray(v)) as [
      string,
      unknown[],
    ][]
    requestCount += sections.length // the COUNT query each section walk takes up front

    console.log(
      `[m13-export-perf] total=${totalMs}ms fetch+build+serialize; ` +
        `pages=${String(pagesLanded)}; approxRequests=${String(requestCount)}; ` +
        `jsonBytes=${String(text.length)} (~${String(Math.round(text.length / 1024))} KB); ` +
        `lots=${String((snapshot.acquisition_lots as unknown[]).length)}; ` +
        `holdings=${String((snapshot.holdings as unknown[]).length)}; ` +
        `sales=${String((snapshot.sales as unknown[]).length)}; ` +
        `disposals=${String((snapshot.lot_disposals as unknown[]).length)}; ` +
        `valuations=${String((snapshot.manual_valuations as unknown[]).length)}`,
    )

    expect(totalMs, `export completed within ${CATASTROPHIC_MS}ms`).toBeLessThan(CATASTROPHIC_MS)
    expect((snapshot.acquisition_lots as unknown[]).length).toBe(LOTS)
    expect((snapshot.sales as unknown[]).length).toBe(SOLD)
  }, 300_000)
})
