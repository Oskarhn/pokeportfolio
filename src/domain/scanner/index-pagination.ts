/**
 * Bounded, reconciled KEYSET pagination for the offline visual-index generator (P77, hardened
 * P87 F-25). Reuses the SAME completeness primitive the M13 export already proved out
 * (src/domain/export/pagination-integrity.ts, D-074): cross-page duplicate-id detection and a
 * final received-vs-expected reconciliation that fails loudly rather than silently shipping a
 * truncated index.
 *
 * WHY KEYSET, NOT OFFSET (P87 F-25): the P77 version of this module walked `.range(from, to)`
 * pages — OFFSET pagination. OFFSET is not stable under concurrent mutation of the underlying
 * table: if a row is inserted or deleted ahead of the current page during an hours-long
 * full-catalog embed run (this generator's own documented workflow), every row after that point
 * shifts by one position, which can shift a row across a page boundary — skipped entirely on one
 * page's "after" edge and never re-fetched, or duplicated across two pages. The duplicate check
 * below catches the duplicate case; a genuine skip combined with a coincidental compensating
 * insert elsewhere is the one shape the final-count reconciliation is not guaranteed to catch
 * either (pagination-integrity.ts's own header discloses this same limitation for OFFSET).
 *
 * Keyset pagination (`WHERE id > lastSeenId ORDER BY id LIMIT pageSize`) has no "position" to
 * shift: each page is defined relative to the last ROW actually seen, not an ordinal offset, so
 * concurrent inserts/deletes anywhere in the table (including ahead of the cursor) cannot cause a
 * skip or duplicate. A row inserted with an id sorting BEFORE the current cursor is simply never
 * seen by this run — this module still does not provide true snapshot isolation (no single
 * PostgreSQL transaction spans an hours-long paginated walk); build-index.ts's own start/end
 * exact-count reconciliation is the higher-level guard that catches gross mutation during a run
 * (P87 §12) — a row inserted AFTER the cursor is picked up naturally on a later page.
 */
import { createSectionWalk } from '../export/pagination-integrity'

export interface PageFetchResult<TRow> {
  readonly data: TRow[] | null
  readonly error: { message: string } | null
}

/** Pathological-loop guard, same order of magnitude as EXPORT_MAX_PAGES's precedent. */
const DEFAULT_MAX_PAGES = 2000

export interface DrainCardPagesOptions {
  readonly pageSize: number
  readonly maxPages?: number
  readonly onPage?: (info: { page: number; rowsThisPage: number; totalSoFar: number }) => void
}

/**
 * Fetches every row of one exact-counted, `id`-ordered keyset walk. `fetchTotal` and `fetchPage`
 * know nothing about Supabase specifically — real callers close over a `SupabaseClient` (`.gt(
 * 'id', afterId).order('id').limit(pageSize)` when `afterId` is non-null, `.order('id').limit(
 * pageSize)` for the first page); tests close over an in-memory fixture (PAG1–PAG9).
 */
export async function drainAllCardPages<TRow extends { id: string }>(
  fetchTotal: () => Promise<number>,
  fetchPage: (afterId: string | null, limit: number) => PromiseLike<PageFetchResult<TRow>>,
  options: DrainCardPagesOptions,
): Promise<TRow[]> {
  const { pageSize, onPage } = options
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  if (pageSize <= 0) {
    throw new Error(`drainAllCardPages: pageSize must be positive, got ${String(pageSize)}.`)
  }

  const expectedTotal = await fetchTotal()
  const walk = createSectionWalk('cards', ['id'])
  const rows: TRow[] = []
  let afterId: string | null = null

  for (let page = 0; page < maxPages; page += 1) {
    const { data, error } = await fetchPage(afterId, pageSize)
    if (error !== null) {
      throw new Error(
        `Fetching cards page ${String(page)} (after ${String(afterId)}) failed: ${error.message}`,
      )
    }
    const pageRows = data ?? []
    // Duplicate-id detection across pages (PAG6) and count reconciliation (PAG8) both come from
    // the same tested primitive the export pipeline already relies on — see the module header.
    walk.observe(pageRows)
    for (const row of pageRows) rows.push(row)
    onPage?.({ page: page + 1, rowsThisPage: pageRows.length, totalSoFar: walk.received })
    if (pageRows.length < pageSize) {
      walk.finish(expectedTotal)
      return rows
    }
    const lastRow = pageRows[pageRows.length - 1]
    if (lastRow === undefined) {
      // pageRows.length === pageSize > 0 guarantees this is unreachable; kept as a defensive
      // guard against ever silently looping on an empty-but-"full" page.
      throw new Error(`Card pagination: page ${String(page)} reported a full page with no rows.`)
    }
    afterId = lastRow.id
  }
  throw new Error(
    `Card pagination aborted: exceeded ${String(maxPages)} pages of ${String(pageSize)} rows ` +
      'without reaching a short final page — this would otherwise loop forever.',
  )
}
