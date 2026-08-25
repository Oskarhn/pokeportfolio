import { supabase } from './supabase-client'

/**
 * The Profile Danger Zone's full reset (P43, 20260901120010_p43_reset_and_history.sql). ONE
 * atomic server-side operation — never a client loop of DELETEs: the browser cannot delete from
 * the financial ledger at all, and a partial reset must be impossible (DECISIONS.md D-084).
 *
 * Preserves the account, profile/settings and reusable setup metadata (retailers, storage
 * locations, tags, custom-collection definitions, manual card definitions, the user's own
 * sealed-product definitions). Clears owned inventory, purchases/spend, sales, acquisition lots,
 * disposals, manual valuations, collection/tag memberships, snapshot cache and recompute queue.
 */

export interface ResetPortfolioResult {
  purchasesDeleted: number
  purchaseLinesDeleted: number
  salesDeleted: number
  saleLinesDeleted: number
  lotDisposalsDeleted: number
  acquisitionLotsDeleted: number
  holdingsDeleted: number
  manualValuationsDeleted: number
  snapshotsDeleted: number
}

interface ResetRow {
  purchases_deleted: number
  purchase_lines_deleted: number
  sales_deleted: number
  sale_lines_deleted: number
  lot_disposals_deleted: number
  acquisition_lots_deleted: number
  holdings_deleted: number
  manual_valuations_deleted: number
  snapshots_deleted: number
}

export async function resetMyPortfolioData(): Promise<ResetPortfolioResult> {
  const { data, error } = await supabase
    .rpc('reset_my_portfolio_data')
    .overrideTypes<ResetRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  const row = data.at(0)
  if (!row) throw new Error('reset_my_portfolio_data returned no result')
  return {
    purchasesDeleted: row.purchases_deleted,
    purchaseLinesDeleted: row.purchase_lines_deleted,
    salesDeleted: row.sales_deleted,
    saleLinesDeleted: row.sale_lines_deleted,
    lotDisposalsDeleted: row.lot_disposals_deleted,
    acquisitionLotsDeleted: row.acquisition_lots_deleted,
    holdingsDeleted: row.holdings_deleted,
    manualValuationsDeleted: row.manual_valuations_deleted,
    snapshotsDeleted: row.snapshots_deleted,
  }
}
