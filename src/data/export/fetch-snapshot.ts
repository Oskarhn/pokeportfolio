/**
 * Owner-scoped, paginated fetching of every canonical M13 export section.
 *
 * Security posture: every query runs through the caller's own authenticated Supabase client —
 * RLS is the access-control boundary and nothing here bypasses, widens or re-implements it.
 * The exporting identity is resolved from the SESSION (`auth.getUser()`), never accepted as a
 * parameter, so UI code cannot nominate another user. No service role, no Edge Function, no
 * Storage bucket.
 *
 * Exactness: every monetary column is selected with a `::text` cast (src/data/money.ts's
 * bigint boundary rule) and re-validated through `minorUnits()` when branded, so a column that
 * ever lost its cast fails loudly instead of silently rounding past 2^53.
 *
 * Scale: bounded pages under stable primary-key ordering — never one unbounded query
 * (DATA_MODEL.md §10.1), never the giant-sorted-query class behind the M9.1/M9.2 saga. A hard
 * page ceiling turns a pathological loop into a thrown error rather than a hung tab.
 *
 * Pagination honesty (D-074): `.order(pk).range(from, to)` is OFFSET pagination with stable,
 * deterministic ordering — it is NOT keyset pagination and must not be described as such.
 * Offset walking has silent truncation/gap/duplicate failure modes when the source changes
 * between pages, so every section walk additionally takes the table's exact COUNT up front,
 * detects duplicate primary keys across pages, and reconciles the final received count
 * (src/domain/export/pagination-integrity.ts). A count mismatch or duplicate FAILS the export
 * loudly instead of writing an incomplete backup. This is detection, not snapshot isolation —
 * the multi-query export is not one PostgreSQL transaction (D-077).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSectionWalk } from '../../domain/export/pagination-integrity'
import type { Database } from '../database.types'
import {
  minorUnits,
  type BackupAcquisitionLotRow,
  type BackupCustomCollectionMemberRow,
  type BackupCustomCollectionRow,
  type BackupData,
  type BackupHoldingRow,
  type BackupHoldingTagRow,
  type BackupIdentityManifest,
  type BackupLotCostAdjustmentRow,
  type BackupLotDisposalRow,
  type BackupManualCardDefinitionRow,
  type BackupManualValuationRow,
  type BackupProfileRow,
  type BackupPurchaseLineRow,
  type BackupPurchaseRow,
  type BackupRetailerRow,
  type BackupSaleLineRow,
  type BackupSaleRow,
  type BackupStorageLocationRow,
  type BackupTagRow,
  type BackupUserCreatedSealedProductRow,
  type ManifestCardVariantEntry,
  type ManifestCuratedSealedProductEntry,
  type MinorUnitsString,
} from '../../domain/export/backup-format'
import type { ExportSnapshot } from '../../domain/export/snapshot-types'

/** Rows requested per page. Bounded, never "the whole table". */
export const EXPORT_PAGE_SIZE = 500

/**
 * Hard upper bound on pages per section — 500k rows. Far beyond the documented 10k-lot scale;
 * exists purely as a pathological-loop guard (M7.1 precedent).
 */
export const EXPORT_MAX_PAGES = 1000

export interface ExportFetchOptions {
  readonly signal?: AbortSignal
  /** Test override only; production exports always use {@link EXPORT_PAGE_SIZE}. */
  readonly pageSize?: number
  /** Test override only; production always uses {@link EXPORT_MAX_PAGES}. */
  readonly maxPages?: number
  /** Called after each page lands. P36 renders progress from this; core owns no UI. */
  readonly onPage?: (info: { section: string; totalRows: number }) => void
}

// ---------------------------------------------------------------------------
// Section wiring — select lists (with mandatory ::text casts) and stable ordering
// ---------------------------------------------------------------------------

/** Every section — profiles included (0 or 1 rows) — is now a uniform array. */
type ArraySection = keyof BackupData

/**
 * Wire shape of a row straight off PostgREST: identical to the backup-row contract except that
 * money fields arrive as plain strings. Deriving this from the format types keeps the select
 * lists and the contract in lockstep — adding a money field to the format forces its cast here.
 */
type WireValue<T> =
  Extract<NonNullable<T>, MinorUnitsString> extends never
    ? T
    : T extends null
      ? string | null
      : string
export type WireRow<T> = { [K in keyof T]: WireValue<T[K]> }

/** Names of the money fields on a given row type (compiler-derived). */
type MoneyKeys<T> = keyof {
  [K in keyof T as Extract<NonNullable<T[K]>, MinorUnitsString> extends never ? never : K]: true
}

export const EXPORT_SECTION_SELECTS = {
  profiles:
    'id, display_name, theme, display_currency, locale, hide_values, hide_low_value_by_default, ' +
    'low_value_threshold_minor::text, use_eu_pricing, collection_grid_density, ' +
    'collection_default_view, collection_default_sort, default_condition, default_language, ' +
    'default_storage_location_id, created_at, updated_at',
  custom_collections: 'id, user_id, name, description, color, sort_order, created_at',
  custom_collection_members: 'user_id, collection_id, holding_id, sort_order, added_at',
  tags: 'id, user_id, name, created_at, updated_at',
  holding_tags: 'user_id, holding_id, tag_id, created_at',
  storage_locations: 'id, user_id, name, kind, sort_order, created_at, updated_at',
  retailers: 'id, user_id, name, notes, created_at, updated_at',
  holdings:
    'id, user_id, holding_kind, card_variant_id, sealed_product_id, manual_card_id, ' +
    'grading_state, condition, grader, grade, cert_number, is_favorite, notes, deleted_at, ' +
    'created_at, updated_at',
  acquisition_lots:
    'id, user_id, holding_id, purchase_line_id, origin, cost_basis_state, cost_basis_currency, ' +
    'unit_cost_basis_minor::text, unit_cost_basis_nok_minor::text, residual_minor::text, ' +
    'residual_nok_minor::text, quantity, quantity_remaining, sealed_intent, storage_location_id, ' +
    'acquired_on, voided_at, notes, created_at',
  manual_card_definitions:
    'id, user_id, name, set_name, collector_number, language, finish, stamp, subtype, size, ' +
    'notes, created_at, updated_at',
  sealed_products:
    'id, created_by_user_id, name, product_type, language, pack_count, set_id, image_url, ' +
    'cardmarket_product_id, tcgplayer_product_id, created_at, updated_at',
  manual_valuations:
    'id, user_id, holding_id, value_minor::text, currency, value_nok_minor::text, effective_from, ' +
    'note, superseded_at, created_at',
  lot_cost_adjustments:
    'id, user_id, lot_id, purchase_line_id, kind, occurred_on, amount_minor::text, currency, ' +
    'amount_nok_minor::text, note, created_at',
  purchases:
    'id, user_id, purchased_on, retailer_id, currency, subtotal_minor::text, shipping_minor::text, ' +
    'customs_minor::text, discount_minor::text, total_minor::text, total_nok_minor::text, ' +
    'fx_rate_to_nok::text, fx_rate_date, fx_source, origin, notes, voided_at, created_at, updated_at',
  purchase_lines:
    'id, user_id, purchase_id, line_type, spend_class, description, card_variant_id, ' +
    'sealed_product_id, condition, quantity, unit_price_minor::text, line_total_minor::text, ' +
    'allocated_shipping_minor::text, allocated_customs_minor::text, allocated_discount_minor::text, ' +
    'attributable_cost_minor::text, attributable_cost_nok_minor::text, created_at, updated_at',
  sales:
    'id, user_id, sold_on, marketplace, currency, gross_minor::text, fees_minor::text, ' +
    'shipping_cost_minor::text, shipping_charged_minor::text, net_proceeds_minor::text, ' +
    'net_proceeds_nok_minor::text, realized_result_nok_minor::text, ' +
    'proceeds_from_uncosted_nok_minor::text, fx_rate_to_nok::text, fx_rate_date, fx_source, ' +
    'notes, idempotency_key, voided_at, created_at, updated_at',
  sale_lines:
    'id, user_id, sale_id, lot_id, quantity, unit_gross_minor::text, line_gross_minor::text, ' +
    'allocated_fees_minor::text, allocated_shipping_minor::text, ' +
    'allocated_shipping_charged_minor::text, net_proceeds_minor::text, net_proceeds_nok_minor::text, ' +
    'cost_basis_at_sale_nok_minor::text, realized_result_nok_minor::text, created_at',
  lot_disposals:
    'id, user_id, lot_id, sale_line_id, kind, disposed_on, quantity, ' +
    'cost_basis_at_disposal_nok_minor::text, voided_at, created_at',
} as const satisfies Record<ArraySection, string>

/**
 * The monetary properties per section, re-validated through `minorUnits()` at the boundary.
 * Names are compiler-checked against each row's money fields; the exported probe below proves
 * every money field is listed, so a new money column cannot ship without its cast-and-branding.
 */
export const MONEY_FIELDS: { [K in ArraySection]: readonly MoneyKeys<BackupData[K][number]>[] } = {
  profiles: ['low_value_threshold_minor'],
  custom_collections: [],
  custom_collection_members: [],
  tags: [],
  holding_tags: [],
  storage_locations: [],
  retailers: [],
  holdings: [],
  acquisition_lots: [
    'unit_cost_basis_minor',
    'unit_cost_basis_nok_minor',
    'residual_minor',
    'residual_nok_minor',
  ],
  manual_card_definitions: [],
  sealed_products: [],
  manual_valuations: ['value_minor', 'value_nok_minor'],
  lot_cost_adjustments: ['amount_minor', 'amount_nok_minor'],
  purchases: [
    'subtotal_minor',
    'shipping_minor',
    'customs_minor',
    'discount_minor',
    'total_minor',
    'total_nok_minor',
  ],
  purchase_lines: [
    'unit_price_minor',
    'line_total_minor',
    'allocated_shipping_minor',
    'allocated_customs_minor',
    'allocated_discount_minor',
    'attributable_cost_minor',
    'attributable_cost_nok_minor',
  ],
  sales: [
    'gross_minor',
    'fees_minor',
    'shipping_cost_minor',
    'shipping_charged_minor',
    'net_proceeds_minor',
    'net_proceeds_nok_minor',
    'realized_result_nok_minor',
    'proceeds_from_uncosted_nok_minor',
  ],
  sale_lines: [
    'unit_gross_minor',
    'line_gross_minor',
    'allocated_fees_minor',
    'allocated_shipping_minor',
    'allocated_shipping_charged_minor',
    'net_proceeds_minor',
    'net_proceeds_nok_minor',
    'cost_basis_at_sale_nok_minor',
    'realized_result_nok_minor',
  ],
  lot_disposals: ['cost_basis_at_disposal_nok_minor'],
}

/**
 * Primary-key column(s) per section, in the same order the fetch sorts by. Used for cross-page
 * duplicate detection and for the COUNT query that anchors completeness (D-074).
 */
const SECTION_IDENTITY_KEYS: Record<ArraySection, readonly string[]> = {
  profiles: ['id'],
  custom_collections: ['id'],
  custom_collection_members: ['collection_id', 'holding_id'],
  tags: ['id'],
  holding_tags: ['holding_id', 'tag_id'],
  storage_locations: ['id'],
  retailers: ['id'],
  holdings: ['id'],
  acquisition_lots: ['id'],
  manual_card_definitions: ['id'],
  sealed_products: ['id'],
  manual_valuations: ['id'],
  lot_cost_adjustments: ['id'],
  purchases: ['id'],
  purchase_lines: ['id'],
  sales: ['id'],
  sale_lines: ['id'],
  lot_disposals: ['id'],
}

/**
 * Compile-time proof that {@link MONEY_FIELDS} lists every money property of every section — if
 * a section ever gains an unlisted money field, this stops being `true` and the module fails to
 * compile. Exported solely so tooling treats it as live code rather than an unused binding.
 */
export type UnlistedMoneyFieldProbe = {
  [K in ArraySection]: Exclude<
    MoneyKeys<BackupData[K][number]>,
    (typeof MONEY_FIELDS)[K][number]
  > extends never
    ? never
    : `unlisted money field in section ${K & string}`
}[ArraySection]
export const NO_UNLISTED_MONEY_FIELDS: [UnlistedMoneyFieldProbe] extends [never] ? true : never =
  true

/** Re-validates every listed money field of one wire row into the branded format type. */
function brandRow<K extends ArraySection>(
  row: WireRow<BackupData[K][number]>,
  section: K,
): BackupData[K][number] {
  const out: Record<string, unknown> = { ...row }
  for (const key of MONEY_FIELDS[section]) {
    const value = out[key]
    if (typeof value === 'string') out[key] = minorUnits(value)
  }
  // The cast is earned: every listed money field was just validated by minorUnits().
  return out as unknown as BackupData[K][number]
}

// ---------------------------------------------------------------------------
// Pagination plumbing (knows nothing about Supabase builders)
// ---------------------------------------------------------------------------

interface PageResult<TRow> {
  data: TRow[] | null
  error: { message: string } | null
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('Export cancelled', 'AbortError')
}

async function drainPages<TRow>(
  section: string,
  buildPage: (from: number, to: number) => PromiseLike<PageResult<TRow>>,
  options: ExportFetchOptions,
  onPageLanded: (rows: readonly TRow[]) => void,
): Promise<void> {
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE
  const maxPages = options.maxPages ?? EXPORT_MAX_PAGES

  for (let page = 0; page < maxPages; page++) {
    abortIfRequested(options.signal)
    const { data, error } = await buildPage(page * pageSize, (page + 1) * pageSize - 1)
    if (error !== null) {
      throw new Error(`Export failed reading ${section}: ${error.message}`)
    }
    // PostgREST yields null rows only alongside an error, which threw above; the ?? keeps this
    // driver correct for any caller whose success shape stays nullable.
    const rows = data ?? []
    onPageLanded(rows)
    if (rows.length < pageSize) return
  }
  throw new Error(
    `Export aborted: ${section} exceeded ${String(maxPages)} pages of ${String(pageSize)} rows`,
  )
}

/** Reads the section's exact row count once, before paging starts (D-074). */
async function fetchSectionTotal(
  client: SupabaseClient<Database>,
  section: ArraySection,
  options: ExportFetchOptions,
): Promise<number> {
  const firstKey = SECTION_IDENTITY_KEYS[section][0]
  if (firstKey === undefined) {
    throw new Error(`Export failed counting ${section}: no identity key declared`)
  }
  const base = client.from(section).select(firstKey, { count: 'exact', head: true })
  const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
  const { count, error } = await ready
  if (error !== null || count === null) {
    throw new Error(`Export failed counting ${section}: ${error?.message ?? 'no count returned'}`)
  }
  return count
}

async function collectRows<TWire, TRow>(
  client: SupabaseClient<Database>,
  section: ArraySection,
  options: ExportFetchOptions,
  buildPage: (from: number, to: number) => PromiseLike<PageResult<TWire>>,
  brand: (row: TWire) => TRow,
): Promise<TRow[]> {
  const expectedTotal = await fetchSectionTotal(client, section, options)
  const walk = createSectionWalk(section, SECTION_IDENTITY_KEYS[section])
  const rows: TRow[] = []
  await drainPages<TWire>(section, buildPage, options, (pageRows) => {
    walk.observe(pageRows)
    for (const row of pageRows) rows.push(brand(row))
    options.onPage?.({ section, totalRows: walk.received })
  })
  walk.finish(expectedTotal)
  return rows
}

// ---------------------------------------------------------------------------
// One concrete reader per canonical section — literal-typed, RLS-scoped, ordered by PK
// ---------------------------------------------------------------------------

async function fetchCustomCollections(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['custom_collections']> {
  return collectRows(
    client,
    'custom_collections',
    options,
    (from, to) => {
      const base = client
        .from('custom_collections')
        .select(EXPORT_SECTION_SELECTS.custom_collections)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupCustomCollectionRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'custom_collections'),
  )
}

async function fetchCustomCollectionMembers(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['custom_collection_members']> {
  return collectRows(
    client,
    'custom_collection_members',
    options,
    (from, to) => {
      const base = client
        .from('custom_collection_members')
        .select(EXPORT_SECTION_SELECTS.custom_collection_members)
        .order('collection_id', { ascending: true })
        .order('holding_id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupCustomCollectionMemberRow>[], { merge: false }>()
    },
    (row) => row, // no money fields — wire shape IS the contract shape
  )
}

async function fetchTags(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['tags']> {
  return collectRows(
    client,
    'tags',
    options,
    (from, to) => {
      const base = client
        .from('tags')
        .select(EXPORT_SECTION_SELECTS.tags)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupTagRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchHoldingTags(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['holding_tags']> {
  return collectRows(
    client,
    'holding_tags',
    options,
    (from, to) => {
      const base = client
        .from('holding_tags')
        .select(EXPORT_SECTION_SELECTS.holding_tags)
        .order('holding_id', { ascending: true })
        .order('tag_id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupHoldingTagRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchStorageLocations(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['storage_locations']> {
  return collectRows(
    client,
    'storage_locations',
    options,
    (from, to) => {
      const base = client
        .from('storage_locations')
        .select(EXPORT_SECTION_SELECTS.storage_locations)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupStorageLocationRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchRetailers(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['retailers']> {
  return collectRows(
    client,
    'retailers',
    options,
    (from, to) => {
      const base = client
        .from('retailers')
        .select(EXPORT_SECTION_SELECTS.retailers)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupRetailerRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchHoldings(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['holdings']> {
  return collectRows(
    client,
    'holdings',
    options,
    (from, to) => {
      const base = client
        .from('holdings')
        .select(EXPORT_SECTION_SELECTS.holdings)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupHoldingRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchAcquisitionLots(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['acquisition_lots']> {
  return collectRows(
    client,
    'acquisition_lots',
    options,
    (from, to) => {
      const base = client
        .from('acquisition_lots')
        .select(EXPORT_SECTION_SELECTS.acquisition_lots)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupAcquisitionLotRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'acquisition_lots'),
  )
}

async function fetchManualCardDefinitions(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['manual_card_definitions']> {
  return collectRows(
    client,
    'manual_card_definitions',
    options,
    (from, to) => {
      const base = client
        .from('manual_card_definitions')
        .select(EXPORT_SECTION_SELECTS.manual_card_definitions)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupManualCardDefinitionRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchUserCreatedSealedProducts(
  client: SupabaseClient<Database>,
  userId: string,
  options: ExportFetchOptions,
): Promise<BackupData['sealed_products']> {
  return collectRows(
    client,
    'sealed_products',
    options,
    (from, to) => {
      const base = client
        .from('sealed_products')
        .select(EXPORT_SECTION_SELECTS.sealed_products)
        // Owner-created rows only; curated catalog products travel via the identity manifest.
        .eq('created_by_user_id', userId)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupUserCreatedSealedProductRow>[], { merge: false }>()
    },
    (row) => row,
  )
}

async function fetchManualValuations(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['manual_valuations']> {
  return collectRows(
    client,
    'manual_valuations',
    options,
    (from, to) => {
      const base = client
        .from('manual_valuations')
        .select(EXPORT_SECTION_SELECTS.manual_valuations)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupManualValuationRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'manual_valuations'),
  )
}

async function fetchLotCostAdjustments(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['lot_cost_adjustments']> {
  return collectRows(
    client,
    'lot_cost_adjustments',
    options,
    (from, to) => {
      const base = client
        .from('lot_cost_adjustments')
        .select(EXPORT_SECTION_SELECTS.lot_cost_adjustments)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupLotCostAdjustmentRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'lot_cost_adjustments'),
  )
}

async function fetchPurchases(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['purchases']> {
  return collectRows(
    client,
    'purchases',
    options,
    (from, to) => {
      const base = client
        .from('purchases')
        .select(EXPORT_SECTION_SELECTS.purchases)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupPurchaseRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'purchases'),
  )
}

async function fetchPurchaseLines(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['purchase_lines']> {
  return collectRows(
    client,
    'purchase_lines',
    options,
    (from, to) => {
      const base = client
        .from('purchase_lines')
        .select(EXPORT_SECTION_SELECTS.purchase_lines)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupPurchaseLineRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'purchase_lines'),
  )
}

async function fetchSales(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['sales']> {
  return collectRows(
    client,
    'sales',
    options,
    (from, to) => {
      const base = client
        .from('sales')
        .select(EXPORT_SECTION_SELECTS.sales)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupSaleRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'sales'),
  )
}

async function fetchSaleLines(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['sale_lines']> {
  return collectRows(
    client,
    'sale_lines',
    options,
    (from, to) => {
      const base = client
        .from('sale_lines')
        .select(EXPORT_SECTION_SELECTS.sale_lines)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupSaleLineRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'sale_lines'),
  )
}

async function fetchLotDisposals(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions,
): Promise<BackupData['lot_disposals']> {
  return collectRows(
    client,
    'lot_disposals',
    options,
    (from, to) => {
      const base = client
        .from('lot_disposals')
        .select(EXPORT_SECTION_SELECTS.lot_disposals)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupLotDisposalRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'lot_disposals'),
  )
}

async function fetchProfiles(
  client: SupabaseClient<Database>,
  userId: string,
  options: ExportFetchOptions,
): Promise<BackupData['profiles']> {
  // The owner's own profile row (0 or 1 rows) through the SAME bounded, reconciled walk as
  // every other section — uniform completeness guarantees, no special case.
  return collectRows(
    client,
    'profiles',
    options,
    (from, to) => {
      const base = client
        .from('profiles')
        .select(EXPORT_SECTION_SELECTS.profiles)
        .eq('id', userId)
        .order('id', { ascending: true })
        .range(from, to)
      const ready = options.signal === undefined ? base : base.abortSignal(options.signal)
      return ready.overrideTypes<WireRow<BackupProfileRow>[], { merge: false }>()
    },
    (row) => brandRow(row, 'profiles'),
  )
}

// ---------------------------------------------------------------------------
// Identity manifest — stable references into the SHARED catalog only
// ---------------------------------------------------------------------------

interface VariantManifestWireRow {
  id: string
  finish: string
  stamp: string
  subtype: string
  size: string | null
  tcgdex_variant_id: string | null
  cardmarket_product_id: string | null
  tcgplayer_product_id: string | null
  cards: {
    name: string
    local_id: string
    language: string
    tcgdex_card_id: string | null
    card_sets: { slug: string; name: string } | null
  } | null
}

interface CuratedSealedWireRow {
  id: string
  name: string
  product_type: string
  language: string
  pack_count: number | null
  cardmarket_product_id: string | null
  tcgplayer_product_id: string | null
  card_sets: { slug: string; name: string } | null
}

/** PostgREST URL-length safety: resolve shared-catalog references in bounded id chunks. */
const MANIFEST_CHUNK_SIZE = 100

async function fetchCardVariantManifest(
  client: SupabaseClient<Database>,
  variantIds: readonly string[],
  options: ExportFetchOptions,
): Promise<ManifestCardVariantEntry[]> {
  const entries: ManifestCardVariantEntry[] = []
  for (let start = 0; start < variantIds.length; start += MANIFEST_CHUNK_SIZE) {
    abortIfRequested(options.signal)
    const chunk = variantIds.slice(start, start + MANIFEST_CHUNK_SIZE)
    const { data, error } = await client
      .from('card_variants')
      .select(
        'id, finish, stamp, subtype, size, tcgdex_variant_id, cardmarket_product_id, ' +
          'tcgplayer_product_id, cards(name, local_id, language, tcgdex_card_id, card_sets(slug, name))',
      )
      .in('id', [...chunk])
      .order('id', { ascending: true })
      .overrideTypes<VariantManifestWireRow[], { merge: false }>()
    if (error !== null) {
      throw new Error(`Export failed reading catalog variants: ${error.message}`)
    }
    for (const row of data) {
      const card = row.cards
      entries.push({
        id: row.id,
        finish: row.finish,
        stamp: row.stamp,
        subtype: row.subtype,
        size: row.size,
        tcgdex_variant_id: row.tcgdex_variant_id,
        cardmarket_product_id: row.cardmarket_product_id,
        tcgplayer_product_id: row.tcgplayer_product_id,
        card_name: card?.name ?? null,
        card_local_id: card?.local_id ?? null,
        card_language: card?.language ?? null,
        tcgdex_card_id: card?.tcgdex_card_id ?? null,
        set_slug: card?.card_sets?.slug ?? null,
        set_name: card?.card_sets?.name ?? null,
      })
    }
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

async function fetchCuratedSealedManifest(
  client: SupabaseClient<Database>,
  curatedIds: readonly string[],
  options: ExportFetchOptions,
): Promise<ManifestCuratedSealedProductEntry[]> {
  const entries: ManifestCuratedSealedProductEntry[] = []
  for (let start = 0; start < curatedIds.length; start += MANIFEST_CHUNK_SIZE) {
    abortIfRequested(options.signal)
    const chunk = curatedIds.slice(start, start + MANIFEST_CHUNK_SIZE)
    const { data, error } = await client
      .from('sealed_products')
      .select(
        'id, name, product_type, language, pack_count, cardmarket_product_id, ' +
          'tcgplayer_product_id, card_sets(slug, name)',
      )
      .in('id', [...chunk])
      .order('id', { ascending: true })
      .overrideTypes<CuratedSealedWireRow[], { merge: false }>()
    if (error !== null) {
      throw new Error(`Export failed reading curated sealed products: ${error.message}`)
    }
    for (const row of data) {
      entries.push({
        id: row.id,
        name: row.name,
        product_type: row.product_type,
        language: row.language,
        pack_count: row.pack_count,
        cardmarket_product_id: row.cardmarket_product_id,
        tcgplayer_product_id: row.tcgplayer_product_id,
        set_slug: row.card_sets?.slug ?? null,
        set_name: row.card_sets?.name ?? null,
      })
    }
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function collectReferencedIds(
  snapshot: Pick<ExportSnapshot, 'holdings' | 'purchase_lines'>,
  pick: (row: {
    card_variant_id: string | null
    sealed_product_id: string | null
  }) => string | null,
): string[] {
  const ids = new Set<string>()
  for (const row of snapshot.holdings) {
    const id = pick(row)
    if (id !== null) ids.add(id)
  }
  for (const row of snapshot.purchase_lines) {
    const id = pick(row)
    if (id !== null) ids.add(id)
  }
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Fetches every canonical export section for the signed-in owner — sequentially, one bounded
 * page loop at a time (DB-friendly, deterministic progress ordering) — then resolves the
 * shared-catalog identity manifest. Throws AbortError as soon as `signal` is observed fired.
 */
export async function fetchExportSnapshot(
  client: SupabaseClient<Database>,
  options: ExportFetchOptions = {},
): Promise<ExportSnapshot> {
  const auth = await client.auth.getUser()
  const sessionUserId: string | undefined = auth.data.user?.id
  if (auth.error !== null || sessionUserId === undefined) {
    throw new Error('Export requires an authenticated session')
  }
  const userId: string = sessionUserId

  const profiles = await fetchProfiles(client, userId, options)
  const customCollections = await fetchCustomCollections(client, options)
  const customCollectionMembers = await fetchCustomCollectionMembers(client, options)
  const tags = await fetchTags(client, options)
  const holdingTags = await fetchHoldingTags(client, options)
  const storageLocations = await fetchStorageLocations(client, options)
  const retailers = await fetchRetailers(client, options)
  const holdings = await fetchHoldings(client, options)
  const acquisitionLots = await fetchAcquisitionLots(client, options)
  const manualCardDefinitions = await fetchManualCardDefinitions(client, options)
  const sealedProductsUserCreated = await fetchUserCreatedSealedProducts(client, userId, options)
  const manualValuations = await fetchManualValuations(client, options)
  const lotCostAdjustments = await fetchLotCostAdjustments(client, options)
  const purchases = await fetchPurchases(client, options)
  const purchaseLines = await fetchPurchaseLines(client, options)
  const sales = await fetchSales(client, options)
  const saleLines = await fetchSaleLines(client, options)
  const lotDisposals = await fetchLotDisposals(client, options)

  const snapshot: ExportSnapshot = {
    profiles,
    custom_collections: customCollections,
    custom_collection_members: customCollectionMembers,
    tags,
    holding_tags: holdingTags,
    storage_locations: storageLocations,
    retailers,
    holdings,
    acquisition_lots: acquisitionLots,
    manual_card_definitions: manualCardDefinitions,
    sealed_products: sealedProductsUserCreated,
    manual_valuations: manualValuations,
    lot_cost_adjustments: lotCostAdjustments,
    purchases,
    purchase_lines: purchaseLines,
    sales,
    sale_lines: saleLines,
    lot_disposals: lotDisposals,
    identity_manifest: { card_variants: [], curated_sealed_products: [] },
  }

  const variantIds = collectReferencedIds(snapshot, (row) => row.card_variant_id)
  const referencedSealedIds = collectReferencedIds(snapshot, (row) => row.sealed_product_id)
  const ownSealedIds = new Set(snapshot.sealed_products.map((p) => p.id))
  const curatedSealedIds = referencedSealedIds.filter((id) => !ownSealedIds.has(id))

  const identity_manifest: BackupIdentityManifest = {
    card_variants: await fetchCardVariantManifest(client, variantIds, options),
    curated_sealed_products: await fetchCuratedSealedManifest(client, curatedSealedIds, options),
  }

  return { ...snapshot, identity_manifest }
}
