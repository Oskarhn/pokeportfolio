/**
 * The bounded M13 CSV export suite — human/analysis projections, NOT lossless backups
 * (the JSON envelope is the lossless artifact). Column contracts:
 *
 * - Stable column order; headers are plain English labels (CSV is for humans/spreadsheets).
 * - Money renders as decimal strings using the currency's minor-unit exponent, with an explicit
 *   currency column beside every original-currency amount; frozen NOK amounts say _nok.
 * - An empty cell means "not applicable / unknown" — NEVER a fabricated zero. Genuine zero
 *   renders as 0.00 (or 0 for zero-exponent currencies).
 * - Dates are YYYY-MM-DD; timestamps verbatim ISO 8601 as returned by PostgREST.
 * - Free-text cells are formula-injection-sanitized; numeric/date/enum/id cells are emitted
 *   canonically so legitimate negatives survive (see csv.ts).
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
  BackupPurchaseLineRow,
  BackupPurchaseRow,
  BackupSaleLineRow,
  BackupSaleRow,
  BackupTagRow,
  ManifestCardVariantEntry,
} from './backup-format'
import { buildCsvText, csvBoolean, csvFreeText, csvMoney } from './csv'
import type { ExportSnapshot } from './snapshot-types'

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
    cardName: csvFreeText(entry.card_name),
    setName: csvFreeText(entry.set_name),
    collectorNumber: csvFreeText(entry.card_local_id),
    variant: csvFreeText(descriptor === '' ? null : descriptor),
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
      cardName: csvFreeText(input.sealedProductNames.get(holding.sealed_product_id) ?? null),
    }
  }
  if (holding.manual_card_id !== null) {
    const entry = input.manualCardIndex.get(holding.manual_card_id)
    if (!entry) return NO_IDENTITY
    return {
      cardName: csvFreeText(entry.name),
      setName: csvFreeText(entry.set_name),
      collectorNumber: csvFreeText(entry.collector_number),
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
        h.condition ?? '',
        h.grade === null ? '' : String(h.grade),
        h.grader ?? '',
        csvFreeText(h.cert_number),
        String(liveQuantity.get(h.id) ?? 0),
        csvBoolean(h.is_favorite),
        csvFreeText((tagsByHolding.get(h.id) ?? []).join('; ') || null),
        csvFreeText((collectionsByHolding.get(h.id) ?? []).join('; ') || null),
        csvFreeText(h.notes),
        h.created_at,
        h.updated_at,
      ]
    })
  return {
    filename: 'holdings.csv',
    text: buildCsvText(
      [
        'Holding ID',
        'Card',
        'Set',
        'Number',
        'Variant',
        'Kind',
        'Condition',
        'Grade',
        'Grader',
        'Cert number',
        'Live quantity',
        'Favourite',
        'Tags',
        'Collections',
        'Notes',
        'Created at',
        'Updated at',
      ],
      rows,
    ),
  }
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
      currency ?? '',
      csvMoney(lot.unit_cost_basis_nok_minor, 'NOK'),
      csvMoney(lot.residual_minor, currency ?? ''),
      csvMoney(lot.residual_nok_minor, 'NOK'),
      String(lot.quantity),
      String(lot.quantity_remaining),
      lot.sealed_intent ?? '',
      csvFreeText(
        lot.storage_location_id === null
          ? null
          : (input.storageLocationNames.get(lot.storage_location_id) ?? null),
      ),
      lot.purchase_line_id ?? '',
      lot.acquired_on,
      lot.voided_at ?? '',
      csvFreeText(lot.notes),
      lot.created_at,
    ]
  })
  return {
    filename: 'acquisition_lots.csv',
    text: buildCsvText(
      [
        'Lot ID',
        'Holding ID',
        'Card',
        'Set',
        'Number',
        'Variant',
        'Origin',
        'Cost basis state',
        'Unit cost',
        'Currency',
        'Unit cost NOK',
        'Residual',
        'Residual NOK',
        'Quantity',
        'Quantity remaining',
        'Sealed intent',
        'Storage location',
        'Purchase line ID',
        'Acquired on',
        'Voided at',
        'Notes',
        'Created at',
      ],
      rows,
    ),
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
      csvFreeText(v.note),
      v.superseded_at ?? '',
      v.created_at,
    ]
  })
  return {
    filename: 'manual_valuations.csv',
    text: buildCsvText(
      [
        'Valuation ID',
        'Holding ID',
        'Card',
        'Set',
        'Effective from',
        'Value',
        'Currency',
        'Value NOK',
        'Note',
        'Superseded at',
        'Created at',
      ],
      rows,
    ),
  }
}

// ---------------------------------------------------------------------------
// purchases.csv / purchase_lines.csv
// ---------------------------------------------------------------------------

export function buildPurchasesCsv(input: CsvProjectionInput): CsvFileContent {
  const rows = input.purchases.map((p) => [
    p.id,
    p.purchased_on,
    csvFreeText(p.retailer_id === null ? null : (input.retailerNames.get(p.retailer_id) ?? null)),
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
    p.voided_at ?? '',
    csvFreeText(p.notes),
    p.created_at,
    p.updated_at,
  ])
  return {
    filename: 'purchases.csv',
    text: buildCsvText(
      [
        'Purchase ID',
        'Purchased on',
        'Retailer',
        'Currency',
        'Subtotal',
        'Shipping',
        'Customs',
        'Discount',
        'Total',
        'Total NOK',
        'FX rate to NOK',
        'FX rate date',
        'FX source',
        'Origin',
        'Voided at',
        'Notes',
        'Created at',
        'Updated at',
      ],
      rows,
    ),
  }
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
      cardName: csvFreeText(input.sealedProductNames.get(line.sealed_product_id) ?? null),
    }
  }
  return NO_IDENTITY
}

export function buildPurchaseLinesCsv(input: CsvProjectionInput): CsvFileContent {
  const purchasesById = indexBy(input.purchases, (p) => p.id)
  const rows = input.purchase_lines.map((line) => {
    const identity = lineIdentity(line, input)
    const purchasedOn = purchasesById.get(line.purchase_id)?.purchased_on ?? ''
    return [
      line.id,
      line.purchase_id,
      purchasedOn,
      line.line_type,
      line.spend_class,
      csvFreeText(line.description),
      identity.cardName,
      identity.setName,
      identity.collectorNumber,
      identity.variant,
      line.condition ?? '',
      String(line.quantity),
      csvMoney(line.unit_price_minor, purchasesById.get(line.purchase_id)?.currency ?? ''),
      csvMoney(line.line_total_minor, purchasesById.get(line.purchase_id)?.currency ?? ''),
      csvMoney(line.allocated_shipping_minor, purchasesById.get(line.purchase_id)?.currency ?? ''),
      csvMoney(line.allocated_customs_minor, purchasesById.get(line.purchase_id)?.currency ?? ''),
      csvMoney(line.allocated_discount_minor, purchasesById.get(line.purchase_id)?.currency ?? ''),
      csvMoney(line.attributable_cost_minor, purchasesById.get(line.purchase_id)?.currency ?? ''),
      csvMoney(line.attributable_cost_nok_minor, 'NOK'),
      line.created_at,
    ]
  })
  return {
    filename: 'purchase_lines.csv',
    text: buildCsvText(
      [
        'Line ID',
        'Purchase ID',
        'Purchased on',
        'Line type',
        'Spend class',
        'Description',
        'Card',
        'Set',
        'Number',
        'Variant',
        'Condition',
        'Quantity',
        'Unit price',
        'Line total',
        'Allocated shipping',
        'Allocated customs',
        'Allocated discount',
        'Attributable cost',
        'Attributable cost NOK',
        'Created at',
      ],
      rows,
    ),
  }
}

// ---------------------------------------------------------------------------
// sales.csv / sale_lines.csv
// ---------------------------------------------------------------------------

export function buildSalesCsv(input: CsvProjectionInput): CsvFileContent {
  const rows = input.sales.map((s) => [
    s.id,
    s.sold_on,
    csvFreeText(s.marketplace),
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
    s.voided_at ?? '',
    csvFreeText(s.notes),
    s.created_at,
    s.updated_at,
  ])
  return {
    filename: 'sales.csv',
    text: buildCsvText(
      [
        'Sale ID',
        'Sold on',
        'Marketplace',
        'Currency',
        'Gross',
        'Fees',
        'Shipping cost',
        'Shipping charged',
        'Net proceeds',
        'Net proceeds NOK',
        'Realized result NOK',
        'Proceeds from uncosted NOK',
        'FX rate to NOK',
        'FX rate date',
        'FX source',
        'Voided at',
        'Notes',
        'Created at',
        'Updated at',
      ],
      rows,
    ),
  }
}

export function buildSaleLinesCsv(input: CsvProjectionInput): CsvFileContent {
  const salesById = indexBy(input.sales, (s) => s.id)
  const lotsById = indexBy(input.acquisition_lots, (l) => l.id)
  const holdingsById = indexBy(input.holdings, (h) => h.id)
  const rows = input.sale_lines.map((line) => {
    const identity = identityForLot(line.lot_id, lotsById, holdingsById, input)
    return [
      line.id,
      line.sale_id,
      salesById.get(line.sale_id)?.sold_on ?? '',
      line.lot_id,
      identity.cardName,
      identity.setName,
      identity.collectorNumber,
      identity.variant,
      String(line.quantity),
      csvMoney(line.unit_gross_minor, salesById.get(line.sale_id)?.currency ?? ''),
      csvMoney(line.line_gross_minor, salesById.get(line.sale_id)?.currency ?? ''),
      csvMoney(line.allocated_fees_minor, salesById.get(line.sale_id)?.currency ?? ''),
      csvMoney(line.allocated_shipping_minor, salesById.get(line.sale_id)?.currency ?? ''),
      csvMoney(line.allocated_shipping_charged_minor, salesById.get(line.sale_id)?.currency ?? ''),
      csvMoney(line.net_proceeds_minor, salesById.get(line.sale_id)?.currency ?? ''),
      csvMoney(line.net_proceeds_nok_minor, 'NOK'),
      // Unknown basis stays empty — never a fabricated zero result (D-060 honesty).
      csvMoney(line.cost_basis_at_sale_nok_minor, 'NOK'),
      csvMoney(line.realized_result_nok_minor, 'NOK'),
      line.created_at,
    ]
  })
  return {
    filename: 'sale_lines.csv',
    text: buildCsvText(
      [
        'Line ID',
        'Sale ID',
        'Sold on',
        'Lot ID',
        'Card',
        'Set',
        'Number',
        'Variant',
        'Quantity',
        'Unit gross',
        'Line gross',
        'Allocated fees',
        'Allocated shipping',
        'Allocated shipping charged',
        'Net proceeds',
        'Net proceeds NOK',
        'Cost basis NOK',
        'Realized result NOK',
        'Created at',
      ],
      rows,
    ),
  }
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
      d.sale_line_id ?? '',
      d.voided_at ?? '',
      d.created_at,
    ]
  })
  return {
    filename: 'lot_disposals.csv',
    text: buildCsvText(
      [
        'Disposal ID',
        'Lot ID',
        'Card',
        'Kind',
        'Disposed on',
        'Quantity',
        'Cost basis NOK',
        'Sale line ID',
        'Voided at',
        'Created at',
      ],
      rows,
    ),
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
    csvFreeText(a.note),
    a.purchase_line_id,
    a.created_at,
  ])
  return {
    filename: 'lot_cost_adjustments.csv',
    text: buildCsvText(
      [
        'Adjustment ID',
        'Lot ID',
        'Kind',
        'Occurred on',
        'Amount',
        'Currency',
        'Amount NOK',
        'Note',
        'Purchase line ID',
        'Created at',
      ],
      rows,
    ),
  }
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
    csvFreeText(c.name),
    csvFreeText(c.description),
    csvFreeText(c.color),
    String(c.sort_order),
    csvFreeText((membersByCollection.get(c.id) ?? []).join('; ') || null),
    c.created_at,
  ])
  return {
    filename: 'custom_collections.csv',
    text: buildCsvText(
      [
        'Collection ID',
        'Name',
        'Description',
        'Colour',
        'Sort order',
        'Member holding IDs',
        'Created at',
      ],
      rows,
    ),
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
    buildCustomCollectionsCsv(input),
  ]
}
