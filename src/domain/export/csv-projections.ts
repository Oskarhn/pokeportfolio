/**
 * The bounded M13 CSV export suite — human/analysis projections, NOT lossless backups
 * (the JSON envelope is the lossless artifact). Column contracts:
 *
 * - Stable column order; headers are plain English labels (CSV is for humans/spreadsheets).
 *   The declared columns below are the versioned schema ({@link EXPORT_CSV_SCHEMA_VERSION}):
 *   changes are additive (new columns appended) or a deliberate version bump, and a golden test
 *   pins every header and kind.
 * - Money renders as decimal strings in MAJOR units using the currency's minor-unit exponent
 *   (JPY 0, NOK/EUR/USD 2), with an explicit currency column beside every original-currency
 *   amount; frozen NOK amounts say NOK in the header. Exact — rendered from integer minor units
 *   without a float.
 * - An empty cell means "not applicable / unknown" — NEVER a fabricated zero. Genuine zero
 *   renders as 0.00 (or 0 for zero-exponent currencies).
 * - Dates are YYYY-MM-DD (date-only values are never time-zone shifted); timestamps verbatim
 *   ISO 8601 as returned by PostgREST.
 * - Every column declares a kind ({@link CsvColumnKind}). The writer — not this file's call
 *   sites — sanitizes free text against spreadsheet formulas and writes canonical kinds only when
 *   the value has the canonical shape, so negatives survive in money columns while a text cell
 *   that looks numeric does not become a trusted number (see csv.ts).
 * - Display columns (card name, set, number, variant, storage, retailer, tags) are joined at
 *   export time from the snapshot itself; id columns stay authoritative.
 *
 * Deliberately NOT exported as CSV: profile settings, standalone retailer/storage/tag tables
 * (their names appear inline where they belong), sales.idempotency_key. No valuation columns —
 * a resolved market value is not canonical stored data; manual valuations have their own file.
 */
import type {
  BackupAcquisitionLotRow,
  BackupCustomCollectionMemberRow,
  BackupCustomCollectionRow,
  BackupHoldingRow,
  BackupHoldingTagRow,
  BackupLotCostAdjustmentRow,
  BackupLotDisposalRow,
  BackupManualValuationRow,
  BackupOpeningRow,
  BackupPurchaseLineRow,
  BackupPurchaseRow,
  BackupSaleLineRow,
  BackupSaleRow,
  BackupTagRow,
  ManifestCardVariantEntry,
} from './backup-format'
import { buildTypedCsvText, csvBoolean, csvMoney, type CsvColumn } from './csv'
import type { ExportSnapshot } from './snapshot-types'

/**
 * Version of the CSV column contract. v1 is the M13 suite; v2 (P157) appends a `Currency` column
 * to purchase_lines.csv and sale_lines.csv (their amounts are in the parent's currency, which was
 * not in the row) — additive, so a reader that addresses columns by header or by leading
 * position is unaffected.
 */
export const EXPORT_CSV_SCHEMA_VERSION = 2

export interface CsvFileContent {
  readonly filename: string
  readonly text: string
}

/**
 * Pure join from a fetched export snapshot to the CSV projections' lookup tables. Lives in the
 * domain layer so the artifact orchestrator and the test suites share ONE implementation.
 */
export function projectionInputFromSnapshot(snapshot: ExportSnapshot): CsvProjectionInput {
  const sealedProductNames = new Map<string, string>()
  for (const product of snapshot.sealed_products) {
    sealedProductNames.set(product.id, product.name)
  }
  for (const curated of snapshot.identity_manifest.curated_sealed_products) {
    if (!sealedProductNames.has(curated.id)) sealedProductNames.set(curated.id, curated.name)
  }

  const manualCardEntries: [
    string,
    { name: string; set_name: string | null; collector_number: string | null },
  ][] = snapshot.manual_card_definitions.map((card) => [
    card.id,
    { name: card.name, set_name: card.set_name, collector_number: card.collector_number },
  ])
  const storageEntries: [string, string][] = snapshot.storage_locations.map((l) => [l.id, l.name])
  const retailerEntries: [string, string][] = snapshot.retailers.map((r) => [r.id, r.name])

  return {
    holdings: snapshot.holdings,
    acquisition_lots: snapshot.acquisition_lots,
    manual_valuations: snapshot.manual_valuations,
    openings: snapshot.openings,
    purchases: snapshot.purchases,
    purchase_lines: snapshot.purchase_lines,
    sales: snapshot.sales,
    sale_lines: snapshot.sale_lines,
    lot_disposals: snapshot.lot_disposals,
    lot_cost_adjustments: snapshot.lot_cost_adjustments,
    custom_collections: snapshot.custom_collections,
    custom_collection_members: snapshot.custom_collection_members,
    tags: snapshot.tags,
    holding_tags: snapshot.holding_tags,
    variantIndex: new Map(
      snapshot.identity_manifest.card_variants.map((entry) => [entry.id, entry]),
    ),
    sealedProductNames,
    manualCardIndex: new Map(manualCardEntries),
    storageLocationNames: new Map(storageEntries),
    retailerNames: new Map(retailerEntries),
  }
}

/** Stable suite order — the ZIP packs files in exactly this order. */
export const EXPORT_CSV_FILENAMES = [
  'holdings.csv',
  'acquisition_lots.csv',
  'manual_valuations.csv',
  'purchases.csv',
  'purchase_lines.csv',
  'sales.csv',
  'sale_lines.csv',
  'lot_disposals.csv',
  'lot_cost_adjustments.csv',
  'openings.csv',
  'custom_collections.csv',
] as const

export type ExportCsvFilename = (typeof EXPORT_CSV_FILENAMES)[number]

/**
 * Everything the CSV projections need, pre-resolved. Built by the data layer from one fetched
 * snapshot; kept as parameters so these builders stay pure and testable without Supabase.
 */
export interface CsvProjectionInput {
  readonly holdings: readonly BackupHoldingRow[]
  readonly acquisition_lots: readonly BackupAcquisitionLotRow[]
  readonly manual_valuations: readonly BackupManualValuationRow[]
  readonly openings: readonly BackupOpeningRow[]
  readonly purchases: readonly BackupPurchaseRow[]
  readonly purchase_lines: readonly BackupPurchaseLineRow[]
  readonly sales: readonly BackupSaleRow[]
  readonly sale_lines: readonly BackupSaleLineRow[]
  readonly lot_disposals: readonly BackupLotDisposalRow[]
  readonly lot_cost_adjustments: readonly BackupLotCostAdjustmentRow[]
  readonly custom_collections: readonly BackupCustomCollectionRow[]
  readonly custom_collection_members: readonly BackupCustomCollectionMemberRow[]
  readonly tags: readonly BackupTagRow[]
  readonly holding_tags: readonly BackupHoldingTagRow[]
  /** Variant id → display entry (identity manifest). */
  readonly variantIndex: ReadonlyMap<string, ManifestCardVariantEntry>
  /** Sealed product id → display name (user-created rows first, then curated manifest). */
  readonly sealedProductNames: ReadonlyMap<string, string>
  /** Manual card definition id → display fields. */
  readonly manualCardIndex: ReadonlyMap<
    string,
    { name: string; set_name: string | null; collector_number: string | null }
  >
  /** Storage location id → name. */
  readonly storageLocationNames: ReadonlyMap<string, string>
  /** Retailer id → name. */
  readonly retailerNames: ReadonlyMap<string, string>
}

// ---------------------------------------------------------------------------
// Declared columns — the versioned CSV schema. Header and kind live side by side so a cell can
// never be sanitized (or left alone) by an accident of its position in a hand-written array.
// ---------------------------------------------------------------------------

const HOLDINGS_COLUMNS = [
  { header: 'Holding ID', kind: 'id' },
  { header: 'Card', kind: 'text' },
  { header: 'Set', kind: 'text' },
  { header: 'Number', kind: 'text' },
  { header: 'Variant', kind: 'text' },
  { header: 'Kind', kind: 'enum' },
  { header: 'Condition', kind: 'enum' },
  { header: 'Grade', kind: 'decimal' },
  { header: 'Grader', kind: 'enum' },
  { header: 'Cert number', kind: 'text' },
  { header: 'Live quantity', kind: 'integer' },
  { header: 'Favourite', kind: 'boolean' },
  { header: 'Tags', kind: 'text' },
  { header: 'Collections', kind: 'text' },
  { header: 'Notes', kind: 'text' },
  { header: 'Created at', kind: 'timestamp' },
  { header: 'Updated at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const ACQUISITION_LOTS_COLUMNS = [
  { header: 'Lot ID', kind: 'id' },
  { header: 'Holding ID', kind: 'id' },
  { header: 'Card', kind: 'text' },
  { header: 'Set', kind: 'text' },
  { header: 'Number', kind: 'text' },
  { header: 'Variant', kind: 'text' },
  { header: 'Origin', kind: 'enum' },
  { header: 'Cost basis state', kind: 'enum' },
  { header: 'Unit cost', kind: 'money' },
  { header: 'Currency', kind: 'enum' },
  { header: 'Unit cost NOK', kind: 'money' },
  { header: 'Residual', kind: 'money' },
  { header: 'Residual NOK', kind: 'money' },
  { header: 'Quantity', kind: 'integer' },
  { header: 'Quantity remaining', kind: 'integer' },
  { header: 'Sealed intent', kind: 'enum' },
  { header: 'Storage location', kind: 'text' },
  { header: 'Purchase line ID', kind: 'id' },
  { header: 'Acquired on', kind: 'date' },
  { header: 'Voided at', kind: 'timestamp' },
  { header: 'Notes', kind: 'text' },
  { header: 'Created at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const MANUAL_VALUATIONS_COLUMNS = [
  { header: 'Valuation ID', kind: 'id' },
  { header: 'Holding ID', kind: 'id' },
  { header: 'Card', kind: 'text' },
  { header: 'Set', kind: 'text' },
  { header: 'Effective from', kind: 'date' },
  { header: 'Value', kind: 'money' },
  { header: 'Currency', kind: 'enum' },
  { header: 'Value NOK', kind: 'money' },
  { header: 'Note', kind: 'text' },
  { header: 'Superseded at', kind: 'timestamp' },
  { header: 'Created at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const PURCHASES_COLUMNS = [
  { header: 'Purchase ID', kind: 'id' },
  { header: 'Purchased on', kind: 'date' },
  { header: 'Retailer', kind: 'text' },
  { header: 'Currency', kind: 'enum' },
  { header: 'Subtotal', kind: 'money' },
  { header: 'Shipping', kind: 'money' },
  { header: 'Customs', kind: 'money' },
  { header: 'Discount', kind: 'money' },
  { header: 'Total', kind: 'money' },
  { header: 'Total NOK', kind: 'money' },
  { header: 'FX rate to NOK', kind: 'rate' },
  { header: 'FX rate date', kind: 'date' },
  { header: 'FX source', kind: 'enum' },
  { header: 'Origin', kind: 'enum' },
  { header: 'Voided at', kind: 'timestamp' },
  { header: 'Notes', kind: 'text' },
  { header: 'Created at', kind: 'timestamp' },
  { header: 'Updated at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const PURCHASE_LINES_COLUMNS = [
  { header: 'Line ID', kind: 'id' },
  { header: 'Purchase ID', kind: 'id' },
  { header: 'Purchased on', kind: 'date' },
  { header: 'Line type', kind: 'enum' },
  { header: 'Spend class', kind: 'enum' },
  { header: 'Description', kind: 'text' },
  { header: 'Card', kind: 'text' },
  { header: 'Set', kind: 'text' },
  { header: 'Number', kind: 'text' },
  { header: 'Variant', kind: 'text' },
  { header: 'Condition', kind: 'enum' },
  { header: 'Quantity', kind: 'integer' },
  { header: 'Unit price', kind: 'money' },
  { header: 'Line total', kind: 'money' },
  { header: 'Allocated shipping', kind: 'money' },
  { header: 'Allocated customs', kind: 'money' },
  { header: 'Allocated discount', kind: 'money' },
  { header: 'Attributable cost', kind: 'money' },
  { header: 'Attributable cost NOK', kind: 'money' },
  { header: 'Created at', kind: 'timestamp' },
  // v2 (additive): the currency of every non-NOK amount above — the parent purchase's currency.
  { header: 'Currency', kind: 'enum' },
] as const satisfies readonly CsvColumn[]

const SALES_COLUMNS = [
  { header: 'Sale ID', kind: 'id' },
  { header: 'Sold on', kind: 'date' },
  { header: 'Marketplace', kind: 'text' },
  { header: 'Currency', kind: 'enum' },
  { header: 'Gross', kind: 'money' },
  { header: 'Fees', kind: 'money' },
  { header: 'Shipping cost', kind: 'money' },
  { header: 'Shipping charged', kind: 'money' },
  { header: 'Net proceeds', kind: 'money' },
  { header: 'Net proceeds NOK', kind: 'money' },
  { header: 'Realized result NOK', kind: 'money' },
  { header: 'Proceeds from uncosted NOK', kind: 'money' },
  { header: 'FX rate to NOK', kind: 'rate' },
  { header: 'FX rate date', kind: 'date' },
  { header: 'FX source', kind: 'enum' },
  { header: 'Voided at', kind: 'timestamp' },
  { header: 'Notes', kind: 'text' },
  { header: 'Created at', kind: 'timestamp' },
  { header: 'Updated at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const SALE_LINES_COLUMNS = [
  { header: 'Line ID', kind: 'id' },
  { header: 'Sale ID', kind: 'id' },
  { header: 'Sold on', kind: 'date' },
  { header: 'Lot ID', kind: 'id' },
  { header: 'Card', kind: 'text' },
  { header: 'Set', kind: 'text' },
  { header: 'Number', kind: 'text' },
  { header: 'Variant', kind: 'text' },
  { header: 'Quantity', kind: 'integer' },
  { header: 'Unit gross', kind: 'money' },
  { header: 'Line gross', kind: 'money' },
  { header: 'Allocated fees', kind: 'money' },
  { header: 'Allocated shipping', kind: 'money' },
  { header: 'Allocated shipping charged', kind: 'money' },
  { header: 'Net proceeds', kind: 'money' },
  { header: 'Net proceeds NOK', kind: 'money' },
  { header: 'Cost basis NOK', kind: 'money' },
  { header: 'Realized result NOK', kind: 'money' },
  { header: 'Created at', kind: 'timestamp' },
  // v2 (additive): the currency of every non-NOK amount above — the parent sale's currency.
  { header: 'Currency', kind: 'enum' },
] as const satisfies readonly CsvColumn[]

const LOT_DISPOSALS_COLUMNS = [
  { header: 'Disposal ID', kind: 'id' },
  { header: 'Lot ID', kind: 'id' },
  { header: 'Card', kind: 'text' },
  { header: 'Kind', kind: 'enum' },
  { header: 'Disposed on', kind: 'date' },
  { header: 'Quantity', kind: 'integer' },
  { header: 'Cost basis NOK', kind: 'money' },
  { header: 'Sale line ID', kind: 'id' },
  { header: 'Voided at', kind: 'timestamp' },
  { header: 'Created at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const LOT_COST_ADJUSTMENTS_COLUMNS = [
  { header: 'Adjustment ID', kind: 'id' },
  { header: 'Lot ID', kind: 'id' },
  { header: 'Kind', kind: 'enum' },
  { header: 'Occurred on', kind: 'date' },
  { header: 'Amount', kind: 'money' },
  { header: 'Currency', kind: 'enum' },
  { header: 'Amount NOK', kind: 'money' },
  { header: 'Note', kind: 'text' },
  { header: 'Purchase line ID', kind: 'id' },
  { header: 'Created at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const OPENINGS_COLUMNS = [
  { header: 'Opening ID', kind: 'id' },
  { header: 'Date', kind: 'date' },
  { header: 'Product', kind: 'text' },
  { header: 'Quantity', kind: 'integer' },
  { header: 'Opening cost NOK', kind: 'money' },
  { header: 'Cost source', kind: 'enum' },
  { header: 'Tracking completeness', kind: 'enum' },
  { header: 'Bulk remainder estimate NOK', kind: 'money' },
  { header: 'Bulk remainder count', kind: 'integer' },
  { header: 'Purchase provenance', kind: 'enum' },
  { header: 'Reconciliation', kind: 'enum' },
  { header: 'Voided at', kind: 'timestamp' },
  { header: 'Notes', kind: 'text' },
  { header: 'Created at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

const CUSTOM_COLLECTIONS_COLUMNS = [
  { header: 'Collection ID', kind: 'id' },
  { header: 'Name', kind: 'text' },
  { header: 'Description', kind: 'text' },
  { header: 'Colour', kind: 'text' },
  { header: 'Sort order', kind: 'integer' },
  { header: 'Member holding IDs', kind: 'text' },
  { header: 'Created at', kind: 'timestamp' },
] as const satisfies readonly CsvColumn[]

/** The whole declared schema, keyed by file — the single source for docs and the golden test. */
export const EXPORT_CSV_SCHEMA: Readonly<Record<ExportCsvFilename, readonly CsvColumn[]>> = {
  'holdings.csv': HOLDINGS_COLUMNS,
  'acquisition_lots.csv': ACQUISITION_LOTS_COLUMNS,
  'manual_valuations.csv': MANUAL_VALUATIONS_COLUMNS,
  'purchases.csv': PURCHASES_COLUMNS,
  'purchase_lines.csv': PURCHASE_LINES_COLUMNS,
  'sales.csv': SALES_COLUMNS,
  'sale_lines.csv': SALE_LINES_COLUMNS,
  'lot_disposals.csv': LOT_DISPOSALS_COLUMNS,
  'lot_cost_adjustments.csv': LOT_COST_ADJUSTMENTS_COLUMNS,
  'openings.csv': OPENINGS_COLUMNS,
  'custom_collections.csv': CUSTOM_COLLECTIONS_COLUMNS,
}

// ---------------------------------------------------------------------------
// Identity display columns (all free text — the writer sanitizes by column kind)
// ---------------------------------------------------------------------------

interface IdentityColumns {
  readonly cardName: string
  readonly setName: string
  readonly collectorNumber: string
  readonly variant: string
}

const NO_IDENTITY: IdentityColumns = { cardName: '', setName: '', collectorNumber: '', variant: '' }

function variantIdentity(entry: ManifestCardVariantEntry): IdentityColumns {
  const descriptor = [entry.finish, entry.subtype, entry.stamp]
    .filter((part) => part !== '' && part !== 'normal')
    .join(' · ')
  return {
    cardName: entry.card_name ?? '',
    setName: entry.set_name ?? '',
    collectorNumber: entry.card_local_id ?? '',
    variant: descriptor,
  }
}

function identityFor(holding: BackupHoldingRow, input: CsvProjectionInput): IdentityColumns {
  if (holding.card_variant_id !== null) {
    const entry = input.variantIndex.get(holding.card_variant_id)
    return entry ? variantIdentity(entry) : NO_IDENTITY
  }
  if (holding.sealed_product_id !== null) {
    return {
      ...NO_IDENTITY,
      cardName: input.sealedProductNames.get(holding.sealed_product_id) ?? '',
    }
  }
  if (holding.manual_card_id !== null) {
    const entry = input.manualCardIndex.get(holding.manual_card_id)
    if (!entry) return NO_IDENTITY
    return {
      cardName: entry.name,
      setName: entry.set_name ?? '',
      collectorNumber: entry.collector_number ?? '',
      variant: '',
    }
  }
  return NO_IDENTITY
}

/** Identity columns for anything referencing a lot directly (sale lines, disposals). */
function identityForLot(
  lotId: string,
  lotsById: ReadonlyMap<string, BackupAcquisitionLotRow>,
  holdingsById: ReadonlyMap<string, BackupHoldingRow>,
  input: CsvProjectionInput,
): IdentityColumns {
  const lot = lotsById.get(lotId)
  if (!lot) return NO_IDENTITY
  const holding = holdingsById.get(lot.holding_id)
  return holding ? identityFor(holding, input) : NO_IDENTITY
}

function indexBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  const map = new Map<K, T>()
  for (const row of rows) map.set(key(row), row)
  return map
}

// ---------------------------------------------------------------------------
// holdings.csv — current-state portfolio view
// ---------------------------------------------------------------------------

export function buildHoldingsCsv(input: CsvProjectionInput): CsvFileContent {
  const tagNamesById = indexBy(input.tags, (t) => t.id)
  const collectionNamesById = indexBy(input.custom_collections, (c) => c.id)

  const tagsByHolding = new Map<string, string[]>()
  for (const ht of input.holding_tags) {
    const tagName = tagNamesById.get(ht.tag_id)?.name
    if (tagName === undefined) continue
    const list = tagsByHolding.get(ht.holding_id) ?? []
    list.push(tagName)
    tagsByHolding.set(ht.holding_id, list)
  }

  const collectionsByHolding = new Map<string, string[]>()
  for (const member of input.custom_collection_members) {
    const name = collectionNamesById.get(member.collection_id)?.name
    if (name === undefined) continue
    const list = collectionsByHolding.get(member.holding_id) ?? []
    list.push(name)
    collectionsByHolding.set(member.holding_id, list)
  }

  // Live physical copies per holding = Σ quantity over non-voided lots (integer counting only;
  // tombstoned holdings are excluded from the view below but their lots still feed nothing here).
  const liveQuantity = new Map<string, number>()
  for (const lot of input.acquisition_lots) {
    if (lot.voided_at !== null || lot.quantity_remaining <= 0) continue
    liveQuantity.set(
      lot.holding_id,
      (liveQuantity.get(lot.holding_id) ?? 0) + lot.quantity_remaining,
    )
  }

  const rows = input.holdings
    .filter((h) => h.deleted_at === null)
    .map((h) => {
      const identity = identityFor(h, input)
      return [
        h.id,
        identity.cardName,
        identity.setName,
        identity.collectorNumber,
        identity.variant,
        h.holding_kind,
        h.condition,
        h.grade === null ? null : String(h.grade),
        h.grader,
        h.cert_number,
        String(liveQuantity.get(h.id) ?? 0),
        csvBoolean(h.is_favorite),
        (tagsByHolding.get(h.id) ?? []).join('; '),
        (collectionsByHolding.get(h.id) ?? []).join('; '),
        h.notes,
        h.created_at,
        h.updated_at,
      ]
    })
  return { filename: 'holdings.csv', text: buildTypedCsvText(HOLDINGS_COLUMNS, rows) }
}

// ---------------------------------------------------------------------------
// acquisition_lots.csv — full per-lot cost provenance
// ---------------------------------------------------------------------------

export function buildAcquisitionLotsCsv(input: CsvProjectionInput): CsvFileContent {
  const holdingsById = indexBy(input.holdings, (h) => h.id)
  const rows = input.acquisition_lots.map((lot) => {
    const holding = holdingsById.get(lot.holding_id)
    const identity = holding ? identityFor(holding, input) : NO_IDENTITY
    const currency = lot.cost_basis_currency
    return [
      lot.id,
      lot.holding_id,
      identity.cardName,
      identity.setName,
      identity.collectorNumber,
      identity.variant,
      lot.origin,
      lot.cost_basis_state,
      csvMoney(lot.unit_cost_basis_minor, currency ?? ''),
      currency,
      csvMoney(lot.unit_cost_basis_nok_minor, 'NOK'),
      csvMoney(lot.residual_minor, currency ?? ''),
      csvMoney(lot.residual_nok_minor, 'NOK'),
      String(lot.quantity),
      String(lot.quantity_remaining),
      lot.sealed_intent,
      lot.storage_location_id === null
        ? null
        : (input.storageLocationNames.get(lot.storage_location_id) ?? null),
      lot.purchase_line_id,
      lot.acquired_on,
      lot.voided_at,
      lot.notes,
      lot.created_at,
    ]
  })
  return {
    filename: 'acquisition_lots.csv',
    text: buildTypedCsvText(ACQUISITION_LOTS_COLUMNS, rows),
  }
}

// ---------------------------------------------------------------------------
// manual_valuations.csv — full history including superseded rows
// ---------------------------------------------------------------------------

export function buildManualValuationsCsv(input: CsvProjectionInput): CsvFileContent {
  const holdingsById = indexBy(input.holdings, (h) => h.id)
  const rows = input.manual_valuations.map((v) => {
    const holding = holdingsById.get(v.holding_id)
    const identity = holding ? identityFor(holding, input) : NO_IDENTITY
    return [
      v.id,
      v.holding_id,
      identity.cardName,
      identity.setName,
      v.effective_from,
      csvMoney(v.value_minor, v.currency),
      v.currency,
      csvMoney(v.value_nok_minor, 'NOK'),
      v.note,
      v.superseded_at,
      v.created_at,
    ]
  })
  return {
    filename: 'manual_valuations.csv',
    text: buildTypedCsvText(MANUAL_VALUATIONS_COLUMNS, rows),
  }
}

// ---------------------------------------------------------------------------
// purchases.csv / purchase_lines.csv
// ---------------------------------------------------------------------------

export function buildPurchasesCsv(input: CsvProjectionInput): CsvFileContent {
  const rows = input.purchases.map((p) => [
    p.id,
    p.purchased_on,
    p.retailer_id === null ? null : (input.retailerNames.get(p.retailer_id) ?? null),
    p.currency,
    csvMoney(p.subtotal_minor, p.currency),
    csvMoney(p.shipping_minor, p.currency),
    csvMoney(p.customs_minor, p.currency),
    csvMoney(p.discount_minor, p.currency),
    csvMoney(p.total_minor, p.currency),
    csvMoney(p.total_nok_minor, 'NOK'),
    p.fx_rate_to_nok,
    p.fx_rate_date,
    p.fx_source,
    p.origin,
    p.voided_at,
    p.notes,
    p.created_at,
    p.updated_at,
  ])
  return { filename: 'purchases.csv', text: buildTypedCsvText(PURCHASES_COLUMNS, rows) }
}

function lineIdentity(
  line: Pick<BackupPurchaseLineRow, 'card_variant_id' | 'sealed_product_id'>,
  input: CsvProjectionInput,
): IdentityColumns {
  if (line.card_variant_id !== null) {
    const entry = input.variantIndex.get(line.card_variant_id)
    return entry ? variantIdentity(entry) : NO_IDENTITY
  }
  if (line.sealed_product_id !== null) {
    return {
      ...NO_IDENTITY,
      cardName: input.sealedProductNames.get(line.sealed_product_id) ?? '',
    }
  }
  return NO_IDENTITY
}

export function buildPurchaseLinesCsv(input: CsvProjectionInput): CsvFileContent {
  const purchasesById = indexBy(input.purchases, (p) => p.id)
  const rows = input.purchase_lines.map((line) => {
    const identity = lineIdentity(line, input)
    const purchase = purchasesById.get(line.purchase_id)
    const currency = purchase?.currency ?? ''
    return [
      line.id,
      line.purchase_id,
      purchase?.purchased_on ?? null,
      line.line_type,
      line.spend_class,
      line.description,
      identity.cardName,
      identity.setName,
      identity.collectorNumber,
      identity.variant,
      line.condition,
      String(line.quantity),
      csvMoney(line.unit_price_minor, currency),
      csvMoney(line.line_total_minor, currency),
      csvMoney(line.allocated_shipping_minor, currency),
      csvMoney(line.allocated_customs_minor, currency),
      csvMoney(line.allocated_discount_minor, currency),
      csvMoney(line.attributable_cost_minor, currency),
      csvMoney(line.attributable_cost_nok_minor, 'NOK'),
      line.created_at,
      currency === '' ? null : currency,
    ]
  })
  return {
    filename: 'purchase_lines.csv',
    text: buildTypedCsvText(PURCHASE_LINES_COLUMNS, rows),
  }
}

// ---------------------------------------------------------------------------
// sales.csv / sale_lines.csv
// ---------------------------------------------------------------------------

export function buildSalesCsv(input: CsvProjectionInput): CsvFileContent {
  const rows = input.sales.map((s) => [
    s.id,
    s.sold_on,
    s.marketplace,
    s.currency,
    csvMoney(s.gross_minor, s.currency),
    csvMoney(s.fees_minor, s.currency),
    csvMoney(s.shipping_cost_minor, s.currency),
    csvMoney(s.shipping_charged_minor, s.currency),
    csvMoney(s.net_proceeds_minor, s.currency),
    csvMoney(s.net_proceeds_nok_minor, 'NOK'),
    csvMoney(s.realized_result_nok_minor, 'NOK'),
    csvMoney(s.proceeds_from_uncosted_nok_minor, 'NOK'),
    s.fx_rate_to_nok,
    s.fx_rate_date,
    s.fx_source,
    s.voided_at,
    s.notes,
    s.created_at,
    s.updated_at,
  ])
  return { filename: 'sales.csv', text: buildTypedCsvText(SALES_COLUMNS, rows) }
}

export function buildSaleLinesCsv(input: CsvProjectionInput): CsvFileContent {
  const salesById = indexBy(input.sales, (s) => s.id)
  const lotsById = indexBy(input.acquisition_lots, (l) => l.id)
  const holdingsById = indexBy(input.holdings, (h) => h.id)
  const rows = input.sale_lines.map((line) => {
    const identity = identityForLot(line.lot_id, lotsById, holdingsById, input)
    const sale = salesById.get(line.sale_id)
    const currency = sale?.currency ?? ''
    return [
      line.id,
      line.sale_id,
      sale?.sold_on ?? null,
      line.lot_id,
      identity.cardName,
      identity.setName,
      identity.collectorNumber,
      identity.variant,
      String(line.quantity),
      csvMoney(line.unit_gross_minor, currency),
      csvMoney(line.line_gross_minor, currency),
      csvMoney(line.allocated_fees_minor, currency),
      csvMoney(line.allocated_shipping_minor, currency),
      csvMoney(line.allocated_shipping_charged_minor, currency),
      csvMoney(line.net_proceeds_minor, currency),
      csvMoney(line.net_proceeds_nok_minor, 'NOK'),
      // Unknown basis stays empty — never a fabricated zero result (D-060 honesty).
      csvMoney(line.cost_basis_at_sale_nok_minor, 'NOK'),
      csvMoney(line.realized_result_nok_minor, 'NOK'),
      line.created_at,
      currency === '' ? null : currency,
    ]
  })
  return { filename: 'sale_lines.csv', text: buildTypedCsvText(SALE_LINES_COLUMNS, rows) }
}

// ---------------------------------------------------------------------------
// lot_disposals.csv / lot_cost_adjustments.csv
// ---------------------------------------------------------------------------

export function buildLotDisposalsCsv(input: CsvProjectionInput): CsvFileContent {
  const lotsById = indexBy(input.acquisition_lots, (l) => l.id)
  const holdingsById = indexBy(input.holdings, (h) => h.id)
  const rows = input.lot_disposals.map((d) => {
    const identity = identityForLot(d.lot_id, lotsById, holdingsById, input)
    return [
      d.id,
      d.lot_id,
      identity.cardName,
      d.kind,
      d.disposed_on,
      String(d.quantity),
      csvMoney(d.cost_basis_at_disposal_nok_minor, 'NOK'),
      d.sale_line_id,
      d.voided_at,
      d.created_at,
    ]
  })
  return {
    filename: 'lot_disposals.csv',
    text: buildTypedCsvText(LOT_DISPOSALS_COLUMNS, rows),
  }
}

export function buildLotCostAdjustmentsCsv(input: CsvProjectionInput): CsvFileContent {
  const rows = input.lot_cost_adjustments.map((a) => [
    a.id,
    a.lot_id,
    a.kind,
    a.occurred_on,
    csvMoney(a.amount_minor, a.currency),
    a.currency,
    csvMoney(a.amount_nok_minor, 'NOK'),
    a.note,
    a.purchase_line_id,
    a.created_at,
  ])
  return {
    filename: 'lot_cost_adjustments.csv',
    text: buildTypedCsvText(LOT_COST_ADJUSTMENTS_COLUMNS, rows),
  }
}

// ---------------------------------------------------------------------------
// openings.csv — one row per opening (P53 §23). Analysis projection: no pull
// cost basis exists to export (pulls deliberately carry none — the acquisition/
// holdings files already render pulled cards as ordinary inventory), and no
// internal privilege/security state of any kind.
// ---------------------------------------------------------------------------

export function buildOpeningsCsv(input: CsvProjectionInput): CsvFileContent {
  const rows = input.openings.map((o) => [
    o.id,
    o.opened_on,
    input.sealedProductNames.get(o.sealed_product_id) ?? null,
    String(o.quantity_opened),
    // Unknown cost stays an empty cell — never a fabricated 0.00 (M1 at opening scope).
    csvMoney(o.cost_nok_minor, 'NOK'),
    o.cost_source,
    o.tracking_completeness,
    csvMoney(o.bulk_remainder_estimate_nok_minor, 'NOK'),
    o.bulk_remainder_count === null ? null : String(o.bulk_remainder_count),
    o.provisional_purchase_id === null ? null : 'provisional',
    o.reconciled_at === null ? null : 'reconciled',
    o.voided_at,
    o.notes,
    o.created_at,
  ])
  return { filename: 'openings.csv', text: buildTypedCsvText(OPENINGS_COLUMNS, rows) }
}

// ---------------------------------------------------------------------------
// custom_collections.csv
// ---------------------------------------------------------------------------

export function buildCustomCollectionsCsv(input: CsvProjectionInput): CsvFileContent {
  const membersByCollection = new Map<string, string[]>()
  for (const member of input.custom_collection_members) {
    const list = membersByCollection.get(member.collection_id) ?? []
    list.push(member.holding_id)
    membersByCollection.set(member.collection_id, list)
  }
  const rows = input.custom_collections.map((c) => [
    c.id,
    c.name,
    c.description,
    c.color,
    String(c.sort_order),
    (membersByCollection.get(c.id) ?? []).join('; '),
    c.created_at,
  ])
  return {
    filename: 'custom_collections.csv',
    text: buildTypedCsvText(CUSTOM_COLLECTIONS_COLUMNS, rows),
  }
}

/** Builds every CSV file in stable {@link EXPORT_CSV_FILENAMES} order. Pure. */
export function buildCsvSuite(input: CsvProjectionInput): CsvFileContent[] {
  return [
    buildHoldingsCsv(input),
    buildAcquisitionLotsCsv(input),
    buildManualValuationsCsv(input),
    buildPurchasesCsv(input),
    buildPurchaseLinesCsv(input),
    buildSalesCsv(input),
    buildSaleLinesCsv(input),
    buildLotDisposalsCsv(input),
    buildLotCostAdjustmentsCsv(input),
    buildOpeningsCsv(input),
    buildCustomCollectionsCsv(input),
  ]
}
