import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'

/**
 * Typed wrappers over the four M12 dashboard RPCs
 * (supabase/migrations/20260830120030_m12_dashboard_reads.sql). Components call these, never
 * supabase.rpc() directly. Money arrives as text (PostgREST bigint boundary) and is parsed to
 * exact bigint minor units here — the display-boundary number conversion happens later, in
 * src/domain/dashboard.ts's chart adapter only.
 */

export interface DashboardSummary {
  pendingRecompute: boolean
  latestSnapshotDate: string | null
  firstTrackedDate: string | null
  /** Latest-snapshot CMV (exact NOK minor). Null when no snapshot exists yet. */
  marketValueMinor: bigint | null
  /** False when the snapshot's open lots were entirely unresolvable (prompt §33) — the UI must
   *  not present that stored zero as "worth nothing". */
  marketValueHasCoverage: boolean
  attributedValueMinor: bigint | null
  costBasisMinor: bigint | null
  unrealizedResultMinor: bigint | null
  collectibleSpendToDateMinor: bigint | null
  salesProceedsToDateMinor: bigint | null
  ttepMinor: bigint | null
  snapshotOpenLotCount: number | null
  snapshotUnvaluedLotCount: number | null

  physicalCardCount: number
  uniqueHoldingCount: number
  gradedHoldingCount: number
  sealedHoldingCount: number
  sealedUnitCount: number
  manualEntryCount: number
  pricedHoldingCount: number
  unpricedHoldingCount: number
  manualValuedHoldingCount: number
  autoPricedHoldingCount: number
  rawValueMinor: bigint
  gradedValueMinor: bigint
  sealedValueMinor: bigint
  uncostedOpenLotCount: number

  gpoMinor: bigint
  csMinor: bigint
  hsMinor: bigint
  nspMinor: bigint
  /** Server coalesces to 0 when no costed sale exists — "no costed sales yet", never a fake
   *  zero result for a real sale. */
  rrcMinor: bigint
  pudMinor: bigint
  nccoMinor: bigint
  thcoMinor: bigint
  thpMinor: bigint
}

interface SummaryRow {
  pending_recompute: boolean
  latest_snapshot_date: string | null
  first_tracked_date: string | null
  market_value_nok_minor: string | null
  market_value_has_coverage: boolean | null
  attributed_value_nok_minor: string | null
  cost_basis_nok_minor: string | null
  unrealized_result_nok_minor: string | null
  collectible_spend_to_date_nok_minor: string | null
  sales_proceeds_to_date_nok_minor: string | null
  ttep_nok_minor: string | null
  snapshot_open_lot_count: string | null
  snapshot_unvalued_lot_count: string | null
  physical_card_count: string
  unique_holding_count: string
  graded_holding_count: string
  sealed_holding_count: string
  sealed_unit_count: string
  manual_entry_count: string
  priced_holding_count: string
  unpriced_holding_count: string
  manual_valued_holding_count: string
  auto_priced_holding_count: string
  raw_value_nok_minor: string
  graded_value_nok_minor: string
  sealed_value_nok_minor: string
  uncosted_open_lot_count: string
  gpo_nok_minor: string
  cs_nok_minor: string
  hs_nok_minor: string
  nsp_nok_minor: string
  rrc_nok_minor: string
  pud_nok_minor: string
  ncco_nok_minor: string
  thco_nok_minor: string
  thp_nok_minor: string
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const { data, error } = await supabase
    .rpc('get_dashboard_summary')
    .single()
    .overrideTypes<SummaryRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return {
    pendingRecompute: data.pending_recompute,
    latestSnapshotDate: data.latest_snapshot_date,
    firstTrackedDate: data.first_tracked_date,
    marketValueMinor:
      data.market_value_nok_minor === null ? null : parseMinorUnits(data.market_value_nok_minor),
    marketValueHasCoverage: data.market_value_has_coverage ?? true,
    attributedValueMinor:
      data.attributed_value_nok_minor === null
        ? null
        : parseMinorUnits(data.attributed_value_nok_minor),
    costBasisMinor:
      data.cost_basis_nok_minor === null ? null : parseMinorUnits(data.cost_basis_nok_minor),
    unrealizedResultMinor:
      data.unrealized_result_nok_minor === null
        ? null
        : parseMinorUnits(data.unrealized_result_nok_minor),
    collectibleSpendToDateMinor:
      data.collectible_spend_to_date_nok_minor === null
        ? null
        : parseMinorUnits(data.collectible_spend_to_date_nok_minor),
    salesProceedsToDateMinor:
      data.sales_proceeds_to_date_nok_minor === null
        ? null
        : parseMinorUnits(data.sales_proceeds_to_date_nok_minor),
    ttepMinor: data.ttep_nok_minor === null ? null : parseMinorUnits(data.ttep_nok_minor),
    snapshotOpenLotCount:
      data.snapshot_open_lot_count === null ? null : Number(data.snapshot_open_lot_count),
    snapshotUnvaluedLotCount:
      data.snapshot_unvalued_lot_count === null ? null : Number(data.snapshot_unvalued_lot_count),

    physicalCardCount: Number(data.physical_card_count),
    uniqueHoldingCount: Number(data.unique_holding_count),
    gradedHoldingCount: Number(data.graded_holding_count),
    sealedHoldingCount: Number(data.sealed_holding_count),
    sealedUnitCount: Number(data.sealed_unit_count),
    manualEntryCount: Number(data.manual_entry_count),
    pricedHoldingCount: Number(data.priced_holding_count),
    unpricedHoldingCount: Number(data.unpriced_holding_count),
    manualValuedHoldingCount: Number(data.manual_valued_holding_count),
    autoPricedHoldingCount: Number(data.auto_priced_holding_count),
    rawValueMinor: parseMinorUnits(data.raw_value_nok_minor),
    gradedValueMinor: parseMinorUnits(data.graded_value_nok_minor),
    sealedValueMinor: parseMinorUnits(data.sealed_value_nok_minor),
    uncostedOpenLotCount: Number(data.uncosted_open_lot_count),

    gpoMinor: parseMinorUnits(data.gpo_nok_minor),
    csMinor: parseMinorUnits(data.cs_nok_minor),
    hsMinor: parseMinorUnits(data.hs_nok_minor),
    nspMinor: parseMinorUnits(data.nsp_nok_minor),
    rrcMinor: parseMinorUnits(data.rrc_nok_minor),
    pudMinor: parseMinorUnits(data.pud_nok_minor),
    nccoMinor: parseMinorUnits(data.ncco_nok_minor),
    thcoMinor: parseMinorUnits(data.thco_nok_minor),
    thpMinor: parseMinorUnits(data.thp_nok_minor),
  }
}

export interface PortfolioHistoryPoint {
  snapshotDate: string
  marketValueMinor: bigint | null
  hasCoverage: boolean
  openLotCount: number
  unvaluedLotCount: number
  /** Display-currency minor units when a historical rate existed for the day; null otherwise
   *  (the UI falls back to NOK rather than fabricate a conversion). */
  displayValueMinor: bigint | null
}

interface HistoryRow {
  snapshot_date: string
  market_value_nok_minor: string | null
  has_coverage: boolean
  open_lot_count: string | null
  unvalued_lot_count: string | null
  display_value_minor: string | null
}

export async function getPortfolioHistory(params: {
  displayCurrency?: 'NOK' | 'EUR' | 'USD'
  from?: string | null
  to?: string | null
}): Promise<PortfolioHistoryPoint[]> {
  const { data, error } = await supabase
    .rpc('get_portfolio_history', {
      p_display_currency: params.displayCurrency ?? 'NOK',
      p_from: params.from ?? undefined,
      p_to: params.to ?? undefined,
    })
    .overrideTypes<HistoryRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    snapshotDate: row.snapshot_date,
    marketValueMinor:
      row.market_value_nok_minor === null ? null : parseMinorUnits(row.market_value_nok_minor),
    hasCoverage: row.has_coverage,
    openLotCount: row.open_lot_count === null ? 0 : Number(row.open_lot_count),
    unvaluedLotCount: row.unvalued_lot_count === null ? 0 : Number(row.unvalued_lot_count),
    displayValueMinor:
      row.display_value_minor === null ? null : parseMinorUnits(row.display_value_minor),
  }))
}

export interface MonthlySpendMonth {
  month: string
  collectibleMinor: bigint
  hobbyMinor: bigint
  totalMinor: bigint
}

interface MonthlySpendRow {
  month: string
  collectible_nok_minor: string
  hobby_nok_minor: string
  total_nok_minor: string
}

export async function getMonthlySpend(months = 12): Promise<MonthlySpendMonth[]> {
  const { data, error } = await supabase
    .rpc('get_monthly_spend', { p_months: months })
    .overrideTypes<MonthlySpendRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    month: row.month,
    collectibleMinor: parseMinorUnits(row.collectible_nok_minor),
    hobbyMinor: parseMinorUnits(row.hobby_nok_minor),
    totalMinor: parseMinorUnits(row.total_nok_minor),
  }))
}

export type RecentActivityType = 'purchase' | 'sale' | 'valuation' | 'acquisition'

export interface RecentActivityItem {
  type: RecentActivityType
  primaryId: string
  secondaryId: string | null
  occurredOn: string | null
  amountMinor: bigint | null
}

interface ActivityRow {
  activity_type: string
  primary_id: string
  secondary_id: string | null
  occurred_on: string | null
  amount_nok_minor: string | null
}

export async function getRecentActivity(limit = 8): Promise<RecentActivityItem[]> {
  const { data, error } = await supabase
    .rpc('get_recent_activity', { p_limit: limit })
    .overrideTypes<ActivityRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    type: row.activity_type as RecentActivityType,
    primaryId: row.primary_id,
    secondaryId: row.secondary_id,
    occurredOn: row.occurred_on,
    amountMinor: row.amount_nok_minor === null ? null : parseMinorUnits(row.amount_nok_minor),
  }))
}
