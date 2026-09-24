import { listPortfolio, portfolioDisplayName, type PortfolioFilters } from './portfolio'
import type { LeasedDb } from './leased-client'
import { CONDITION_LABEL } from '../features/collection/labels'
import {
  buildQuickPortfolioCsv,
  type QuickPortfolioRow,
} from '../domain/export/portfolio-quick-csv'

/**
 * Portfolio Quick CSV export (M7.1 prompt §46-47): the signed-in user's own current Portfolio
 * view, safe non-secret fields, current value only when genuinely known. M13 owns the full CSV
 * suite and the versioned JSON backup — this is the quick filter-respecting report.
 *
 * Bytes are produced by the shared writer (src/domain/export/portfolio-quick-csv.ts → csv.ts);
 * this module only fetches and maps. Pages come through the existing `list_portfolio` keyset
 * cursor rather than one unbounded fetch (DATA_MODEL.md §10.1). Every page is read through `db`,
 * a leased client (P145): the file is assembled from many requests, and an identity change half
 * way must end the export instead of appending the next person's holdings to the previous
 * person's file. The result is complete or it throws — there is no partial file.
 */

/** Rows per page requested from `list_portfolio`. */
const PAGE_LIMIT = 100

/**
 * Hard page ceiling — 50 000 holdings, above the documented 10 000-lot scale target
 * (DATA_MODEL.md §10.1). Reaching it with a cursor still pending is an error, NOT a truncated
 * success: a data-portability file must never silently stop early.
 */
export const QUICK_CSV_MAX_PAGES = 500

export interface PortfolioCsvOptions {
  readonly signal?: AbortSignal
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('Export cancelled', 'AbortError')
}

export async function buildPortfolioCsv(
  filters: PortfolioFilters | undefined,
  db: LeasedDb,
  options: PortfolioCsvOptions = {},
): Promise<string> {
  const lease = db.identityLease
  const rows: QuickPortfolioRow[] = []
  let cursor = null
  const seenIds = new Set<string>()

  for (let page = 0; ; page++) {
    if (page >= QUICK_CSV_MAX_PAGES) {
      throw new Error(
        `Quick CSV stopped after ${String(QUICK_CSV_MAX_PAGES * PAGE_LIMIT)} holdings and more ` +
          'remain, so nothing was saved. Use Profile › Export & backup for a complete export.',
      )
    }
    abortIfRequested(options.signal)
    lease.assertCurrent()
    const result = await listPortfolio({ sort: 'name_asc', filters, cursor, limit: PAGE_LIMIT }, db)
    // A page read while the identity changed is dropped along with the whole export.
    lease.assertCurrent()
    for (const tile of result.results) {
      if (seenIds.has(tile.holdingId)) continue
      seenIds.add(tile.holdingId)
      const variant = [tile.variantFinish, tile.variantSubtype, tile.variantStamp]
        .filter((v): v is string => Boolean(v) && v !== 'normal')
        .join(' · ')
      rows.push({
        cardName: portfolioDisplayName(tile),
        setName: tile.cardSetName ?? tile.manualSetName ?? '',
        collectorNumber: tile.cardLocalId ?? tile.manualCollectorNumber ?? '',
        quantity: tile.quantity,
        condition: tile.condition
          ? CONDITION_LABEL[tile.condition]
          : tile.grader
            ? `Graded (${tile.grader.toUpperCase()} ${tile.grade ?? ''})`.trim()
            : '',
        variant,
        grade: tile.grade,
        storage: tile.hasMultipleStorageLocations ? 'Multiple locations' : '',
        valueStatus:
          tile.holdingKind === 'graded_card' && tile.unitValueMinor === null
            ? 'No manual value set'
            : '',
        valueNokMinor: tile.holdingValueMinor,
      })
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }

  return buildQuickPortfolioCsv(rows)
}
