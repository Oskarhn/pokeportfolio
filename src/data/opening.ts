import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Json } from './database.types'

/**
 * The M16 opening surface (FINANCIAL_MODEL.md §5, DATA_MODEL.md §5.8). Components call these,
 * never `supabase.rpc('create_opening')` directly — same rule as every other src/data module.
 * Every money column arrives as text (PostgREST bigint boundary) and is parsed with
 * `parseMinorUnits` into an exact bigint; no JavaScript float ever touches a minor unit.
 */

export type OpeningTracking = 'all_cards' | 'selected_pulls' | 'unknown'
export type OpeningCostSource = 'from_lot' | 'unknown'

/** One pulled-card entry in the opening session. Exactly one identity source per pull. */
export interface OpeningPullInput {
  cardVariantId?: string
  manualCardId?: string
  quantity: number
  /** Required: pulls are always raw cards (grading happens later via the transfer lifecycle). */
  condition: string
  storageLocationId?: string
  notes?: string
}

export interface CreateOpeningInput {
  sourceLotId: string
  quantity: number
  openedOn: string
  trackingCompleteness?: OpeningTracking
  pulls?: OpeningPullInput[]
  bulkRemainderEstimateNokMinor?: bigint
  bulkRemainderCount?: number
  notes?: string
  /**
   * Client-generated submission identity (P53 §5). The SAME key with the SAME material request
   * returns the already-committed opening instead of creating a second one; the same key with a
   * materially different request is rejected server-side (`idempotency-key-reuse`). Required in
   * practice — the UI always supplies one; the RPC generates internally when omitted.
   */
  idempotencyKey?: string
}

/** Buy-and-open (P53 §11): the owner states the RECEIPT TOTAL they paid — never a per-unit price.
 *  The backend splits it exactly (integer floor unit + lot residual, D-090). */
export interface CreateProvisionalOpeningInput extends Omit<
  CreateOpeningInput,
  'sourceLotId' | 'openedOn'
> {
  sealedProductId: string
  totalPaidNokMinor: bigint
  purchasedOn: string
  /** Optional: the backend defaults the opening date to the purchase date when omitted. */
  openedOn?: string
}

function toWirePulls(pulls: OpeningPullInput[] | undefined): Json[] | undefined {
  return pulls?.map((pull): Json => ({
    card_variant_id: pull.cardVariantId ?? null,
    manual_card_id: pull.manualCardId ?? null,
    quantity: pull.quantity,
    condition: pull.condition,
    storage_location_id: pull.storageLocationId ?? null,
    notes: pull.notes ?? null,
  }))
}

export interface Opening {
  id: string
  openedOn: string
  sealedProductId: string
  sourceLotId: string
  quantityOpened: number
  costSource: OpeningCostSource
  costNokMinor: bigint | null
  trackingCompleteness: OpeningTracking
  bulkRemainderEstimateNokMinor: bigint | null
  bulkRemainderCount: number | null
  provisionalPurchaseId: string | null
  reconciledAt: string | null
  reconciledToPurchaseId: string | null
  notes: string | null
  voidedAt: string | null
  createdAt: string
}

interface OpeningRow {
  id: string
  opened_on: string
  sealed_product_id: string
  source_lot_id: string
  quantity_opened: number
  cost_source: OpeningCostSource
  cost_nok_minor: string | null
  tracking_completeness: OpeningTracking
  bulk_remainder_estimate_nok_minor: string | null
  bulk_remainder_count: number | null
  provisional_purchase_id: string | null
  reconciled_at: string | null
  reconciled_to_purchase_id: string | null
  notes: string | null
  voided_at: string | null
  created_at: string
}

function mapOpening(row: OpeningRow): Opening {
  return {
    id: row.id,
    openedOn: row.opened_on,
    sealedProductId: row.sealed_product_id,
    sourceLotId: row.source_lot_id,
    quantityOpened: row.quantity_opened,
    costSource: row.cost_source,
    costNokMinor: row.cost_nok_minor === null ? null : parseMinorUnits(row.cost_nok_minor),
    trackingCompleteness: row.tracking_completeness,
    bulkRemainderEstimateNokMinor:
      row.bulk_remainder_estimate_nok_minor === null
        ? null
        : parseMinorUnits(row.bulk_remainder_estimate_nok_minor),
    bulkRemainderCount: row.bulk_remainder_count,
    provisionalPurchaseId: row.provisional_purchase_id,
    reconciledAt: row.reconciled_at,
    reconciledToPurchaseId: row.reconciled_to_purchase_id,
    notes: row.notes,
    voidedAt: row.voided_at,
    createdAt: row.created_at,
  }
}

const OPENING_COLUMNS =
  'id, opened_on, sealed_product_id, source_lot_id, quantity_opened, cost_source, ' +
  'cost_nok_minor::text, tracking_completeness, bulk_remainder_estimate_nok_minor::text, ' +
  'bulk_remainder_count, provisional_purchase_id, reconciled_at, reconciled_to_purchase_id, ' +
  'notes, voided_at, created_at'

/** One atomic opening over an already-owned sealed lot. Creates no spend. */
export async function createOpening(input: CreateOpeningInput): Promise<Opening> {
  const { data, error } = await supabase
    .rpc('create_opening', {
      p_source_lot_id: input.sourceLotId,
      p_quantity: input.quantity,
      p_opened_on: input.openedOn,
      p_tracking_completeness: input.trackingCompleteness ?? 'all_cards',
      p_pulls: toWirePulls(input.pulls),
      p_bulk_remainder_estimate_nok_minor:
        input.bulkRemainderEstimateNokMinor === undefined
          ? undefined
          : Number(input.bulkRemainderEstimateNokMinor),
      p_bulk_remainder_count: input.bulkRemainderCount,
      p_notes: input.notes,
      p_idempotency_key: input.idempotencyKey,
    })
    .select(OPENING_COLUMNS)
    .single()
    .overrideTypes<OpeningRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapOpening(data)
}

/**
 * FINANCIAL_MODEL §5.5 provisional path (buy-and-open) in ONE server transaction: creates the
 * real purchase(origin='provisional_opening') plus its known-cost sealed lot from the ENTERED
 * TOTAL PAID (exact largest-remainder split, D-090), then consumes it through create_opening.
 * The idempotency key is enforced BEFORE the purchase row is written, so a retried submission
 * can never double-spend (P53 §5). Money counted exactly once.
 */
export async function createProvisionalOpening(
  input: CreateProvisionalOpeningInput,
): Promise<Opening> {
  const { data, error } = await supabase
    .rpc('create_opening_from_provisional', {
      p_sealed_product_id: input.sealedProductId,
      p_quantity: input.quantity,
      p_total_paid_minor: Number(input.totalPaidNokMinor),
      p_purchased_on: input.purchasedOn,
      p_opened_on: input.openedOn,
      p_tracking_completeness: input.trackingCompleteness ?? 'all_cards',
      p_pulls: toWirePulls(input.pulls),
      p_bulk_remainder_estimate_nok_minor:
        input.bulkRemainderEstimateNokMinor === undefined
          ? undefined
          : Number(input.bulkRemainderEstimateNokMinor),
      p_bulk_remainder_count: input.bulkRemainderCount,
      p_notes: input.notes,
      p_idempotency_key: input.idempotencyKey,
    })
    .select(OPENING_COLUMNS)
    .single()
    .overrideTypes<OpeningRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapOpening(data)
}

export async function voidOpening(openingId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('void_opening', {
    p_opening_id: openingId,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

/** Links a provisionally-costed opening to the real receipt's lot. F12 holds throughout. */
export async function reconcileOpeningCost(
  openingId: string,
  realSourceLotId: string,
): Promise<Opening> {
  const { data, error } = await supabase
    .rpc('reconcile_opening_cost', {
      p_opening_id: openingId,
      p_real_source_lot_id: realSourceLotId,
    })
    .select(OPENING_COLUMNS)
    .single()
    .overrideTypes<OpeningRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapOpening(data)
}

/** The bounded Opening Detail read incl. FINANCIAL_MODEL §5.3 result components. */
export interface OpeningDetail extends Opening {
  sealedProductName: string
  retainedTrackedValueNokMinor: bigint
  pricedPullLotCount: number
  unpricedPullLotCount: number
  soldPullLotCount: number
  netProceedsFromSoldPullsNokMinor: bigint
  /** Null when the opening cost is unknown — renders "—", never a 0-based result. */
  openingReturnNokMinor: bigint | null
}

interface OpeningDetailRow extends OpeningRow {
  sealed_product_name: string
  retained_tracked_value_nok_minor: string
  priced_pull_lot_count: number
  unpriced_pull_lot_count: number
  sold_pull_lot_count: number
  net_proceeds_from_sold_pulls_nok_minor: string
  opening_return_nok_minor: string | null
}

export async function getOpening(openingId: string): Promise<OpeningDetail | null> {
  const { data, error } = await supabase
    .rpc('get_opening', { p_opening_id: openingId })
    .overrideTypes<OpeningDetailRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  const row = data.at(0)
  if (!row) return null
  return {
    ...mapOpening(row),
    sealedProductName: row.sealed_product_name,
    retainedTrackedValueNokMinor: parseMinorUnits(row.retained_tracked_value_nok_minor),
    pricedPullLotCount: row.priced_pull_lot_count,
    unpricedPullLotCount: row.unpriced_pull_lot_count,
    soldPullLotCount: row.sold_pull_lot_count,
    netProceedsFromSoldPullsNokMinor: parseMinorUnits(row.net_proceeds_from_sold_pulls_nok_minor),
    openingReturnNokMinor:
      row.opening_return_nok_minor === null ? null : parseMinorUnits(row.opening_return_nok_minor),
  }
}

// ---------------------------------------------------------------------------
// Source picker + per-pull detail lines (P53 §7/§8/§16)
// ---------------------------------------------------------------------------

/**
 * One openable sealed source lot, with its ALREADY-DERIVED preview components from
 * `list_opening_sources` — the client never re-implements the consumption arithmetic. The two
 * cost components are null together exactly when the lot's basis is unknown (never zero).
 */
export interface OpeningSourceLot {
  lotId: string
  holdingId: string
  productId: string
  productName: string
  productType: string | null
  imageUrl: string | null
  acquiredOn: string
  quantityAvailable: number
  costKnown: boolean
  /** unit_cost_basis_nok + floor(Σ adjustments / quantity) — null when unknown. */
  effectiveUnitBasisNokMinor: bigint | null
  /** lot residual + adjustment remainder — added once when the opening exhausts the lot. */
  exhaustionResidualNokMinor: bigint | null
}

interface OpeningSourceRow {
  lot_id: string
  holding_id: string
  sealed_product_id: string
  product_name: string
  product_type: string | null
  image_url: string | null
  acquired_on: string
  quantity_available: number
  cost_known: boolean
  effective_unit_basis_nok_minor: string | null
  exhaustion_residual_nok_minor: string | null
}

/** The bounded source-picker read (P53 §8): owner's live sealed lots with remaining units.
 *  `holdingId` scopes to one holding for the Holding-Detail entry point. */
export async function listOpeningSources(filter?: {
  holdingId?: string
}): Promise<OpeningSourceLot[]> {
  const { data, error } = await supabase
    .rpc('list_opening_sources', { p_holding_id: filter?.holdingId ?? null })
    .overrideTypes<OpeningSourceRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    lotId: row.lot_id,
    holdingId: row.holding_id,
    productId: row.sealed_product_id,
    productName: row.product_name,
    productType: row.product_type,
    imageUrl: row.image_url,
    acquiredOn: row.acquired_on,
    quantityAvailable: row.quantity_available,
    costKnown: row.cost_known,
    effectiveUnitBasisNokMinor:
      row.effective_unit_basis_nok_minor === null
        ? null
        : parseMinorUnits(row.effective_unit_basis_nok_minor),
    exhaustionResidualNokMinor:
      row.exhaustion_residual_nok_minor === null
        ? null
        : parseMinorUnits(row.exhaustion_residual_nok_minor),
  }))
}

/** One pulled-card line of an opening, for the Detail page's tracked-pulls list. */
export interface OpeningPullLineRow {
  lotId: string
  displayName: string
  subtitle: string | null
  imageUrl: string | null
  condition: string | null
  quantity: number
  quantityRemaining: number
}

interface OpeningPullWireRow {
  id: string
  quantity: number
  quantity_remaining: number
  acquired_on: string
  holdings: {
    condition: string | null
    card_variants: {
      cards: { name: string; local_id: string | null; card_sets: { name: string } | null } | null
    } | null
    manual_card_definitions: { name: string; set_name: string | null } | null
    sealed_products: { name: string } | null
  } | null
}

/**
 * The tracked pulls of one opening (live lots only), identity-resolved through the same joins
 * the rest of the app uses. No cost/value figures exist here by design: pulls carry no
 * individual basis, and aggregate value/proceeds come from `get_opening`.
 */
export async function listOpeningPulls(openingId: string): Promise<OpeningPullLineRow[]> {
  const { data, error } = await supabase
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, acquired_on, ' +
        'holdings!inner(condition, ' +
        'card_variants(cards(name, local_id, card_sets(name))), ' +
        'manual_card_definitions(name, set_name), ' +
        'sealed_products(name))',
    )
    .eq('opening_id', openingId)
    .is('voided_at', null)
    .order('acquired_on', { ascending: true })
    .order('id', { ascending: true })
    .overrideTypes<OpeningPullWireRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => {
    const holding = row.holdings
    const variantCard = holding?.card_variants?.cards ?? null
    const manual = holding?.manual_card_definitions ?? null
    const displayName =
      variantCard?.name ?? manual?.name ?? holding?.sealed_products?.name ?? 'Pulled card'
    const setName = variantCard?.card_sets?.name ?? manual?.set_name ?? null
    const subtitle = [setName, variantCard?.local_id ?? null].filter(Boolean).join(' · ') || null
    return {
      lotId: row.id,
      displayName,
      subtitle,
      imageUrl: null,
      condition: holding?.condition ?? null,
      quantity: row.quantity,
      quantityRemaining: row.quantity_remaining,
    }
  })
}
