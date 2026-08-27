/**
 * Bounded, reconciled pagination for the offline visual-index generator (P77). Reuses the SAME
 * completeness primitive the M13 export already proved out (src/domain/export/pagination-
 * integrity.ts, D-074): an exact COUNT taken once before paging, cross-page duplicate-id
 * detection, and a final received-vs-expected reconciliation that fails loudly rather than
 * silently shipping a truncated index.
 *
 * WHY THIS EXISTS: build-index.ts's original query (`supabase.from('cards').select(...).eq(...)
 * .eq(...)`) never paginated, so PostgREST's own default `max-rows` (1000) silently truncated the
 * result to the first 1000 rows the database happened to return — the P77 owner report
 * ("1000 active English cards, 985 have image_base_url") reproduces this exactly.
 * See docs/DECISIONS.md D-097's P77 addendum.
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
 * Fetches every row of one exact-counted, `id`-ordered PostgREST range walk. `fetchTotal` and
 * `fetchPage` know nothing about Supabase specifically — real callers close over a
 * `SupabaseClient`; tests close over an in-memory fixture (PAG1–PAG8).
 */
export async function drainAllCardPages<TRow extends { id: string }>(
  fetchTotal: () => Promise<number>,
  fetchPage: (from: number, to: number) => PromiseLike<PageFetchResult<TRow>>,
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

  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize
    const to = from + pageSize - 1
    const { data, error } = await fetchPage(from, to)
    if (error !== null) {
      throw new Error(
        `Fetching cards page ${String(page)} (rows ${from}-${to}) failed: ${error.message}`,
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
  }
  throw new Error(
    `Card pagination aborted: exceeded ${String(maxPages)} pages of ${String(pageSize)} rows ` +
      'without reaching a short final page — this would otherwise loop forever.',
  )
}
