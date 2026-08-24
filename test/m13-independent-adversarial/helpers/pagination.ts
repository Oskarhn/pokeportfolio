/**
 * Independent pagination oracle (prompt §8).
 *
 * DATA_MODEL.md §10.1 requires export fetches to be paginated/chunked — never one unbounded
 * query. Offset pagination over PostgREST has four classic failure modes, and the adversarial
 * point of this module is that TWO OF THEM ARE SILENT unless the exporter does more than walk
 * pages until a short page:
 *
 *  1. TRUNCATION      only the first N rows exported because a page cap or error stopped the
 *                     loop early. Walking-until-short-page CANNOT see this; only an expected
 *                     total (PostgREST count) or a post-walk reconciliation can.
 *  2. DUPLICATES      an unstable ORDER BY makes rows shift between pages, repeating some.
 *  3. GAPS            the same instability (or concurrent inserts) skips rows entirely.
 *  4. MISSING TAIL    treating "short page" as "the end" when it was actually a transient
 *                     short read loses the last partial page.
 *
 * This module is pure: tests drive it against simulated sources exhibiting each fault, and the
 * same walker is what implementation-gated tests later aim at real export fetchers.
 */

export type PageFetcher<T> = (offset: number, limit: number) => Promise<readonly T[]>

export interface WalkOptions<T> {
  /** Page size to request. Must be > 0. */
  readonly limit: number
  /**
   * Hard ceiling on pages walked (M7.1's pathological-loop guard). A source that still returns
   * full pages after maxPages throws LoopGuardFault instead of hanging.
   */
  readonly maxPages: number
  /** Stable identity of a row, for duplicate detection across page boundaries. */
  readonly keyOf: (row: T) => string
  /**
   * The authoritative total row count when the transport provides one (PostgREST `count`).
   * REQUIRED for truncation/gap detection — its absence is exactly what makes offset walking
   * silent under faults 1/3/4.
   */
  readonly expectedTotal?: number
}

export type PaginationFault =
  | { kind: 'duplicate'; key: string; firstAtIndex: number; duplicateAtIndex: number }
  | { kind: 'total-mismatch'; expected: number; received: number }
  | { kind: 'loop-guard'; pages: number }

export class PaginationError extends Error {
  readonly fault: PaginationFault
  constructor(fault: PaginationFault) {
    super(`pagination fault: ${JSON.stringify(fault)}`)
    this.name = 'PaginationError'
    this.fault = fault
  }
}

export interface WalkResult<T> {
  readonly rows: readonly T[]
  readonly pages: number
}

/**
 * Walk every page of a source with duplicate detection and optional total reconciliation.
 *
 * Termination rule: stop at the FIRST short or empty page (standard offset semantics), then —
 * if expectedTotal was provided — verify the accumulated row count matches. Duplicates are
 * checked incrementally so the fault names both indices.
 */
export async function walkAll<T>(
  fetchPage: PageFetcher<T>,
  options: WalkOptions<T>,
): Promise<WalkResult<T>> {
  if (options.limit <= 0) throw new RangeError('limit must be positive')
  if (options.maxPages <= 0) throw new RangeError('maxPages must be positive')

  const seen = new Map<string, number>()
  const rows: T[] = []
  let pages = 0

  while (pages < options.maxPages) {
    const page = await fetchPage(pages * options.limit, options.limit)
    pages += 1
    for (const row of page) {
      const key = options.keyOf(row)
      const firstAt = seen.get(key)
      if (firstAt !== undefined) {
        throw new PaginationError({
          kind: 'duplicate',
          key,
          firstAtIndex: firstAt,
          duplicateAtIndex: rows.length,
        })
      }
      seen.set(key, rows.length)
      rows.push(row)
    }
    if (page.length < options.limit) {
      if (options.expectedTotal !== undefined && rows.length !== options.expectedTotal) {
        throw new PaginationError({
          kind: 'total-mismatch',
          expected: options.expectedTotal,
          received: rows.length,
        })
      }
      return { rows, pages }
    }
  }

  throw new PaginationError({ kind: 'loop-guard', pages })
}

// ── Simulated sources used by the tests to exhibit each failure mode ────────────────────────────

/** A healthy deterministic source: rows in stable key order. */
export function stableSource<T>(rows: readonly T[]): PageFetcher<T> {
  return async (offset, limit) => rows.slice(offset, offset + limit)
}

/** Fault 1: silently serves only the first `visible` rows of a larger dataset. */
export function truncatedSource<T>(rows: readonly T[], visible: number): PageFetcher<T> {
  return async (offset, limit) => rows.slice(offset, Math.min(offset + limit, visible))
}

/**
 * Faults 2+3: models an UNSTABLE ORDER BY faithfully — the source re-sorts the WHOLE dataset
 * before every page slice, with a comparator whose direction alternates between requests
 * (equivalently: concurrent inserts/reorders between pages). Overlapping windows duplicate rows;
 * skipped windows lose them. This is what "ORDER BY without a total tiebreaker" produces under
 * offset pagination.
 */
export function unstableSource<T>(rows: readonly T[]): PageFetcher<T> {
  let calls = 0
  const pool = [...rows]
  return async (offset, limit) => {
    if (offset >= pool.length) return []
    // Alternate the global order before every slice, like a non-deterministic planner choice
    // or a mutating table would.
    if (calls % 2 === 1) {
      pool.reverse()
    }
    calls += 1
    return pool.slice(offset, offset + limit)
  }
}
