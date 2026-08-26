/**
 * The versioned JSON backup format (M13, D-025). Pure TypeScript — this module defines the
 * contract only; fetching lives in src/data/export/, serialization in build-backup.ts.
 *
 * Design rules (PRODUCT_SPEC.md §4.12, FINANCIAL_MODEL.md §1, output_m13_research.txt):
 *
 * - Restore is NOT part of M13. The format is nonetheless designed so a future restore can
 *   proceed without inventing anything that was not exported: verbatim database column names,
 *   lossless values, stable ids, and an identity manifest for shared-catalog references.
 * - Every monetary field is serialized as a decimal STRING of integer minor units (the
 *   established PostgREST bigint boundary, src/data/money.ts). Strings survive arbitrary
 *   magnitudes past Number.MAX_SAFE_INTEGER and can never silently round. A money string never
 *   carries an exponent or fraction.
 * - `null` always means "not applicable / unknown" and is preserved as null — never coalesced
 *   to zero (invariant M1). Genuine zero serializes as "0".
 * - Dates are YYYY-MM-DD calendar dates; timestamps are ISO 8601 strings exactly as PostgREST
 *   returned them. Nothing is re-formatted or timezone-converted.
 * - Excluded by design: derived caches (portfolio_snapshots, recompute queue/runs), global
 *   market data (price_snapshots, fx_rates), operator/security tables (invitations*, catalog
 *   sync runs, price sync runs) and auth internals. Privilege-relevant profile columns
 *   (`is_admin`, `disabled_at`) are excluded so restoring a backup can never elevate privilege.
 * - Compatibility policy (v1, D-076): `format` identifies the artifact kind; `schema_version`
 *   bumps on ANY change to the canonical `data` shape below — a new required key, a changed
 *   key name, a changed row semantic or a new canonical section all bump it. Version-1 readers
 *   refuse unknown versions AND unknown data keys (the validator rejects both), so there is no
 *   within-v1 forward compatibility to claim: a future v2 writer produces v2 files and a
 *   future v2 reader owns reading them. UI labels are never part of this contract.
 */

/** Stable artifact identifier. Never localized, never renamed without a schema_version bump. */
export const BACKUP_FORMAT_ID = 'pokeportfolio-backup'

/**
 * Current envelope schema version. Bump on ANY breaking change to the shapes below.
 *
 * v1 — pre-Openings format (M13 through P48). Valid for its time; files produced before M16
 *      shipped remain faithful exports of the data that existed then.
 * v2 — Openings-capable format (M16): adds the canonical `data.openings` section and the two
 *      relationship columns (`acquisition_lots.opening_id`, `lot_disposals.opening_id`). A
 *      post-M16 writer emits v2 ONLY — a generated backup claiming v1 while openings exist
 *      would silently omit canonical data and is treated as a release blocker.
 */
export const BACKUP_SCHEMA_VERSION = 2

/** Matches what the ::text casts produce for bigint/numeric minor-unit columns. */
const MINOR_UNITS_PATTERN = /^-?\d+$/

/**
 * A monetary amount in exact integer minor units, carried as a string across the JSON boundary.
 * Brand-branded nominal type: at runtime it is just a string matching MINOR_UNITS_PATTERN.
 */
export type MinorUnitsString = string & { readonly __minorUnits: unique symbol }

export function isMinorUnitsString(value: unknown): value is MinorUnitsString {
  return typeof value === 'string' && MINOR_UNITS_PATTERN.test(value)
}

/**
 * Brands an exact decimal string of integer minor units at the trust boundary where it enters
 * the format. Throws on anything that is not one — a float that leaked through PostgREST as a
 * JSON number, a currency amount, or scientific notation must never enter a backup row.
 */
export function minorUnits(value: string): MinorUnitsString {
  if (!isMinorUnitsString(value)) {
    throw new TypeError(`Not exact integer minor units: ${JSON.stringify(value)}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Canonical user-owned rows (verbatim database column names)
// ---------------------------------------------------------------------------

/** Owner-configurable profile/preferences fields only. No role/admin flags (see module header). */
export interface BackupProfileRow {
  id: string
  display_name: string | null
  theme: string
  display_currency: string
  locale: string
  hide_values: boolean
  hide_low_value_by_default: boolean
  low_value_threshold_minor: MinorUnitsString
  use_eu_pricing: boolean
  collection_grid_density: number
  collection_default_view: string
  collection_default_sort: string
  default_condition: string | null
  default_language: string | null
  default_storage_location_id: string | null
  created_at: string
  updated_at: string
}

export interface BackupCustomCollectionRow {
  id: string
  user_id: string
  name: string
  description: string | null
  color: string | null
  sort_order: number
  created_at: string
}

export interface BackupCustomCollectionMemberRow {
  user_id: string
  collection_id: string
  holding_id: string
  sort_order: number
  added_at: string
}

export interface BackupTagRow {
  id: string
  user_id: string
  name: string
  created_at: string
  updated_at: string
}

export interface BackupHoldingTagRow {
  user_id: string
  holding_id: string
  tag_id: string
  created_at: string
}

export interface BackupStorageLocationRow {
  id: string
  user_id: string
  name: string
  kind: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface BackupRetailerRow {
  id: string
  user_id: string
  name: string
  notes: string | null
  created_at: string
  updated_at: string
}

export interface BackupHoldingRow {
  id: string
  user_id: string
  holding_kind: string
  card_variant_id: string | null
  sealed_product_id: string | null
  manual_card_id: string | null
  grading_state: string
  condition: string | null
  grader: string | null
  grade: number | null
  cert_number: string | null
  is_favorite: boolean
  notes: string | null
  /** Tombstone for holdings removed from Portfolio (quantity-removal feature). Preserved. */
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface BackupAcquisitionLotRow {
  id: string
  user_id: string
  holding_id: string
  purchase_line_id: string | null
  origin: string
  cost_basis_state: string
  cost_basis_currency: string | null
  /** NOT NULL iff cost_basis_state = 'known' (invariant M2); null otherwise — never zero-filled. */
  unit_cost_basis_minor: MinorUnitsString | null
  unit_cost_basis_nok_minor: MinorUnitsString | null
  residual_minor: MinorUnitsString
  residual_nok_minor: MinorUnitsString
  quantity: number
  quantity_remaining: number
  sealed_intent: string | null
  storage_location_id: string | null
  acquired_on: string
  /** v2 (M16): set on pulled-card lots — the opening that produced them. */
  opening_id: string | null
  voided_at: string | null
  notes: string | null
  created_at: string
}

export interface BackupManualCardDefinitionRow {
  id: string
  user_id: string
  name: string
  set_name: string | null
  collector_number: string | null
  language: string | null
  finish: string | null
  stamp: string | null
  subtype: string | null
  size: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

/** Only products created_by_user_id = the exporting owner. Curated rows live in the manifest. */
export interface BackupUserCreatedSealedProductRow {
  id: string
  created_by_user_id: string
  name: string
  product_type: string
  language: string
  pack_count: number | null
  set_id: string | null
  image_url: string | null
  cardmarket_product_id: string | null
  tcgplayer_product_id: string | null
  created_at: string
  updated_at: string
}

export interface BackupManualValuationRow {
  id: string
  user_id: string
  holding_id: string
  value_minor: MinorUnitsString
  currency: string
  value_nok_minor: MinorUnitsString
  effective_from: string
  note: string | null
  /** Superseded history is real data — exported, not collapsed to the latest row. */
  superseded_at: string | null
  created_at: string
}

export interface BackupLotCostAdjustmentRow {
  id: string
  user_id: string
  lot_id: string
  purchase_line_id: string
  kind: string
  occurred_on: string
  amount_minor: MinorUnitsString
  currency: string
  amount_nok_minor: MinorUnitsString
  note: string | null
  created_at: string
}

export interface BackupPurchaseRow {
  id: string
  user_id: string
  purchased_on: string
  retailer_id: string | null
  currency: string
  subtotal_minor: MinorUnitsString
  shipping_minor: MinorUnitsString
  customs_minor: MinorUnitsString
  discount_minor: MinorUnitsString
  total_minor: MinorUnitsString
  total_nok_minor: MinorUnitsString
  /** Frozen FX triple (F11): rate text exactly numeric(18,8) as stored, date, source. */
  fx_rate_to_nok: string
  fx_rate_date: string
  fx_source: string
  origin: string
  notes: string | null
  voided_at: string | null
  created_at: string
  updated_at: string
}

export interface BackupPurchaseLineRow {
  id: string
  user_id: string
  purchase_id: string
  line_type: string
  spend_class: string
  description: string | null
  card_variant_id: string | null
  sealed_product_id: string | null
  condition: string | null
  quantity: number
  unit_price_minor: MinorUnitsString
  line_total_minor: MinorUnitsString
  allocated_shipping_minor: MinorUnitsString
  allocated_customs_minor: MinorUnitsString
  allocated_discount_minor: MinorUnitsString
  attributable_cost_minor: MinorUnitsString
  attributable_cost_nok_minor: MinorUnitsString
  created_at: string
  updated_at: string
}

export interface BackupSaleRow {
  id: string
  user_id: string
  sold_on: string
  marketplace: string | null
  currency: string
  gross_minor: MinorUnitsString
  fees_minor: MinorUnitsString
  shipping_cost_minor: MinorUnitsString
  shipping_charged_minor: MinorUnitsString
  net_proceeds_minor: MinorUnitsString
  net_proceeds_nok_minor: MinorUnitsString
  realized_result_nok_minor: MinorUnitsString | null
  proceeds_from_uncosted_nok_minor: MinorUnitsString
  fx_rate_to_nok: string
  fx_rate_date: string
  fx_source: string
  notes: string | null
  /** Kept for fidelity (idempotent retry semantics belong to restore, M19). Omitted from CSV. */
  idempotency_key: string
  voided_at: string | null
  created_at: string
  updated_at: string
}

export interface BackupSaleLineRow {
  id: string
  user_id: string
  sale_id: string
  lot_id: string
  quantity: number
  unit_gross_minor: MinorUnitsString
  line_gross_minor: MinorUnitsString
  allocated_fees_minor: MinorUnitsString
  allocated_shipping_minor: MinorUnitsString
  allocated_shipping_charged_minor: MinorUnitsString
  net_proceeds_minor: MinorUnitsString
  net_proceeds_nok_minor: MinorUnitsString
  /** Frozen at sale time (D-060); null when the lot had no known basis — never zero. */
  cost_basis_at_sale_nok_minor: MinorUnitsString | null
  realized_result_nok_minor: MinorUnitsString | null
  created_at: string
}

export interface BackupLotDisposalRow {
  id: string
  user_id: string
  lot_id: string
  sale_line_id: string | null
  /** v2 (M16): the opening this disposal consumes for — NOT NULL exactly when kind='opened'. */
  opening_id: string | null
  kind: string
  disposed_on: string
  quantity: number
  cost_basis_at_disposal_nok_minor: MinorUnitsString | null
  voided_at: string | null
  created_at: string
}

/**
 * v2 (M16): one canonical opening row. Money as exact minor-unit strings; NULL cost means the
 * unknown-cost source (never zero). `idempotency_key` is the server-enforced submission identity
 * (P53 §5) — exported so a future restore can preserve replay semantics verbatim. Provenance
 * fields (`provisional_purchase_id`, `reconciled_at`, `reconciled_to_purchase_id`) carry the
 * reconciliation trail without any audit table.
 */
export interface BackupOpeningRow {
  id: string
  user_id: string
  opened_on: string
  source_lot_id: string
  sealed_product_id: string
  quantity_opened: number
  cost_source: string
  /** NULL iff cost_source = 'unknown' — never zero-filled (M1 at opening scope). */
  cost_nok_minor: MinorUnitsString | null
  tracking_completeness: string
  bulk_remainder_estimate_nok_minor: MinorUnitsString | null
  bulk_remainder_count: number | null
  provisional_purchase_id: string | null
  reconciled_at: string | null
  reconciled_to_purchase_id: string | null
  idempotency_key: string
  notes: string | null
  created_at: string
  voided_at: string | null
}

// ---------------------------------------------------------------------------
// Identity manifest — stable references into the SHARED catalog
// ---------------------------------------------------------------------------

/**
 * Compact identity reference for one shared card_variant referenced by exported rows. Enough
 * for external tools to identify the product without database access, and enough for a future
 * restore to re-resolve the link (internal UUID first, provider ids second). Never a copy of
 * the whole shared catalog — only variants actually referenced.
 */
export interface ManifestCardVariantEntry {
  id: string
  finish: string
  stamp: string
  subtype: string
  size: string | null
  tcgdex_variant_id: string | null
  cardmarket_product_id: string | null
  tcgplayer_product_id: string | null
  card_name: string | null
  card_local_id: string | null
  card_language: string | null
  tcgdex_card_id: string | null
  set_slug: string | null
  set_name: string | null
}

/** Same idea for curated sealed products referenced by exported rows. */
export interface ManifestCuratedSealedProductEntry {
  id: string
  name: string
  product_type: string
  language: string
  pack_count: number | null
  cardmarket_product_id: string | null
  tcgplayer_product_id: string | null
  set_slug: string | null
  set_name: string | null
}

/**
 * Stable set identity for the bare internal `set_id` UUIDs that user-created sealed products
 * carry. Card-variant and curated-sealed entries already carry their set slug+name inline; a
 * user-created product row does not, so without this map its set reference is an unresolvable
 * internal id for any external consumer or cross-project restore. Only sets actually
 * referenced by exported rows appear — never a catalog dump.
 */
export interface ManifestCardSetEntry {
  /** The internal card_sets UUID the exported rows' set_id values name directly. */
  id: string
  /** Globally unique stable slug — the portable identity. */
  slug: string
  name: string
  language: string
  tcgdex_set_id: string | null
}

export interface BackupIdentityManifest {
  card_variants: ManifestCardVariantEntry[]
  curated_sealed_products: ManifestCuratedSealedProductEntry[]
  card_sets: ManifestCardSetEntry[]
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface BackupData {
  // Every section is named EXACTLY after its canonical table (D-076) and is an array —
  // including profiles, which holds zero or one row (the owner's own).
  profiles: BackupProfileRow[]
  custom_collections: BackupCustomCollectionRow[]
  custom_collection_members: BackupCustomCollectionMemberRow[]
  tags: BackupTagRow[]
  holding_tags: BackupHoldingTagRow[]
  storage_locations: BackupStorageLocationRow[]
  retailers: BackupRetailerRow[]
  holdings: BackupHoldingRow[]
  acquisition_lots: BackupAcquisitionLotRow[]
  manual_card_definitions: BackupManualCardDefinitionRow[]
  sealed_products: BackupUserCreatedSealedProductRow[]
  manual_valuations: BackupManualValuationRow[]
  lot_cost_adjustments: BackupLotCostAdjustmentRow[]
  /** v2 (M16): canonical openings. Restores must insert these BEFORE the pull lots that cite them. */
  openings: BackupOpeningRow[]
  purchases: BackupPurchaseRow[]
  purchase_lines: BackupPurchaseLineRow[]
  sales: BackupSaleRow[]
  sale_lines: BackupSaleLineRow[]
  lot_disposals: BackupLotDisposalRow[]
}

/** Top-level keys of `data`, in canonical (serialized) order. Single source of truth. */
export const BACKUP_DATA_KEYS = [
  'profiles',
  'custom_collections',
  'custom_collection_members',
  'tags',
  'holding_tags',
  'storage_locations',
  'retailers',
  'holdings',
  'acquisition_lots',
  'manual_card_definitions',
  'sealed_products',
  'manual_valuations',
  'lot_cost_adjustments',
  'openings',
  'purchases',
  'purchase_lines',
  'sales',
  'sale_lines',
  'lot_disposals',
] as const

export type BackupDataKey = (typeof BACKUP_DATA_KEYS)[number]

/** Per-section row counts, including manifest sections prefixed `identity_manifest.`. */
export type BackupCounts = Readonly<Record<string, number>>

/** Counts-key prefix for identity-manifest sections (`identity_manifest.card_variants`, …). */
export const MANIFEST_COUNT_KEY_PREFIX = 'identity_manifest.'

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT_ID
  schema_version: number
  /** RFC 3339 UTC instant ("...Z") marking when the export was produced. */
  exported_at: string
  app: { version: string }
  counts: BackupCounts
  data: BackupData
  identity_manifest: BackupIdentityManifest
}

export function emptyBackupData(): BackupData {
  return {
    profiles: [],
    custom_collections: [],
    custom_collection_members: [],
    tags: [],
    holding_tags: [],
    storage_locations: [],
    retailers: [],
    holdings: [],
    acquisition_lots: [],
    manual_card_definitions: [],
    sealed_products: [],
    manual_valuations: [],
    lot_cost_adjustments: [],
    openings: [],
    purchases: [],
    purchase_lines: [],
    sales: [],
    sale_lines: [],
    lot_disposals: [],
  }
}
