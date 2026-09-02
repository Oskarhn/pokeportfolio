/**
 * Visual-index generator KEYSET pagination (P77, hardened P87 F-25, prompt §45 PAG1–PAG9). PAG1–
 * PAG8 reproduce the exact class of bug the owner's real hosted rebuild hit: an unpaginated query
 * silently truncated by PostgREST's default 1000-row cap ("1000 active English cards, 985 have
 * image_base_url"). PAG9 is new: proves keyset pagination survives a concurrent mutation pattern
 * that would silently corrupt an OFFSET walk (the exact scenario F-25 flagged).
 */
import { describe, expect, it } from 'vitest'
import {
  drainAllCardPages,
  type PageFetchResult,
} from '../../../src/domain/scanner/index-pagination'

interface Row {
  id: string
}

function makeRows(count: number): Row[] {
  // Zero-padded so lexicographic string order matches numeric order — mirrors `.order('id')`
  // over real ascending values closely enough for these pure tests.
  return Array.from({ length: count }, (_, i) => ({ id: `card-${String(i).padStart(6, '0')}` }))
}

/** Keyset fetcher over a fixed, already-sorted array: returns every row with id > afterId,
 *  capped at `limit`. Mirrors `.gt('id', afterId).order('id').limit(limit)` (or, when afterId is
 *  null, `.order('id').limit(limit)` for the first page). */
function keysetFetcher(all: Row[]) {
  return (afterId: string | null, limit: number): Promise<PageFetchResult<Row>> => {
    const startIndex = afterId === null ? 0 : all.findIndex((r) => r.id > afterId)
    if (startIndex === -1) return Promise.resolve({ data: [], error: null })
    return Promise.resolve({ data: all.slice(startIndex, startIndex + limit), error: null })
  }
}

function fixedCount(n: number): () => Promise<number> {
  return () => Promise.resolve(n)
}

describe('PAG1 — a large fake catalog beyond the 1000-row PostgREST cap is fully returned', () => {
  it('returns all 2500 rows across pages, not just the first 1000', async () => {
    const all = makeRows(2500)
    const rows = await drainAllCardPages(fixedCount(2500), keysetFetcher(all), { pageSize: 500 })
    expect(rows.length).toBe(2500)
    expect(rows[0]?.id).toBe('card-000000')
    expect(rows[2499]?.id).toBe('card-002499')
  })
})

describe('PAG2 — exactly 1000 rows terminates correctly', () => {
  it('fetches exactly 1000 rows and stops', async () => {
    const all = makeRows(1000)
    const rows = await drainAllCardPages(fixedCount(1000), keysetFetcher(all), { pageSize: 500 })
    expect(rows.length).toBe(1000)
  })
})

describe('PAG3 — one row past a page boundary forces a second page', () => {
  it('fetches the 1001st row on a second page', async () => {
    const all = makeRows(1001)
    const rows = await drainAllCardPages(fixedCount(1001), keysetFetcher(all), { pageSize: 1000 })
    expect(rows.length).toBe(1001)
    expect(rows[1000]?.id).toBe('card-001000')
  })
})

describe('PAG4 — a short final page terminates the walk', () => {
  it('stops as soon as a page returns fewer rows than pageSize', async () => {
    let calls = 0
    const all = makeRows(1200)
    const rows = await drainAllCardPages(
      fixedCount(1200),
      (afterId, limit) => {
        calls += 1
        return keysetFetcher(all)(afterId, limit)
      },
      { pageSize: 500 },
    )
    expect(rows.length).toBe(1200)
    // 500 + 500 + 200 (short page, stop) = 3 calls, never a 4th probe.
    expect(calls).toBe(3)
  })
})

describe('PAG5 — deterministic ordering', () => {
  it('preserves the id-ascending order the fetcher returns, across page boundaries', async () => {
    const all = makeRows(1500)
    const rows = await drainAllCardPages(fixedCount(1500), keysetFetcher(all), { pageSize: 400 })
    const ids = rows.map((r) => r.id)
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })
})

describe('PAG6 — duplicate/overlapping pages are rejected', () => {
  it('throws when the same id is returned on two different pages', async () => {
    // A keyset fetcher cannot structurally re-return an id <= afterId (that is what makes it
    // immune to the offset-shift class of bug) — but a buggy or lying data source could still do
    // it, and the duplicate check must catch that regardless of pagination style.
    const pages: Row[][] = [
      [{ id: 'card-000000' }, { id: 'card-000001' }],
      [{ id: 'card-000001' }, { id: 'card-000002' }], // repeats page 1's last row
    ]
    let call = 0
    const fetchPage = (): Promise<PageFetchResult<Row>> => {
      const page = pages[call]
      call += 1
      return Promise.resolve({ data: page ?? [], error: null })
    }
    await expect(drainAllCardPages(fixedCount(4), fetchPage, { pageSize: 2 })).rejects.toThrow(
      /duplicate row/,
    )
  })
})

describe('PAG7 — a server/query error on a later page fails the whole build', () => {
  it('throws immediately, naming the failing page', async () => {
    const all = makeRows(1500)
    let page = 0
    const fetchPage = (afterId: string | null, limit: number): Promise<PageFetchResult<Row>> => {
      page += 1
      if (page === 2) return Promise.resolve({ data: null, error: { message: 'connection reset' } })
      return keysetFetcher(all)(afterId, limit)
    }
    await expect(drainAllCardPages(fixedCount(1500), fetchPage, { pageSize: 500 })).rejects.toThrow(
      /page 1.*connection reset/,
    )
  })
})

describe('PAG8 — an exact-count mismatch fails the build', () => {
  it('throws when the walk received fewer rows than the exact count claimed', async () => {
    const all = makeRows(900)
    await expect(
      drainAllCardPages(fixedCount(1000), keysetFetcher(all), { pageSize: 500 }),
    ).rejects.toThrow(/received 900 of 1000/)
  })

  it('throws when the walk received MORE rows than the exact count claimed', async () => {
    const all = makeRows(1100)
    await expect(
      drainAllCardPages(fixedCount(1000), keysetFetcher(all), { pageSize: 2000 }),
    ).rejects.toThrow(/received 1100 of 1000/)
  })
})

describe('PAG9 — keyset pagination survives concurrent mutation patterns that break OFFSET (F-25)', () => {
  it('never skips or duplicates a row when one is inserted AHEAD of the cursor mid-walk', async () => {
    // Simulates: page 1 reads card-000000..card-000001 (pageSize 2). Before page 2 fetches,
    // 'card-000001b' is inserted (sorts between 000001 and 000002) — exactly the shape that would
    // shift every subsequent OFFSET page by one and either skip or duplicate a row. Keyset asks
    // "everything after card-000001", so it naturally picks up the new row with no special case.
    const base = makeRows(4) // 000000, 000001, 000002, 000003
    const mutatedRows = [base[0]!, base[1]!, { id: 'card-000001b' }, base[2]!, base[3]!]
    let callCount = 0
    const fetchPage = (afterId: string | null, limit: number): Promise<PageFetchResult<Row>> => {
      callCount += 1
      // The insert becomes visible starting from the SECOND call onward — "before page 2 fetches"
      // — a call counter (not an afterId comparison) keeps this deterministic regardless of
      // exactly when within one call's body a real concurrent writer's change would land.
      const live = callCount >= 2 ? mutatedRows : base
      const startIndex = afterId === null ? 0 : live.findIndex((r) => r.id > afterId)
      if (startIndex === -1) return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: live.slice(startIndex, startIndex + limit), error: null })
    }
    const rows = await drainAllCardPages(fixedCount(5), fetchPage, { pageSize: 2 })
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual([
      'card-000000',
      'card-000001',
      'card-000001b',
      'card-000002',
      'card-000003',
    ])
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
  })

  it('a row deleted BEHIND the cursor mid-walk causes no duplicate or crash', async () => {
    // card-000000 is deleted after page 1 has already read it — an OFFSET walk would shift every
    // later page back by one (skipping a row); a keyset walk is entirely unaffected because it
    // never re-reads anything at or before the cursor.
    const all = makeRows(4)
    let callCount = 0
    const fetchPage = (afterId: string | null, limit: number): Promise<PageFetchResult<Row>> => {
      callCount += 1
      // Deleted starting from the SECOND call onward, same deterministic-timing rationale as the
      // insert-ahead test above.
      const live = callCount >= 2 ? all.slice(1) : all
      const startIndex = afterId === null ? 0 : live.findIndex((r) => r.id > afterId)
      if (startIndex === -1) return Promise.resolve({ data: [], error: null })
      return Promise.resolve({ data: live.slice(startIndex, startIndex + limit), error: null })
    }
    const rows = await drainAllCardPages(fixedCount(4), fetchPage, { pageSize: 2 })
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual(['card-000000', 'card-000001', 'card-000002', 'card-000003'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('pathological loop guard', () => {
  it('gives up after maxPages instead of looping forever against a fetcher that never shrinks', async () => {
    let cursor = 0
    const fetchPage = (): Promise<PageFetchResult<Row>> => {
      const start = cursor
      cursor += 10
      return Promise.resolve({
        data: Array.from({ length: 10 }, (_, i) => ({ id: `x-${String(start + i)}` })),
        error: null,
      })
    }
    await expect(
      drainAllCardPages(fixedCount(1_000_000_000), fetchPage, { pageSize: 10, maxPages: 5 }),
    ).rejects.toThrow(/exceeded 5 pages/)
  })
})
