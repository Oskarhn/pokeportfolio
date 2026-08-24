/**
 * Synthetic relational-completeness fixture (prompt section 6).
 *
 * Builds, for one synthetic user, ONE connected model exercising every canonical shape a future
 * restore author would need preserved:
 *
 *   holding with MULTIPLE acquisition lots (known-cost purchased lot + gift/not-paid lot)
 *   mixed purchase receipt (subtotal + shipping + customs - discount, EUR + frozen FX)
 *   stored shipping/customs/discount ALLOCATIONS on both purchase lines
 *   manual card definition holding (catalog gap card)
 *   user-created sealed product + sealed-intent holding
 *   storage location, tag, holding_tags edge, custom collection + membership edge
 *   manual valuation HISTORY (superseded row + active row)
 *   lot cost adjustment (grading fee; browser holds SELECT-only on this table)
 *   partial disposal from a multi-unit lot via a sale with FROZEN cost basis
 *   VOIDED correction purchase and a VOIDED sale with NULL basis/result pair
 *
 * Seeding runs through the service role because several tables have no browser write path by
 * design (lot_cost_adjustments) or need states the RPCs deliberately refuse to produce. The
 * cross-user suite separately proves the AUTHENTICATED client can READ every seeded table for
 * its own owner - which is the export-authority assumption M13 stands on.
 *
 * All arithmetic is exact by construction (database CHECKs re-verify at insert):
 *   receipt total      = 10000 + 2500 + 1500 - 500   = 13500
 *   line1 attributable = 6000 + 1500 + 750 - 250     = 8000
 *   line2 attributable = 7000 + 1000 + 750 - 250     = 8500
 *   FX frozen          = 11.52345678 (EUR->NOK, norges_bank)
 *   NOK figures        = round(orig*rate): 155567 / 92188 / 97949 / 46094
 *   sale NSP           = 120000 - 3600 - 6400 + 5000 = 115000
 *   frozen result      = 115000 - 46094              = 68906
 */

import type { TestClient } from '../../../tests/db/setup'
import { seedCatalog } from '../../../tests/db/setup'

export interface UserModelIds {
  retailerId: string
  storageLocationId: string
  tagId: string
  customCollectionId: string
  manualCardId: string
  sealedProductId: string
  purchaseId: string
  purchaseLineCardId: string
  purchaseLineSealedId: string
  voidedPurchaseId: string
  holdingId: string
  giftLotId: string
  purchasedLotId: string
  manualHoldingId: string
  sealedHoldingId: string
  activeValuationId: string
  supersededValuationId: string
  adjustmentId: string
  saleId: string
  saleLineId: string
  disposalId: string
  voidedSaleId: string
}

async function insertOne(
  service: TestClient,
  table: string,
  values: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await service.from(table).insert(values).select('id').single()
  if (error || !data) {
    throw new Error(`fixture insert into ${table} failed: ${error?.message ?? 'no row returned'}`)
  }
  return data.id as string
}

const DAY = 86_400_000

export async function seedCompleteUserModel(
  service: TestClient,
  userId: string,
  label: string,
): Promise<UserModelIds> {
  const now = Date.now()
  const iso = (offsetDays: number): string => new Date(now - offsetDays * DAY).toISOString()
  const dateOnly = (offsetDays: number): string => iso(offsetDays).slice(0, 10)

  // Reference rows; retailer notes carry an injection probe and Norwegian characters.
  const retailerId = await insertOne(service, 'retailers', {
    user_id: userId,
    name: `Adversarial Retailer ${label}`,
    notes: `=SUM(A1:A2) probe ${label} AE OE AA: \u00C6\u00D8\u00C5`,
  })
  const storageLocationId = await insertOne(service, 'storage_locations', {
    user_id: userId,
    name: `Binder A ${label}`,
    kind: 'binder',
  })
  const tagId = await insertOne(service, 'tags', { user_id: userId, name: `grail-${label}` })

  // Mixed receipt in EUR with the frozen FX triple.
  const purchaseId = await insertOne(service, 'purchases', {
    user_id: userId,
    origin: 'manual',
    purchased_on: dateOnly(30),
    retailer_id: retailerId,
    currency: 'EUR',
    subtotal_minor: 10_000,
    shipping_minor: 2_500,
    customs_minor: 1_500,
    discount_minor: 500,
    total_minor: 13_500,
    fx_rate_to_nok: '11.52345678',
    fx_rate_date: dateOnly(30),
    fx_source: 'norges_bank',
    total_nok_minor: 155_567,
    notes: `Mixed receipt ${label}`,
  })

  const purchaseLineCardId = await insertOne(service, 'purchase_lines', {
    purchase_id: purchaseId,
    user_id: userId,
    line_type: 'card',
    spend_class: 'collectible',
    description: 'Charizard x2',
    card_variant_id: seedCatalog.charizardVariantId,
    condition: 'NM',
    quantity: 2,
    unit_price_minor: 3_000,
    line_total_minor: 6_000,
    allocated_shipping_minor: 1_500,
    allocated_customs_minor: 750,
    allocated_discount_minor: 250,
    attributable_cost_minor: 8_000,
    attributable_cost_nok_minor: 92_188,
  })

  const purchaseLineSealedId = await insertOne(service, 'purchase_lines', {
    purchase_id: purchaseId,
    user_id: userId,
    line_type: 'sealed_product',
    spend_class: 'collectible',
    description: 'Booster box',
    sealed_product_id: seedCatalog.sealedProductId,
    quantity: 1,
    unit_price_minor: 7_000,
    line_total_minor: 7_000,
    allocated_shipping_minor: 1_000,
    allocated_customs_minor: 750,
    allocated_discount_minor: 250,
    attributable_cost_minor: 8_500,
    attributable_cost_nok_minor: 97_949,
  })

  // Voided correction purchase (void semantics are canonical history).
  const voidedPurchaseId = await insertOne(service, 'purchases', {
    user_id: userId,
    origin: 'manual',
    purchased_on: dateOnly(28),
    currency: 'NOK',
    subtotal_minor: 4_000,
    total_minor: 4_000,
    fx_rate_to_nok: 1,
    fx_rate_date: dateOnly(28),
    fx_source: 'manual',
    total_nok_minor: 4_000,
    voided_at: iso(27),
    notes: `Bought wrong item, corrected ${label}`,
  })

  // Core holding: raw card with TWO lots (purchased known-cost + gift not-paid).
  const holdingId = await insertOne(service, 'holdings', {
    user_id: userId,
    holding_kind: 'raw_card',
    card_variant_id: seedCatalog.charizardVariantId,
    condition: 'NM',
    grading_state: 'raw',
    storage_location_id: storageLocationId,
    is_favorite: true,
    notes: `Core holding ${label}`,
  })

  const purchasedLotId = await insertOne(service, 'acquisition_lots', {
    holding_id: holdingId,
    user_id: userId,
    origin: 'purchase',
    cost_basis_state: 'known',
    purchase_line_id: purchaseLineCardId,
    acquired_on: dateOnly(30),
    quantity: 3,
    quantity_remaining: 2,
    unit_cost_basis_minor: 4_000,
    cost_basis_currency: 'EUR',
    unit_cost_basis_nok_minor: 46_094,
    residual_minor: 0,
    notes: `Lot A ${label}`,
  })

  const giftLotId = await insertOne(service, 'acquisition_lots', {
    holding_id: holdingId,
    user_id: userId,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: dateOnly(20),
    quantity: 1,
    quantity_remaining: 1,
    notes: `Gift lot ${label}`,
  })

  // Manual card definition + its own holding.
  const manualCardId = await insertOne(service, 'manual_card_definitions', {
    user_id: userId,
    name: `Test Print Ultra Rare ${label}`,
    set_name: 'Unlisted Promo Set',
    collector_number: 'XXX/XXX',
    language: 'English',
    finish: 'holo',
    notes: 'Catalog gap card',
  })
  const manualHoldingId = await insertOne(service, 'holdings', {
    user_id: userId,
    holding_kind: 'raw_card',
    manual_card_id: manualCardId,
    condition: 'NM',
    grading_state: 'raw',
  })

  // User-created sealed product (NOT curated) + sealed-intent holding on it.
  const sealedProductId = await insertOne(service, 'sealed_products', {
    set_id: seedCatalog.cardSetId,
    product_type: 'elite_trainer_box',
    name: `User-Added ETB ${label}`,
    language: 'English',
    created_by_user_id: userId,
  })
  const sealedHoldingId = await insertOne(service, 'holdings', {
    user_id: userId,
    holding_kind: 'sealed',
    sealed_product_id: sealedProductId,
    grading_state: 'raw',
    sealed_intent: 'keep_sealed',
  })

  // Organisation edges.
  const customCollectionId = await insertOne(service, 'custom_collections', {
    user_id: userId,
    name: `Trade Binder ${label}`,
    description: 'Cards priced to move',
    sort_order: 3,
    color: '#33ff33',
  })
  const memberInsert = await service
    .from('custom_collection_members')
    .insert({ collection_id: customCollectionId, holding_id: holdingId, sort_order: 1 })
    .select('collection_id')
    .single()
  if (memberInsert.error) throw new Error(`membership insert failed: ${memberInsert.error.message}`)

  const tagJoin = await service
    .from('holding_tags')
    .insert({ holding_id: holdingId, tag_id: tagId, user_id: userId })
    .select('holding_id')
    .single()
  if (tagJoin.error) throw new Error(`holding_tag insert failed: ${tagJoin.error.message}`)

  // Manual valuation HISTORY: superseded row then active row.
  const supersededValuationId = await insertOne(service, 'manual_valuations', {
    user_id: userId,
    holding_id: manualHoldingId,
    value_minor: 50_000,
    effective_from: dateOnly(15),
    superseded_at: iso(10),
    note: `first guess ${label}`,
  })
  const activeValuationId = await insertOne(service, 'manual_valuations', {
    user_id: userId,
    holding_id: manualHoldingId,
    value_minor: 65_000,
    effective_from: dateOnly(10),
    note: `revised upward ${label}`,
  })

  // Grading-fee cost adjustment (browser has SELECT-only here; service seeds it).
  const adjustmentId = await insertOne(service, 'lot_cost_adjustments', {
    lot_id: purchasedLotId,
    user_id: userId,
    kind: 'grading_fee',
    purchase_line_id: purchaseLineCardId,
    amount_minor: 2_200,
    currency: 'EUR',
    amount_nok_minor: 25_352,
    occurred_on: dateOnly(14),
    note: `PSA submission fee ${label}`,
  })

  // Sale: partial disposal of 1 unit from the purchased lot, frozen per-unit basis 46094.
  const saleId = await insertOne(service, 'sales', {
    user_id: userId,
    sold_on: dateOnly(7),
    marketplace: `Cardmarket ${label}`,
    currency: 'NOK',
    gross_minor: 120_000,
    fees_minor: 3_600,
    shipping_cost_minor: 6_400,
    shipping_charged_minor: 5_000,
    net_proceeds_minor: 115_000,
    fx_rate_to_nok: 1,
    fx_rate_date: dateOnly(7),
    fx_source: 'manual',
    net_proceeds_nok_minor: 115_000,
    realized_result_nok_minor: 68_906,
    proceeds_from_uncosted_nok_minor: 0,
    idempotency_key: crypto.randomUUID(),
    notes: `Partial sale ${label}`,
  })
  const saleLineId = await insertOne(service, 'sale_lines', {
    sale_id: saleId,
    user_id: userId,
    lot_id: purchasedLotId,
    quantity: 1,
    unit_gross_minor: 120_000,
    line_gross_minor: 120_000,
    allocated_fees_minor: 3_600,
    allocated_shipping_minor: 6_400,
    allocated_shipping_charged_minor: 5_000,
    net_proceeds_minor: 115_000,
    net_proceeds_nok_minor: 115_000,
    cost_basis_at_sale_nok_minor: 46_094,
    realized_result_nok_minor: 68_906,
  })
  const disposalId = await insertOne(service, 'lot_disposals', {
    lot_id: purchasedLotId,
    user_id: userId,
    kind: 'sale',
    quantity: 1,
    disposed_on: dateOnly(7),
    sale_line_id: saleLineId,
    cost_basis_at_disposal_nok_minor: 46_094,
  })

  // Voided sale whose line would have had an UNKNOWN basis: NULL basis/result pair travels.
  const voidedSaleId = await insertOne(service, 'sales', {
    user_id: userId,
    sold_on: dateOnly(5),
    marketplace: `Finn ${label}`,
    currency: 'NOK',
    gross_minor: 30_000,
    fees_minor: 0,
    shipping_cost_minor: 0,
    shipping_charged_minor: 0,
    net_proceeds_minor: 30_000,
    fx_rate_to_nok: 1,
    fx_rate_date: dateOnly(5),
    fx_source: 'manual',
    net_proceeds_nok_minor: 30_000,
    realized_result_nok_minor: null,
    proceeds_from_uncosted_nok_minor: 30_000,
    idempotency_key: crypto.randomUUID(),
    voided_at: iso(4),
    notes: `Voided listing test ${label}`,
  })

  return {
    retailerId,
    storageLocationId,
    tagId,
    customCollectionId,
    manualCardId,
    sealedProductId,
    purchaseId,
    purchaseLineCardId,
    purchaseLineSealedId,
    voidedPurchaseId,
    holdingId,
    giftLotId,
    purchasedLotId,
    manualHoldingId,
    sealedHoldingId,
    activeValuationId,
    supersededValuationId,
    adjustmentId,
    saleId,
    saleLineId,
    disposalId,
    voidedSaleId,
  }
}

/** Row counts this fixture creates per MUST_EXPORT table (used by completeness assertions). */
export const FIXTURE_EXPECTED_COUNTS: Readonly<Record<string, number>> = {
  retailers: 1,
  storage_locations: 1,
  tags: 1,
  profiles: 1,
  holdings: 3,
  acquisition_lots: 2,
  purchases: 2,
  purchase_lines: 2,
  lot_cost_adjustments: 1,
  manual_card_definitions: 1,
  manual_valuations: 2,
  holding_tags: 1,
  custom_collections: 1,
  custom_collection_members: 1,
  sales: 2,
  sale_lines: 1,
  lot_disposals: 1,
  sealed_products: 1,
}
