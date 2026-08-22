import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Database, Json } from './database.types'

/**
 * The M10 sale ledger (DATA_MODEL.md §5.7/§5.11, FINANCIAL_MODEL.md §2.2/§4.5). Components call
 * these, never `supabase.from('sales')`/`.rpc('create_sale')` directly — same rule as
 * src/data/purchases.ts. Every money column is cast to text in the select list and parsed with
 * `parseMinorUnits`.
 */

export type FxSource = Database['public']['Enums']['fx_source']

export interface SaleLineInput {
  lotId: string
  quantity: number
  unitGrossMinor: bigint
}

export interface SaleLineUpdateInput {
  lineId: string
  unitGrossMinor: bigint
}

export interface SaleWriteInput {
  soldOn: string
  currency: string
  marketplace?: string
  feesMinor?: bigint
  shippingCostMinor?: bigint
  shippingChargedMinor?: bigint
  /** Decimal string, e.g. "11.54000000" — numeric(18,8), never a float. Omit for NOK. */
  fxRateToNok?: string
  fxRateDate?: string
  fxSource?: FxSource
  notes?: string
}

export interface Sale {
  id: string
  soldOn: string
  marketplace: string | null
  currency: string
  grossMinor: bigint
  feesMinor: bigint
  shippingCostMinor: bigint
  shippingChargedMinor: bigint
  netProceedsMinor: bigint
  fxRateToNok: string
  fxRateDate: string
  fxSource: FxSource
  netProceedsNokMinor: bigint
  realizedResultNokMinor: bigint | null
  proceedsFromUncostedNokMinor: bigint
  notes: string | null
  voidedAt: string | null
}

interface SaleRow {
  id: string
  sold_on: string
  marketplace: string | null
  currency: string
  gross_minor: string
  fees_minor: string
  shipping_cost_minor: string
  shipping_charged_minor: string
  net_proceeds_minor: string
  fx_rate_to_nok: number
  fx_rate_date: string
  fx_source: FxSource
  net_proceeds_nok_minor: string
  realized_result_nok_minor: string | null
  proceeds_from_uncosted_nok_minor: string
  notes: string | null
  voided_at: string | null
}

function mapSale(row: SaleRow): Sale {
  return {
    id: row.id,
    soldOn: row.sold_on,
    marketplace: row.marketplace,
    currency: row.currency,
    grossMinor: parseMinorUnits(row.gross_minor),
    feesMinor: parseMinorUnits(row.fees_minor),
    shippingCostMinor: parseMinorUnits(row.shipping_cost_minor),
    shippingChargedMinor: parseMinorUnits(row.shipping_charged_minor),
    netProceedsMinor: parseMinorUnits(row.net_proceeds_minor),
    fxRateToNok: String(row.fx_rate_to_nok),
    fxRateDate: row.fx_rate_date,
    fxSource: row.fx_source,
    netProceedsNokMinor: parseMinorUnits(row.net_proceeds_nok_minor),
    realizedResultNokMinor:
      row.realized_result_nok_minor === null
        ? null
        : parseMinorUnits(row.realized_result_nok_minor),
    proceedsFromUncostedNokMinor: parseMinorUnits(row.proceeds_from_uncosted_nok_minor),
    notes: row.notes,
    voidedAt: row.voided_at,
  }
}

const SALE_COLUMNS =
  'id, sold_on, marketplace, currency, gross_minor::text, fees_minor::text, ' +
  'shipping_cost_minor::text, shipping_charged_minor::text, net_proceeds_minor::text, ' +
  'fx_rate_to_nok, fx_rate_date, fx_source, net_proceeds_nok_minor::text, ' +
  'realized_result_nok_minor::text, proceeds_from_uncosted_nok_minor::text, notes, voided_at'

export async function createSale(
  lines: SaleLineInput[],
  input: SaleWriteInput,
  idempotencyKey: string,
): Promise<Sale> {
  const { data, error } = await supabase
    .rpc('create_sale', {
      p_sold_on: input.soldOn,
      p_currency: input.currency,
      p_lines: lines.map((line): Json => ({
        lot_id: line.lotId,
        quantity: line.quantity,
        unit_gross_minor: Number(line.unitGrossMinor),
      })),
      p_idempotency_key: idempotencyKey,
      p_marketplace: input.marketplace,
      p_fees_minor: input.feesMinor === undefined ? undefined : Number(input.feesMinor),
      p_shipping_cost_minor:
        input.shippingCostMinor === undefined ? undefined : Number(input.shippingCostMinor),
      p_shipping_charged_minor:
        input.shippingChargedMinor === undefined ? undefined : Number(input.shippingChargedMinor),
      p_fx_rate_to_nok: input.fxRateToNok,
      p_fx_rate_date: input.fxRateDate,
      p_fx_source: input.fxSource,
      p_notes: input.notes,
    })
    .select(SALE_COLUMNS)
    .single()
    .overrideTypes<SaleRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapSale(data)
}

export async function updateSale(
  saleId: string,
  lines: SaleLineUpdateInput[],
  input: SaleWriteInput,
): Promise<Sale> {
  const { data, error } = await supabase
    .rpc('update_sale', {
      p_sale_id: saleId,
      p_sold_on: input.soldOn,
      p_currency: input.currency,
      p_lines: lines.map((line): Json => ({
        line_id: line.lineId,
        unit_gross_minor: Number(line.unitGrossMinor),
      })),
      p_marketplace: input.marketplace,
      p_fees_minor: input.feesMinor === undefined ? undefined : Number(input.feesMinor),
      p_shipping_cost_minor:
        input.shippingCostMinor === undefined ? undefined : Number(input.shippingCostMinor),
      p_shipping_charged_minor:
        input.shippingChargedMinor === undefined ? undefined : Number(input.shippingChargedMinor),
      p_fx_rate_to_nok: input.fxRateToNok,
      p_fx_rate_date: input.fxRateDate,
      p_fx_source: input.fxSource,
      p_notes: input.notes,
    })
    .select(SALE_COLUMNS)
    .single()
    .overrideTypes<SaleRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapSale(data)
}

export async function voidSale(saleId: string, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('void_sale', { p_sale_id: saleId, p_reason: reason })
  if (error) throw new Error(error.message)
}

export interface SaleLine {
  id: string
  lotId: string
  quantity: number
  unitGrossMinor: bigint
  lineGrossMinor: bigint
  allocatedFeesMinor: bigint
  allocatedShippingMinor: bigint
  allocatedShippingChargedMinor: bigint
  netProceedsMinor: bigint
  netProceedsNokMinor: bigint
  costBasisAtSaleNokMinor: bigint | null
  realizedResultNokMinor: bigint | null
  lotAcquiredOn: string
  lotOrigin: Database['public']['Enums']['lot_origin']
  cardName: string | null
  cardLocalId: string | null
  sealedProductName: string | null
  manualCardName: string | null
  condition: Database['public']['Enums']['card_condition'] | null
}

interface SaleLineRow {
  id: string
  lot_id: string
  quantity: number
  unit_gross_minor: string
  line_gross_minor: string
  allocated_fees_minor: string
  allocated_shipping_minor: string
  allocated_shipping_charged_minor: string
  net_proceeds_minor: string
  net_proceeds_nok_minor: string
  cost_basis_at_sale_nok_minor: string | null
  realized_result_nok_minor: string | null
  acquisition_lots: {
    acquired_on: string
    origin: Database['public']['Enums']['lot_origin']
    holdings: {
      condition: Database['public']['Enums']['card_condition'] | null
      card_variants: { cards: { name: string; local_id: string } | null } | null
      sealed_products: { name: string } | null
      manual_card_definitions: { name: string } | null
    } | null
  } | null
}

function mapSaleLine(row: SaleLineRow): SaleLine {
  const holding = row.acquisition_lots?.holdings ?? null
  return {
    id: row.id,
    lotId: row.lot_id,
    quantity: row.quantity,
    unitGrossMinor: parseMinorUnits(row.unit_gross_minor),
    lineGrossMinor: parseMinorUnits(row.line_gross_minor),
    allocatedFeesMinor: parseMinorUnits(row.allocated_fees_minor),
    allocatedShippingMinor: parseMinorUnits(row.allocated_shipping_minor),
    allocatedShippingChargedMinor: parseMinorUnits(row.allocated_shipping_charged_minor),
    netProceedsMinor: parseMinorUnits(row.net_proceeds_minor),
    netProceedsNokMinor: parseMinorUnits(row.net_proceeds_nok_minor),
    costBasisAtSaleNokMinor:
      row.cost_basis_at_sale_nok_minor === null
        ? null
        : parseMinorUnits(row.cost_basis_at_sale_nok_minor),
    realizedResultNokMinor:
      row.realized_result_nok_minor === null
        ? null
        : parseMinorUnits(row.realized_result_nok_minor),
    lotAcquiredOn: row.acquisition_lots?.acquired_on ?? '',
    lotOrigin: row.acquisition_lots?.origin ?? 'other',
    cardName: holding?.card_variants?.cards?.name ?? null,
    cardLocalId: holding?.card_variants?.cards?.local_id ?? null,
    sealedProductName: holding?.sealed_products?.name ?? null,
    manualCardName: holding?.manual_card_definitions?.name ?? null,
    condition: holding?.condition ?? null,
  }
}

const SALE_LINE_COLUMNS =
  'id, lot_id, quantity, unit_gross_minor::text, line_gross_minor::text, ' +
  'allocated_fees_minor::text, allocated_shipping_minor::text, ' +
  'allocated_shipping_charged_minor::text, net_proceeds_minor::text, ' +
  'net_proceeds_nok_minor::text, cost_basis_at_sale_nok_minor::text, ' +
  'realized_result_nok_minor::text, ' +
  'acquisition_lots(acquired_on, origin, holdings(condition, ' +
  'card_variants(cards(name, local_id)), sealed_products(name), manual_card_definitions(name)))'

export interface SaleDetail {
  sale: Sale
  lines: SaleLine[]
}

export async function getSale(saleId: string): Promise<SaleDetail | null> {
  const { data, error } = await supabase
    .from('sales')
    .select(`${SALE_COLUMNS}, sale_lines(${SALE_LINE_COLUMNS})`)
    .eq('id', saleId)
    .maybeSingle()
    .overrideTypes<(SaleRow & { sale_lines: SaleLineRow[] }) | null, { merge: false }>()
  if (error) throw new Error(error.message)
  if (!data) return null
  return { sale: mapSale(data), lines: data.sale_lines.map(mapSaleLine) }
}

export interface SaleListItem extends Sale {
  itemCount: number
  hasUnknownBasis: boolean
}

interface SaleListRow extends SaleRow {
  sale_lines: { quantity: number; cost_basis_at_sale_nok_minor: string | null }[]
}

export type SaleListSort =
  'newest' | 'oldest' | 'result_desc' | 'result_asc' | 'proceeds_desc' | 'marketplace'

const PAGE_SIZE = 30

/** Newest first by default. Bounded keyset-friendly pagination (prompt §99) — `cursor` is the
 *  last row's sold_on/id from the previous page; offset pagination is used for the result sorts
 *  (nullsFirst is set explicitly per direction so an unknown-basis sale never sorts as +/-infinity,
 *  prompt §100-101). `includeVoided` defaults to false, same convention as listPurchases. */
export async function listSales(
  options: {
    includeVoided?: boolean
    sort?: SaleListSort
    offset?: number
    limit?: number
  } = {},
): Promise<SaleListItem[]> {
  const limit = options.limit ?? PAGE_SIZE
  let query = supabase
    .from('sales')
    .select(`${SALE_COLUMNS}, sale_lines(quantity, cost_basis_at_sale_nok_minor::text)`)
    .range(options.offset ?? 0, (options.offset ?? 0) + limit - 1)

  if (!options.includeVoided) {
    query = query.is('voided_at', null)
  }

  switch (options.sort) {
    case 'oldest':
      query = query.order('sold_on', { ascending: true }).order('id', { ascending: true })
      break
    case 'result_desc':
      query = query
        .order('realized_result_nok_minor', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
      break
    case 'result_asc':
      query = query
        .order('realized_result_nok_minor', { ascending: true, nullsFirst: false })
        .order('id', { ascending: false })
      break
    case 'proceeds_desc':
      query = query
        .order('net_proceeds_nok_minor', { ascending: false })
        .order('id', { ascending: false })
      break
    case 'marketplace':
      query = query
        .order('marketplace', { ascending: true, nullsFirst: false })
        .order('id', { ascending: false })
      break
    default:
      query = query.order('sold_on', { ascending: false }).order('id', { ascending: false })
  }

  const { data, error } = await query.overrideTypes<SaleListRow[], { merge: false }>()
  if (error) throw new Error(error.message)

  return data.map((row) => ({
    ...mapSale(row),
    itemCount: row.sale_lines.reduce((sum, line) => sum + line.quantity, 0),
    hasUnknownBasis: row.sale_lines.some((line) => line.cost_basis_at_sale_nok_minor === null),
  }))
}

export interface SalesSummary {
  saleCount: number
  grossNokMinor: bigint
  feesNokMinor: bigint
  outboundShippingNokMinor: bigint
  buyerShippingNokMinor: bigint
  nspNokMinor: bigint
  rrcNokMinor: bigint
  pudNokMinor: bigint
}

export async function getSalesSummary(): Promise<SalesSummary> {
  const { data, error } = await supabase.rpc('sales_summary').single()
  if (error) throw new Error(error.message)
  return {
    saleCount: data.sale_count,
    grossNokMinor: parseMinorUnits(data.gross_nok_minor),
    feesNokMinor: parseMinorUnits(data.fees_nok_minor),
    outboundShippingNokMinor: parseMinorUnits(data.outbound_shipping_nok_minor),
    buyerShippingNokMinor: parseMinorUnits(data.buyer_shipping_nok_minor),
    nspNokMinor: parseMinorUnits(data.nsp_nok_minor),
    rrcNokMinor: parseMinorUnits(data.rrc_nok_minor),
    pudNokMinor: parseMinorUnits(data.pud_nok_minor),
  }
}
