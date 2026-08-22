import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Database, Json } from './database.types'
import type { CardCondition, Grader, GradingState, SealedIntent } from './collection'

/**
 * The M8 purchase ledger (DATA_MODEL.md §5.3, FINANCIAL_MODEL.md §1-4/§7). Components call these,
 * never `supabase.from('purchases')`/`.rpc('create_purchase')` directly. Every money column is
 * cast to text in the select list and parsed with `parseMinorUnits` — see src/data/money.ts.
 */

export type LineType = Database['public']['Enums']['line_type']
export type SpendClass = Database['public']['Enums']['spend_class']
export type FxSource = Database['public']['Enums']['fx_source']

export interface PurchaseLineInput {
  /** Present only when editing an existing line (updatePurchase); absent for a new line. */
  lineId?: string
  lineType: LineType
  description?: string
  cardVariantId?: string
  manualCardId?: string
  sealedProductId?: string
  /** Organisational only (prompt §20) — defaults to 'undecided' server-side when omitted. */
  sealedIntent?: SealedIntent
  condition?: CardCondition
  gradingState?: GradingState
  grader?: Grader
  grade?: number
  certNumber?: string
  quantity: number
  unitPriceMinor: bigint
  spendClass?: SpendClass
  storageLocationId?: string
  isFavorite?: boolean
  lotNotes?: string
  manualValueMinor?: bigint
}

function serializeLine(line: PurchaseLineInput): Json {
  return {
    line_id: line.lineId,
    line_type: line.lineType,
    description: line.description,
    card_variant_id: line.cardVariantId,
    manual_card_id: line.manualCardId,
    sealed_product_id: line.sealedProductId,
    sealed_intent: line.sealedIntent,
    condition: line.condition,
    grading_state: line.gradingState,
    grader: line.grader,
    grade: line.grade,
    cert_number: line.certNumber,
    quantity: line.quantity,
    unit_price_minor: Number(line.unitPriceMinor),
    spend_class: line.spendClass,
    storage_location_id: line.storageLocationId,
    is_favorite: line.isFavorite,
    lot_notes: line.lotNotes,
    manual_value_minor:
      line.manualValueMinor === undefined ? undefined : Number(line.manualValueMinor),
  }
}

export interface PurchaseWriteInput {
  purchasedOn: string
  currency: string
  lines: PurchaseLineInput[]
  retailerId?: string
  shippingMinor?: bigint
  customsMinor?: bigint
  discountMinor?: bigint
  /** Decimal string, e.g. "11.54000000" — numeric(18,8), never a float. Omit for NOK. */
  fxRateToNok?: string
  fxRateDate?: string
  fxSource?: FxSource
  notes?: string
}

export interface Purchase {
  id: string
  purchasedOn: string
  retailerId: string | null
  currency: string
  subtotalMinor: bigint
  shippingMinor: bigint
  customsMinor: bigint
  discountMinor: bigint
  totalMinor: bigint
  fxRateToNok: string
  fxRateDate: string
  fxSource: FxSource
  totalNokMinor: bigint
  notes: string | null
  voidedAt: string | null
}

interface PurchaseRow {
  id: string
  purchased_on: string
  retailer_id: string | null
  currency: string
  subtotal_minor: string
  shipping_minor: string
  customs_minor: string
  discount_minor: string
  total_minor: string
  fx_rate_to_nok: number
  fx_rate_date: string
  fx_source: FxSource
  total_nok_minor: string
  notes: string | null
  voided_at: string | null
}

function mapPurchase(row: PurchaseRow): Purchase {
  return {
    id: row.id,
    purchasedOn: row.purchased_on,
    retailerId: row.retailer_id,
    currency: row.currency,
    subtotalMinor: parseMinorUnits(row.subtotal_minor),
    shippingMinor: parseMinorUnits(row.shipping_minor),
    customsMinor: parseMinorUnits(row.customs_minor),
    discountMinor: parseMinorUnits(row.discount_minor),
    totalMinor: parseMinorUnits(row.total_minor),
    fxRateToNok: String(row.fx_rate_to_nok),
    fxRateDate: row.fx_rate_date,
    fxSource: row.fx_source,
    totalNokMinor: parseMinorUnits(row.total_nok_minor),
    notes: row.notes,
    voidedAt: row.voided_at,
  }
}

const PURCHASE_COLUMNS =
  'id, purchased_on, retailer_id, currency, subtotal_minor::text, shipping_minor::text, ' +
  'customs_minor::text, discount_minor::text, total_minor::text, fx_rate_to_nok, fx_rate_date, ' +
  'fx_source, total_nok_minor::text, notes, voided_at'

export async function createPurchase(input: PurchaseWriteInput): Promise<Purchase> {
  const { data, error } = await supabase
    .rpc('create_purchase', {
      p_purchased_on: input.purchasedOn,
      p_currency: input.currency,
      p_lines: input.lines.map(serializeLine),
      p_retailer_id: input.retailerId,
      p_shipping_minor: input.shippingMinor === undefined ? undefined : Number(input.shippingMinor),
      p_customs_minor: input.customsMinor === undefined ? undefined : Number(input.customsMinor),
      p_discount_minor: input.discountMinor === undefined ? undefined : Number(input.discountMinor),
      p_fx_rate_to_nok: input.fxRateToNok,
      p_fx_rate_date: input.fxRateDate,
      p_fx_source: input.fxSource,
      p_notes: input.notes,
    })
    .select(PURCHASE_COLUMNS)
    .single()
    .overrideTypes<PurchaseRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapPurchase(data)
}

export async function updatePurchase(
  purchaseId: string,
  input: PurchaseWriteInput,
): Promise<Purchase> {
  const { data, error } = await supabase
    .rpc('update_purchase', {
      p_purchase_id: purchaseId,
      p_purchased_on: input.purchasedOn,
      p_currency: input.currency,
      p_lines: input.lines.map(serializeLine),
      p_retailer_id: input.retailerId,
      p_shipping_minor: input.shippingMinor === undefined ? undefined : Number(input.shippingMinor),
      p_customs_minor: input.customsMinor === undefined ? undefined : Number(input.customsMinor),
      p_discount_minor: input.discountMinor === undefined ? undefined : Number(input.discountMinor),
      p_fx_rate_to_nok: input.fxRateToNok,
      p_fx_rate_date: input.fxRateDate,
      p_fx_source: input.fxSource,
      p_notes: input.notes,
    })
    .select(PURCHASE_COLUMNS)
    .single()
    .overrideTypes<PurchaseRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapPurchase(data)
}

export async function voidPurchase(purchaseId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('void_purchase', {
    p_purchase_id: purchaseId,
    p_reason: reason,
  })
  if (error) throw new Error(error.message)
}

export interface PurchaseLine {
  id: string
  lineType: LineType
  spendClass: SpendClass
  description: string | null
  cardVariantId: string | null
  sealedProductId: string | null
  condition: CardCondition | null
  quantity: number
  unitPriceMinor: bigint
  lineTotalMinor: bigint
  allocatedShippingMinor: bigint
  allocatedCustomsMinor: bigint
  allocatedDiscountMinor: bigint
  attributableCostMinor: bigint
  attributableCostNokMinor: bigint
  cardName: string | null
  cardLocalId: string | null
  sealedProductName: string | null
}

interface PurchaseLineRow {
  id: string
  line_type: LineType
  spend_class: SpendClass
  description: string | null
  card_variant_id: string | null
  sealed_product_id: string | null
  condition: CardCondition | null
  quantity: number
  unit_price_minor: string
  line_total_minor: string
  allocated_shipping_minor: string
  allocated_customs_minor: string
  allocated_discount_minor: string
  attributable_cost_minor: string
  attributable_cost_nok_minor: string
  card_variants: { cards: { name: string; local_id: string } | null } | null
  sealed_products: { name: string } | null
}

function mapPurchaseLine(row: PurchaseLineRow): PurchaseLine {
  return {
    id: row.id,
    lineType: row.line_type,
    spendClass: row.spend_class,
    description: row.description,
    cardVariantId: row.card_variant_id,
    sealedProductId: row.sealed_product_id,
    condition: row.condition,
    quantity: row.quantity,
    unitPriceMinor: parseMinorUnits(row.unit_price_minor),
    lineTotalMinor: parseMinorUnits(row.line_total_minor),
    allocatedShippingMinor: parseMinorUnits(row.allocated_shipping_minor),
    allocatedCustomsMinor: parseMinorUnits(row.allocated_customs_minor),
    allocatedDiscountMinor: parseMinorUnits(row.allocated_discount_minor),
    attributableCostMinor: parseMinorUnits(row.attributable_cost_minor),
    attributableCostNokMinor: parseMinorUnits(row.attributable_cost_nok_minor),
    cardName: row.card_variants?.cards?.name ?? null,
    cardLocalId: row.card_variants?.cards?.local_id ?? null,
    sealedProductName: row.sealed_products?.name ?? null,
  }
}

const PURCHASE_LINE_COLUMNS =
  'id, line_type, spend_class, description, card_variant_id, sealed_product_id, condition, ' +
  'quantity, unit_price_minor::text, line_total_minor::text, allocated_shipping_minor::text, ' +
  'allocated_customs_minor::text, allocated_discount_minor::text, attributable_cost_minor::text, ' +
  'attributable_cost_nok_minor::text, card_variants(cards(name, local_id)), sealed_products(name)'

export interface PurchaseListItem {
  purchase: Purchase
  retailerName: string | null
  lineCount: number
  collectibleNokMinor: bigint
  hobbyNokMinor: bigint
}

interface PurchaseListRow extends PurchaseRow {
  retailers: { name: string } | null
  purchase_lines: { spend_class: SpendClass; attributable_cost_nok_minor: string }[]
}

/** Newest first. `includeVoided` defaults to false — the ledger leads with live spend
 *  (M8 prompt §71); voided entries stay reachable, never hidden from a direct fetch. */
export async function listPurchases(
  options: { includeVoided?: boolean } = {},
): Promise<PurchaseListItem[]> {
  let query = supabase
    .from('purchases')
    .select(
      `${PURCHASE_COLUMNS}, retailers(name), purchase_lines(spend_class, attributable_cost_nok_minor::text)`,
    )
    .order('purchased_on', { ascending: false })
    .order('id', { ascending: false })

  if (!options.includeVoided) {
    query = query.is('voided_at', null)
  }

  const { data, error } = await query.overrideTypes<PurchaseListRow[], { merge: false }>()
  if (error) throw new Error(error.message)

  return data.map((row) => {
    let collectible = 0n
    let hobby = 0n
    for (const line of row.purchase_lines) {
      const amount = parseMinorUnits(line.attributable_cost_nok_minor)
      if (line.spend_class === 'collectible') collectible += amount
      else hobby += amount
    }
    return {
      purchase: mapPurchase(row),
      retailerName: row.retailers?.name ?? null,
      lineCount: row.purchase_lines.length,
      collectibleNokMinor: collectible,
      hobbyNokMinor: hobby,
    }
  })
}

export interface PurchaseDetail {
  purchase: Purchase
  retailerName: string | null
  lines: PurchaseLine[]
}

export async function getPurchase(purchaseId: string): Promise<PurchaseDetail | null> {
  const { data, error } = await supabase
    .from('purchases')
    .select(`${PURCHASE_COLUMNS}, retailers(name), purchase_lines(${PURCHASE_LINE_COLUMNS})`)
    .eq('id', purchaseId)
    .maybeSingle()
    .overrideTypes<
      | (PurchaseRow & { retailers: { name: string } | null; purchase_lines: PurchaseLineRow[] })
      | null,
      { merge: false }
    >()
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    purchase: mapPurchase(data),
    retailerName: data.retailers?.name ?? null,
    lines: data.purchase_lines.map(mapPurchaseLine),
  }
}

export interface SpendingSummary {
  gpoNokMinor: bigint
  csNokMinor: bigint
  hsNokMinor: bigint
  purchaseCount: number
}

export async function getSpendingSummary(): Promise<SpendingSummary> {
  const { data, error } = await supabase.rpc('purchase_spending_summary').single()
  if (error) throw new Error(error.message)
  return {
    gpoNokMinor: parseMinorUnits(data.gpo_nok_minor),
    csNokMinor: parseMinorUnits(data.cs_nok_minor),
    hsNokMinor: parseMinorUnits(data.hs_nok_minor),
    purchaseCount: data.purchase_count,
  }
}
