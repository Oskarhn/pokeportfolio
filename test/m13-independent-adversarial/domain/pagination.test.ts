/**
 * ACTIVE pure-oracle tests: pagination correctness (prompt section 8).
 *
 * The adversarial core: a naive "walk pages until a short page" exporter CANNOT detect
 * truncation or gaps on its own. These tests prove the trap exists (the naive walk happily
 * returns 1000 of 2500 rows) and that the oracle's walker — which reconciles against an
 * expected total and detects duplicate identity keys — catches every injected fault.
 *
 * The same walker is what implementation-gated tests later aim at real export fetchers.
 */
import { describe, expect, it } from 'vitest'

import {
  PaginationError,
  stableSource,
  truncatedSource,
  unstableSource,
  walkAll,
} from '../helpers/pagination.ts'

interface Row {
  readonly id: number
}

const ROWS_2500: readonly Row[] = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1 }))

const keyOf = (r: Row): string => String(r.id)

describe('pagination walker against healthy sources', () => {
  it('walks a stable source to exhaustion across multiple full pages + partial tail', async () => {
    const result = await walkAll(stableSource(ROWS_2500), {
      limit: 1000,
      maxPages: 500,
      keyOf,
    })
    expect(result.pages).toBe(3) // 1000 + 1000 + 500
    expect(result.rows.length).toBe(2500)
    expect(result.rows[0]?.id).toBe(1)
    expect(result.rows[2499]?.id).toBe(2500)
  })

  it('raises the loop guard instead of hanging when a source never runs dry', async () => {
    const infinite: Parameters<typeof walkAll<Row>>[0] = async (offset) =>
      Array.from({ length: 10 }, (_, i) => ({ id: offset + i + 1 }))
    await expect(walkAll(infinite, { limit: 10, maxPages: 5, keyOf })).rejects.toMatchObject({
      fault: { kind: 'loop-guard', pages: 5 },
    })
  })
})

describe('fault 1: truncation (only the first page(s) exported)', () => {
  it('DEMONSTRATES THE TRAP: naive short-page walking silently accepts 1000 of 2500 rows', async () => {
    // A source that dies after the first 1000 rows returns exactly one FULL page then an empty
    // one — indistinguishable from "done" for any offset-walking exporter without total
    // reconciliation. This is the silent data loss the contract forbids.
    const truncated = truncatedSource(ROWS_2500, 1000)
    const naive = await walkNaive(truncated, 1000)
    expect(naive.length).toBe(1000)
    expect(naive.length).not.toBe(ROWS_2500.length)
  })

  it('the contract walker REJECTS the same source when the transport provides a count', async () => {
    const truncated = truncatedSource(ROWS_2500, 1000)
    await expect(
      walkAll(truncated, { limit: 1000, maxPages: 500, keyOf, expectedTotal: 2500 }),
    ).rejects.toMatchObject({
      fault: { kind: 'total-mismatch', expected: 2500, received: 1000 },
    })
  })

  it('accepts a genuinely complete export whose count matches', async () => {
    const result = await walkAll(stableSource(ROWS_2500), {
      limit: 1000,
      maxPages: 500,
      keyOf,
      expectedTotal: 2500,
    })
    expect(result.rows.length).toBe(2500)
  })
})

describe('faults 2+3: unstable ordering (duplicates AND gaps)', () => {
  it('detects a duplicated row across page boundaries by identity key', async () => {
    const unstable = unstableSource(ROWS_2500)
    let sawDuplicate = false
    try {
      await walkAll(unstable, { limit: 1000, maxPages: 500, keyOf })
    } catch (err) {
      expect(err).toBeInstanceOf(PaginationError)
      const fault = (err as PaginationError).fault
      if (fault.kind === 'duplicate') {
        sawDuplicate = true
        expect(fault.firstAtIndex).toBeLessThan(fault.duplicateAtIndex)
      }
    }
    expect(sawDuplicate).toBe(true)
  })

  it('detects gaps via expected-total reconciliation even when no duplicate fired', async () => {
    // Source that skips row 7 entirely but is otherwise well-ordered.
    const gapped = async (offset: number, limit: number): Promise<readonly Row[]> =>
      ROWS_2500.filter((r) => r.id !== 7).slice(offset, offset + limit)
    await expect(
      walkAll(gapped, { limit: 1000, maxPages: 500, keyOf, expectedTotal: 2500 }),
    ).rejects.toMatchObject({ fault: { kind: 'total-mismatch', received: 2499 } })
  })
})

describe('fault 4: missing last partial page', () => {
  it('a source that drops its final short page fails total reconciliation', async () => {
    const missingTail = truncatedSource(ROWS_2500, 2000) // pages 1-2 only; last 500 gone
    const naive = await walkNaive(missingTail, 1000)
    expect(naive.length).toBe(2000)
    await expect(
      walkAll(missingTail, { limit: 1000, maxPages: 500, keyOf, expectedTotal: 2500 }),
    ).rejects.toMatchObject({ fault: { kind: 'total-mismatch', expected: 2500, received: 2000 } })
  })
})

/** The NAIVE strategy, deliberately implemented here as the documented anti-pattern. */
async function walkNaive(
  fetchPage: (offset: number, limit: number) => Promise<readonly Row[]>,
  limit: number,
): Promise<Row[]> {
  const rows: Row[] = []
  let offset = 0
  for (;;) {
    const page = await fetchPage(offset, limit)
    if (page.length === 0) break
    rows.push(...page)
    if (page.length < limit) break
    offset += limit
  }
  return rows
}
