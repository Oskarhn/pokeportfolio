import { seedCatalog } from '../setup'
import type { SyntheticUser, TestClient } from '../setup'

/**
 * P152: a synthetic user that owns at least one row in EVERY user-owned table, built through the
 * same RPCs the product uses (create_purchase, create_sale, create_opening,
 * add_card_acquisition, set_manual_valuation) plus service-role inserts only where no RPC exists.
 * Everything is invented and `.invalid`; nothing here resembles a real collection.
 *
 * The account-deletion suites need this because the bug being fixed lived precisely in the tables
 * the older cleanup fixtures never populated together: a user with a SALE, a lot disposal, a cost
 * adjustment and a private sealed product could not be deleted at all.
 */

/**
 * Every table that carries an owner, with the column that names it. Deliberately written out
 * rather than derived: tests/db/p152_account_deletion_graph.test.ts derives the same set from
 * pg_constraint independently and fails if the two disagree, so a table added in a later milestone
 * cannot be forgotten by both the purge and this list.
 */
export const USER_OWNED_TABLES: readonly { table: string; column: string }[] = [
  { table: 'retailers', column: 'user_id' },
  { table: 'storage_locations', column: 'user_id' },
  { table: 'tags', column: 'user_id' },
  { table: 'purchases', column: 'user_id' },
  { table: 'purchase_lines', column: 'user_id' },
  { table: 'holdings', column: 'user_id' },
  { table: 'acquisition_lots', column: 'user_id' },
  { table: 'manual_card_definitions', column: 'user_id' },
  { table: 'holding_tags', column: 'user_id' },
  { table: 'manual_valuations', column: 'user_id' },
  { table: 'custom_collections', column: 'user_id' },
  { table: 'custom_collection_members', column: 'user_id' },
  { table: 'sales', column: 'user_id' },
  { table: 'sale_lines', column: 'user_id' },
  { table: 'lot_disposals', column: 'user_id' },
  { table: 'lot_cost_adjustments', column: 'user_id' },
  { table: 'openings', column: 'user_id' },
  { table: 'sealed_products', column: 'created_by_user_id' },
  { table: 'portfolio_snapshots', column: 'user_id' },
  { table: 'portfolio_recompute_queue', column: 'user_id' },
  { table: 'invitation_redemptions', column: 'user_id' },
  { table: 'profiles', column: 'id' },
]

export type OwnedCounts = Record<string, number>

/** Row count per owned table for one user, read with the service role. */
export async function countOwnedRows(service: TestClient, userId: string): Promise<OwnedCounts> {
  const counts: OwnedCounts = {}
  for (const { table, column } of USER_OWNED_TABLES) {
    const { count, error } = await service
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, userId)
    if (error) throw new Error(`counting ${table}: ${error.message}`)
    counts[table] = count ?? 0
  }
  return counts
}

/** Row counts of the shared tables a deletion must never touch. */
export async function countSharedRows(service: TestClient): Promise<Record<string, number>> {
  const shared = [
    'card_series',
    'card_sets',
    'cards',
    'card_variants',
    'fx_rates',
    'price_snapshots',
  ]
  const counts: Record<string, number> = {}
  for (const table of shared) {
    const { count, error } = await service.from(table).select('*', { count: 'exact', head: true })
    if (error) throw new Error(`counting ${table}: ${error.message}`)
    counts[table] = count ?? 0
  }
  const catalogSealed = await service
    .from('sealed_products')
    .select('*', { count: 'exact', head: true })
    .is('created_by_user_id', null)
  if (catalogSealed.error) throw new Error(catalogSealed.error.message)
  counts['sealed_products(shared)'] = catalogSealed.count ?? 0
  return counts
}

export interface SeededLedger {
  userId: string
  displayName: string
  privateSealedProductId: string
  purchaseId: string
  saleId: string
  openingId: string
  invitationId: string
}

const today = (): string => new Date().toISOString().slice(0, 10)

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null) {
    throw new Error(`fixture: ${what} failed: ${result.error?.message ?? 'no data'}`)
  }
  return result.data
}

export async function seedAccountLedger(
  service: TestClient,
  user: SyntheticUser,
  client: TestClient,
  label: string,
): Promise<SeededLedger> {
  const displayName = `Synthetic ${label}`
  must(
    await service
      .from('profiles')
      .update({ display_name: displayName })
      .eq('id', user.id)
      .select('id')
      .single(),
    'profile display name',
  )

  const retailer = must(
    await service
      .from('retailers')
      .insert({ user_id: user.id, name: `Retailer ${label}` })
      .select('id')
      .single<{ id: string }>(),
    'retailer',
  )
  const location = must(
    await service
      .from('storage_locations')
      .insert({ user_id: user.id, name: `Binder ${label}`, kind: 'binder' })
      .select('id')
      .single<{ id: string }>(),
    'storage location',
  )
  must(
    await service
      .from('profiles')
      .update({ default_storage_location_id: location.id })
      .eq('id', user.id)
      .select('id')
      .single(),
    'profile default storage location',
  )
  const tag = must(
    await service
      .from('tags')
      .insert({ user_id: user.id, name: `Tag ${label}` })
      .select('id')
      .single<{ id: string }>(),
    'tag',
  )
  const collection = must(
    await service
      .from('custom_collections')
      .insert({ user_id: user.id, name: `Collection ${label}` })
      .select('id')
      .single<{ id: string }>(),
    'custom collection',
  )
  const privateSealed = must(
    await service
      .from('sealed_products')
      .insert({
        name: `Private box ${label} ${crypto.randomUUID()}`,
        language: 'en',
        product_type: 'booster_pack',
        created_by_user_id: user.id,
      })
      .select('id')
      .single<{ id: string }>(),
    'private sealed product',
  )

  // A purchase with two card lines, one sealed line and a shipping split: three lots.
  const purchase = must(
    await client
      .rpc('create_purchase', {
        p_purchased_on: today(),
        p_currency: 'NOK',
        p_retailer_id: retailer.id,
        p_shipping_minor: 300,
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.pikachuVariantId,
            condition: 'NM',
            quantity: 3,
            unit_price_minor: 10_000,
          },
          {
            line_type: 'card',
            card_variant_id: seedCatalog.charizardVariantId,
            condition: 'LP',
            quantity: 1,
            unit_price_minor: 50_000,
          },
          {
            line_type: 'sealed',
            sealed_product_id: privateSealed.id,
            quantity: 2,
            unit_price_minor: 5_000,
          },
        ],
      })
      .single<{ id: string }>(),
    'create_purchase',
  )

  const lines = must(
    await service
      .from('purchase_lines')
      .select('id, line_type, card_variant_id')
      .eq('purchase_id', purchase.id),
    'purchase lines',
  ) as { id: string; line_type: string; card_variant_id: string | null }[]
  const lotFor = async (lineId: string) =>
    must(
      await service
        .from('acquisition_lots')
        .select('id, holding_id')
        .eq('purchase_line_id', lineId)
        .single<{ id: string; holding_id: string }>(),
      'lot for purchase line',
    )
  const pikachuLine = lines.find((l) => l.card_variant_id === seedCatalog.pikachuVariantId)!
  const sealedLine = lines.find((l) => l.line_type === 'sealed')!
  const pikachuLot = await lotFor(pikachuLine.id)
  const sealedLot = await lotFor(sealedLine.id)

  // Organisation rows bound to a holding.
  must(
    await service
      .from('holding_tags')
      .insert({ holding_id: pikachuLot.holding_id, tag_id: tag.id, user_id: user.id })
      .select('tag_id')
      .single(),
    'holding tag',
  )
  must(
    await service
      .from('custom_collection_members')
      .insert({
        collection_id: collection.id,
        holding_id: pikachuLot.holding_id,
        user_id: user.id,
      })
      .select('collection_id')
      .single(),
    'collection member',
  )

  // Manual card and a gifted lot for it.
  const manual = must(
    await service
      .from('manual_card_definitions')
      .insert({
        user_id: user.id,
        name: `Manual card ${label}`,
        set_name: 'Synthetic set',
        collector_number: '1',
        language: 'en',
        finish: 'normal',
      })
      .select('id')
      .single<{ id: string }>(),
    'manual card',
  )
  const manualAcq = await client.rpc('add_card_acquisition', {
    p_manual_card_id: manual.id,
    p_condition: 'NM',
    p_origin: 'gift',
    p_cost_basis_state: 'not_paid',
    p_quantity: 1,
    p_acquired_on: today(),
    p_storage_location_id: location.id,
  })
  if (manualAcq.error) throw new Error(`fixture: add_card_acquisition: ${manualAcq.error.message}`)

  // Manual valuations are only meaningful for graded/sealed holdings: value the sealed one.
  const valuation = await client.rpc('set_manual_valuation', {
    p_holding_id: sealedLot.holding_id,
    p_value_minor: 12_345,
    p_note: 'synthetic valuation',
    p_effective_from: today(),
  })
  if (valuation.error) throw new Error(`fixture: set_manual_valuation: ${valuation.error.message}`)

  // A sale of one Pikachu copy: sales + sale_lines + lot_disposals.
  const sale = must(
    await client
      .rpc('create_sale', {
        p_sold_on: today(),
        p_currency: 'NOK',
        p_idempotency_key: crypto.randomUUID(),
        p_fees_minor: 200,
        p_lines: [{ lot_id: pikachuLot.id, quantity: 1, unit_gross_minor: 15_000 }],
      })
      .single<{ id: string }>(),
    'create_sale',
  )

  // An opening of one sealed unit with a tracked pull: openings + opening-linked lots + disposal.
  const opening = must(
    await client
      .rpc('create_opening', {
        p_source_lot_id: sealedLot.id,
        p_quantity: 1,
        p_opened_on: today(),
        p_pulls: [
          { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 1, condition: 'NM' },
        ],
      })
      .single<{ id: string }>(),
    'create_opening',
  )

  // No RPC writes a cost adjustment yet (M17), so it is a direct service-role insert.
  must(
    await service
      .from('lot_cost_adjustments')
      .insert({
        lot_id: pikachuLot.id,
        user_id: user.id,
        kind: 'other',
        purchase_line_id: pikachuLine.id,
        amount_minor: 100,
        currency: 'NOK',
        amount_nok_minor: 100,
        occurred_on: today(),
      })
      .select('id')
      .single(),
    'lot cost adjustment',
  )

  // Derived cache rows.
  const rebuild = await service.rpc('rebuild_portfolio_snapshots', {
    p_user_id: user.id,
    p_from: today(),
    p_through: today(),
  })
  if (rebuild.error) throw new Error(`fixture: rebuild snapshots: ${rebuild.error.message}`)

  const redemption = must(
    await service
      .from('invitation_redemptions')
      .select('invitation_id')
      .eq('user_id', user.id)
      .single<{ invitation_id: string }>(),
    'invitation redemption',
  )

  return {
    userId: user.id,
    displayName,
    privateSealedProductId: privateSealed.id,
    purchaseId: purchase.id,
    saleId: sale.id,
    openingId: opening.id,
    invitationId: redemption.invitation_id,
  }
}
