/**
 * Visual-index generator pagination (P77, prompt §45 PAG1–PAG8). These reproduce the exact class
 * of bug the owner's real hosted rebuild hit: an unpaginated query silently truncated by
 * PostgREST's default 1000-row cap ("1000 active English cards, 985 have image_base_url").
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

function fixedFetcher(all: Row[]) {
  return (from: number, to: number): Promise<PageFetchResult<Row>> =>
    Promise.resolve({ data: all.slice(from, to + 1), error: null })
}

function fixedCount(n: number): () => Promise<number> {
  return () => Promise.resolve(n)
}

describe('PAG1 — a large fake catalog beyond the 1000-row PostgREST cap is fully returned', () => {
  it('returns all 2500 rows across pages, not just the first 1000', async () => {
    const all = makeRows(2500)
    const rows = await drainAllCardPages(fixedCount(2500), fixedFetcher(all), { pageSize: 500 })
    expect(rows.length).toBe(2500)
    expect(rows[0]?.id).toBe('card-000000')
    expect(rows[2499]?.id).toBe('card-002499')
  })
})

describe('PAG2 — exactly 1000 rows terminates correctly', () => {
  it('fetches exactly 1000 rows and stops', async () => {
    const all = makeRows(1000)
    const rows = await drainAllCardPages(fixedCount(1000), fixedFetcher(all), { pageSize: 500 })
    expect(rows.length).toBe(1000)
  })
})

describe('PAG3 — one row past a page boundary forces a second page', () => {
  it('fetches the 1001st row on a second page', async () => {
    const all = makeRows(1001)
    const rows = await drainAllCardPages(fixedCount(1001), fixedFetcher(all), { pageSize: 1000 })
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
      (from, to) => {
        calls += 1
        return fixedFetcher(all)(from, to)
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
    const rows = await drainAllCardPages(fixedCount(1500), fixedFetcher(all), { pageSize: 400 })
    const ids = rows.map((r) => r.id)
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
  })
})

describe('PAG6 — duplicate/overlapping pages are rejected', () => {
  it('throws when the same id is returned on two different pages', async () => {
    const overlapping: Row[] = [
      { id: 'card-000000' },
      { id: 'card-000001' },
      { id: 'card-000001' }, // page 2 re-returns page 1's last row (a reorder/overlap bug)
      { id: 'card-000002' },
    ]
    const fetchPage = (from: number, to: number): Promise<PageFetchResult<Row>> =>
      Promise.resolve({ data: overlapping.slice(from, to + 1), error: null })
    await expect(drainAllCardPages(fixedCount(4), fetchPage, { pageSize: 2 })).rejects.toThrow(
      /duplicate row/,
    )
  })
})

describe('PAG7 — a server/query error on a later page fails the whole build', () => {
  it('throws immediately, naming the failing page', async () => {
    const all = makeRows(1500)
    let page = 0
    const fetchPage = (from: number, to: number): Promise<PageFetchResult<Row>> => {
      page += 1
      if (page === 2) return Promise.resolve({ data: null, error: { message: 'connection reset' } })
      return fixedFetcher(all)(from, to)
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
      drainAllCardPages(fixedCount(1000), fixedFetcher(all), { pageSize: 500 }),
    ).rejects.toThrow(/received 900 of 1000/)
  })

  it('throws when the walk received MORE rows than the exact count claimed', async () => {
    const all = makeRows(1100)
    await expect(
      drainAllCardPages(fixedCount(1000), fixedFetcher(all), { pageSize: 2000 }),
    ).rejects.toThrow(/received 1100 of 1000/)
  })
})

describe('pathological loop guard', () => {
  it('gives up after maxPages instead of looping forever against a fetcher that never shrinks', async () => {
    const fetchPage = (from: number, to: number): Promise<PageFetchResult<Row>> =>
      Promise.resolve({
        data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: `x-${String(from + i)}` })),
        error: null,
      })
    await expect(
      drainAllCardPages(fixedCount(1_000_000_000), fetchPage, { pageSize: 10, maxPages: 5 }),
    ).rejects.toThrow(/exceeded 5 pages/)
  })
})
