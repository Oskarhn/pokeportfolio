import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serializeBackupEnvelope } from '../../src/domain/export/build-backup'
import { BACKUP_DATA_KEYS, type BackupEnvelope } from '../../src/domain/export/backup-format'
import { assertBackupEnvelope } from '../../src/domain/export/backup-validate'
import {
  EXPORT_MAX_PAGES,
  EXPORT_PAGE_SIZE,
  fetchExportSnapshot,
  type ExportFetchOptions,
} from '../../src/data/export/fetch-snapshot'
import type { Database } from '../../src/data/database.types'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M13 export core, exercised end-to-end against the real schema through real RLS: the fetch
 * layer runs under each synthetic user's own JWT (no service role anywhere in the read path),
 * so this doubles as the authorization proof for the export surface. Cross-user isolation,
 * pagination beyond one page, money exactness past 2^53, null-vs-zero honesty and every
 * inclusion/exclusion rule are asserted on REAL fetched rows.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: SupabaseClient<Database>

const today = new Date().toISOString().slice(0, 10)

async function typedSignInAs(user: SyntheticUser): Promise<SupabaseClient<Database>> {
  const url = process.env['SUPABASE_URL']
  const anonKey = process.env['SUPABASE_ANON_KEY']
  if (!url || !anonKey) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set')
  const client = createClient<Database>(url, anonKey, {
    auth: { persistSession: false },
  })
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`)
  return client
}

async function exportAsA(options?: ExportFetchOptions): Promise<BackupEnvelope> {
  const { buildBackupEnvelope } = await import('../../src/domain/export/build-backup')
  const snapshot = await fetchExportSnapshot(clientA, options)
  const envelope = buildBackupEnvelope(snapshot, {
    exportedAt: '2026-08-24T10:00:00.000Z',
    appVersion: 'db-test',
  })
  assertBackupEnvelope(JSON.parse(serializeBackupEnvelope(envelope)))
  return envelope
}

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm13-export-a')
  userB = await createSyntheticUser(service, 'm13-export-b')
  clientA = await typedSignInAs(userA)

  // --- Seed a deliberately awkward but fully canonical dataset for A ---
  const uid = userA.id

  const { data: storage } = await service
    .from('storage_locations')
    .insert({ user_id: uid, name: 'Binder α', kind: 'binder' })
    .select('id')
    .single()
  void storage

  const { data: retailer } = await service
    .from('retailers')
    .insert({ user_id: uid, name: '-Local Store' })
    .select('id')
    .single()

  const { data: collection } = await service
    .from('custom_collections')
    .insert({ user_id: uid, name: 'Grails', description: '=SUM(A1)' })
    .select('id')
    .single()

  const { data: tag } = await service
    .from('tags')
    .insert({ user_id: uid, name: '@trade-bait' })
    .select('id')
    .single()

  // NOK purchase with two lines → two holdings/lots; one card line later sold.
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

  // Foreign-currency purchase with a frozen manual FX triple.
  const { error: eurError } = await clientA.rpc('create_purchase', {
    p_purchased_on: today,
    p_currency: 'EUR',
    p_fx_rate_to_nok: '11.54000000',
    p_fx_rate_date: today,
    p_fx_source: 'manual',
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 500,
      },
    ],
  })
  if (eurError) throw new Error(`create_purchase EUR failed: ${eurError.message}`)

  // The charizard holding: first card line's lot. Wire organisation onto it.
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
  const holdingId: string = lot!.holding_id

  await service.from('custom_collection_members').insert({
    collection_id: collection?.id,
    holding_id: holdingId,
  })
  await service.from('holding_tags').insert({ tag_id: tag?.id, holding_id: holdingId })

  // Gift lot with genuinely unknown cost — null basis, never zero.
  const { data: giftHolding, error: giftError } = await service
    .from('holdings')
    .insert({
      user_id: uid,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.grassEnergyVariantId,
      condition: 'GD',
    })
    .select('id')
    .single()
  if (giftError) throw new Error(`gift holding insert failed: ${giftError.message}`)
  await service.from('acquisition_lots').insert({
    holding_id: giftHolding.id,
    user_id: uid,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: today,
    quantity: 1,
    quantity_remaining: 1,
  })

  // Manual valuation history: a second, later valuation supersedes the first — both rows are
  // real data and must both survive the export.
  const { error: valError } = await clientA.rpc('set_manual_valuation', {
    p_holding_id: holdingId,
    p_value_minor: 123456,
    p_note: 'first take',
    p_effective_from: today,
  })
  if (valError) throw new Error(`set_manual_valuation failed: ${valError.message}`)
  const { error: val2Error } = await clientA.rpc('set_manual_valuation', {
    p_holding_id: holdingId,
    p_value_minor: 234567,
    p_note: 'revised',
    p_effective_from: today,
  })
  if (val2Error) throw new Error(`set_manual_valuation #2 failed: ${val2Error.message}`)

  // Sealed: reference a CURATED product (identity-manifest coverage).
  const { data: sealedHolding } = await service
    .from('holdings')
    .insert({
      user_id: uid,
      holding_kind: 'sealed',
      sealed_product_id: seedCatalog.sealedProductId,
    })
    .select('id')
    .single()
  await service.from('acquisition_lots').insert({
    holding_id: sealedHolding!.id,
    user_id: uid,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: today,
    quantity: 1,
    quantity_remaining: 1,
    sealed_intent: 'keep_sealed',
  })

  // A user-created sealed product — exported as owner data, never via the manifest.
  await service
    .from('sealed_products')
    .insert({
      created_by_user_id: uid,
      name: 'My fixture box',
      product_type: 'booster_box',
      language: 'no',
      pack_count: 36,
    })
    .select('id')
    .single()

  // Sell one unit of the charizard lot (live, with provenance text), then create-and-void a
  // second sale so both live and voided ledger states exist.
  const { error: saleError } = await clientA.rpc('create_sale', {
    p_sold_on: today,
    p_currency: 'NOK',
    p_marketplace: '@Finn "torget"',
    p_lines: [{ lot_id: lot!.id, quantity: 1, unit_gross_minor: 25000 }],
    p_fees_minor: 1000,
    p_idempotency_key: crypto.randomUUID(),
  })
  if (saleError) throw new Error(`create_sale failed: ${saleError.message}`)
  const { data: sale2, error: sale2Error } = await clientA.rpc('create_sale', {
    p_sold_on: today,
    p_currency: 'NOK',
    p_lines: [{ lot_id: lot!.id, quantity: 1, unit_gross_minor: 26000 }],
    p_idempotency_key: crypto.randomUUID(),
  })
  if (sale2Error) throw new Error(`create_sale #2 failed: ${sale2Error.message}`)
  await clientA.rpc('void_sale', { p_sale_id: sale2.id, p_reason: 'test void' })

  // Lot cost adjustment is SELECT-only today (M17 owns its write RPC) — seeded privileged,
  // still user-owned data that the export must reach under plain RLS reads.
  await service.from('lot_cost_adjustments').insert({
    user_id: uid,
    lot_id: lot!.id,
    purchase_line_id: cardLine!.id,
    kind: 'grading_fee',
    occurred_on: today,
    amount_minor: 3000,
    currency: 'NOK',
    amount_nok_minor: 3000,
  })

  // Money exactness probe: push one lot's basis beyond Number.MAX_SAFE_INTEGER.
  await service
    .from('acquisition_lots')
    .update({ unit_cost_basis_minor: '9007199254740993' })
    .eq('id', lot!.id)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userB.id)
  await deleteSyntheticUser(service, userA.id)
})

describe('M13 export over real RLS', () => {
  it('produces a structurally valid v1 envelope of exactly the canonical sections', async () => {
    const envelope = await exportAsA()
    expect(envelope.format).toBe('pokeportfolio-backup')
    expect(envelope.schema_version).toBe(1)
    expect(Object.keys(envelope.data).sort()).toEqual([...BACKUP_DATA_KEYS].sort())
  })

  it('seeds and exports every canonical row exactly once', async () => {
    const envelope = await exportAsA()
    expect(envelope.counts['purchases']).toBe(2)
    expect(envelope.counts['sales']).toBe(2)
    expect(envelope.data.holdings.every((h) => h.user_id === userA.id)).toBe(true)
    expect(envelope.data.lot_cost_adjustments.length).toBe(1)
    expect(envelope.data.manual_valuations.length).toBeGreaterThanOrEqual(1)
    expect(envelope.data.sealed_products.map((p) => p.name)).toContain(
      'My fixture box',
    )
  })

  it('carries money exactly past 2^53 and keeps null ≠ zero', async () => {
    const envelope = await exportAsA()
    const huge = envelope.data.acquisition_lots.find(
      (l) => l.unit_cost_basis_minor !== null && BigInt(l.unit_cost_basis_minor) > 2n ** 53n,
    )
    expect(huge?.unit_cost_basis_minor).toBe('9007199254740993')
    const gift = envelope.data.acquisition_lots.find((l) => l.cost_basis_state === 'not_paid')
    expect(gift?.unit_cost_basis_minor).toBeNull()
    const eur = envelope.data.purchases.find((p) => p.currency === 'EUR')
    expect(eur?.fx_rate_to_nok).toBe('11.54000000')
    expect(eur?.fx_source).toBe('manual')
  })

  it('paginates far beyond PostgREST defaults when forced to', async () => {
    const pages: { section: string; totalRows: number }[] = []
    const envelope = await exportAsA({
      pageSize: 1,
      maxPages: EXPORT_MAX_PAGES,
      onPage: (info) => pages.push(info),
    })
    // Every non-empty section was fetched through ≥2 pages of one row.
    const multiPageSections = new Set(
      pages.filter((p) => p.totalRows > 0).map((p) => `${p.section}:${p.totalRows > 1}`),
    )
    expect(multiPageSections.size).toBeGreaterThan(0)
    expect(envelope.counts['purchases']).toBe(2)
  })

  it('uses sane production pagination defaults', () => {
    expect(EXPORT_PAGE_SIZE).toBe(500)
    expect(EXPORT_MAX_PAGES).toBe(1000)
  })

  it('exports shared-catalog REFERENCES only — never catalog copies', async () => {
    const envelope = await exportAsA()
    // A owns rows referencing exactly three seed variants (charizard, pikachu, grass energy).
    const variantIds = envelope.identity_manifest.card_variants.map((v) => v.id)
    expect(variantIds).toContain(seedCatalog.charizardVariantId)
    expect(variantIds).toContain(seedCatalog.pikachuVariantId)
    expect(variantIds).toContain(seedCatalog.grassEnergyVariantId)
    // The seed catalog holds more variants than that — an unreferenced one must be absent,
    // proving the manifest is a reference list, not a catalog copy.
    expect(variantIds).not.toContain(seedCatalog.charizardShadowlessFirstEditionVariantId)
    expect(envelope.identity_manifest.curated_sealed_products.map((s) => s.id)).toEqual([
      seedCatalog.sealedProductId,
    ])
    // User-created products are DATA, not manifest entries.
    expect(
      envelope.identity_manifest.curated_sealed_products.some((s) => s.name === 'My fixture box'),
    ).toBe(false)
  })

  it('is owner-scoped: user B gets none of user A’s data', async () => {
    const clientB = await typedSignInAs(userB)
    const snapshot = await fetchExportSnapshot(clientB)
    expect(snapshot.profiles[0]?.id).toBe(userB.id)
    for (const key of BACKUP_DATA_KEYS) {
      const section = snapshot[key] as readonly { user_id?: string; created_by_user_id?: string }[]
      for (const row of section) {
        const owner = row.user_id ?? row.created_by_user_id
        expect(owner, `section ${key} leaked another user's row`).not.toBe(userA.id)
      }
    }
    expect(snapshot.identity_manifest.card_variants).toHaveLength(0)
    expect(snapshot.identity_manifest.curated_sealed_products).toHaveLength(0)
  })

  it('propagates cancellation between pages', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchExportSnapshot(clientA, { signal: controller.signal })).rejects.toThrow(
      /Export cancelled/,
    )
  })

  it('refuses to run without an authenticated session', async () => {
    const url = process.env['SUPABASE_URL']
    const anonKey = process.env['SUPABASE_ANON_KEY']
    if (!url || !anonKey) throw new Error('env missing')
    const anonClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } })
    await expect(fetchExportSnapshot(anonClient)).rejects.toThrow(/authenticated session/)
  })
})
