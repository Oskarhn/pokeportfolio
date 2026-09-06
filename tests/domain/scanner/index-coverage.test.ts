/**
 * Visual-index coverage invariants (P77, prompt §47). The existing verify-index.ts accepted a
 * manifest claiming 1224/1000 (122.4%) coverage — it never checked coverage arithmetic at all.
 * These pin the fix shared by both the generator (pre-write) and the verifier (post-read).
 */
import { describe, expect, it } from 'vitest'
import {
  assertValidCoverage,
  computeCoverageBreakdown,
  CoverageInvariantError,
  logFailureBudget,
  MIN_INDEXED_OF_USABLE_IMAGE_PERCENT,
} from '../../../src/domain/scanner/index-coverage'

function coverage(overrides: Partial<Parameters<typeof assertValidCoverage>[0]> = {}) {
  return {
    totalCanonicalCards: 1000,
    cardsWithUsableImage: 985,
    cardsIndexed: 985,
    failures: 0,
    ...overrides,
  }
}

describe('assertValidCoverage', () => {
  it('accepts healthy, internally consistent coverage', () => {
    expect(() => {
      assertValidCoverage(coverage(), 985, 985)
    }).not.toThrow()
  })

  it('rejects cardsIndexed exceeding totalCanonicalCards (the 1224/1000 shape)', () => {
    expect(() => {
      assertValidCoverage(
        coverage({ totalCanonicalCards: 1000, cardsWithUsableImage: 1224, cardsIndexed: 1224 }),
        1224,
        1224,
      )
    }).toThrow(CoverageInvariantError)
  })

  it('rejects cardsIndexed exceeding cardsWithUsableImage', () => {
    expect(() => {
      assertValidCoverage(coverage({ cardsWithUsableImage: 900, cardsIndexed: 985 }), 985, 985)
    }).toThrow(/exceeds cardsWithUsableImage/)
  })

  it('rejects a card-ids length disagreeing with coverage.cardsIndexed', () => {
    expect(() => {
      assertValidCoverage(coverage(), 984, 985)
    }).toThrow(/card-ids length/)
  })

  it('rejects a manifest.cardCount disagreeing with coverage.cardsIndexed', () => {
    expect(() => {
      assertValidCoverage(coverage(), 985, 984)
    }).toThrow(/manifest\.cardCount/)
  })

  it('rejects negative counts', () => {
    expect(() => {
      assertValidCoverage(coverage({ failures: -1 }), 985, 985)
    }).toThrow(/never be negative/)
  })

  it('accepts zero-card coverage (a fresh, empty index) without dividing by zero', () => {
    expect(() => {
      assertValidCoverage(
        { totalCanonicalCards: 0, cardsWithUsableImage: 0, cardsIndexed: 0, failures: 0 },
        0,
        0,
      )
    }).not.toThrow()
  })

  it("R14 (P78): accepts the owner's real full-catalog hosted rebuild (19501/20946, 93.1%)", () => {
    expect(() => {
      assertValidCoverage(
        coverage({
          totalCanonicalCards: 20946,
          cardsWithUsableImage: 19501,
          cardsIndexed: 19501,
          failures: 6,
        }),
        19501,
        19501,
      )
    }).not.toThrow()
  })

  it('R15 (P78): still rejects an impossible-coverage manifest at the same real-world scale', () => {
    expect(() => {
      assertValidCoverage(
        coverage({
          totalCanonicalCards: 20946,
          cardsWithUsableImage: 19501,
          cardsIndexed: 20946, // claims every canonical card indexed despite fewer usable images
        }),
        20946,
        20946,
      )
    }).toThrow(/exceeds cardsWithUsableImage/)
  })
})

describe('computeCoverageBreakdown (N-07: honest coverage, denominators labelled)', () => {
  it('separates the no-usable-image gap from genuine embed failures instead of hiding it', () => {
    // Synthetic P94 prompt fixture: 100 total, 80 usable, 78 indexed, 2 real embed failures,
    // 20 cards with no usable image at all. The old single "2 failures" line implied 98/100
    // coverage; the honest breakdown must make the 20-card gap impossible to miss.
    const breakdown = computeCoverageBreakdown({
      totalCanonicalCards: 100,
      cardsWithUsableImage: 80,
      cardsIndexed: 78,
      failures: 2,
    })
    expect(breakdown.totalCanonical).toBe(100)
    expect(breakdown.cardsWithUsableImage).toBe(80)
    expect(breakdown.cardsWithoutUsableImage).toBe(20)
    expect(breakdown.cardsIndexed).toBe(78)
    expect(breakdown.indexFailuresAmongUsableImages).toBe(2)
    expect(breakdown.totalUnindexed).toBe(22) // 20 no-image + 2 embed failures
    expect(breakdown.indexedOfTotalPercent).toBeCloseTo(78, 5)
    expect(breakdown.indexedOfUsableImagePercent).toBeCloseTo(97.5, 5)
  })

  it('reports null (not a divide-by-zero NaN or misleading 0%) for indexed/usable-image when no card has a usable image', () => {
    const breakdown = computeCoverageBreakdown({
      totalCanonicalCards: 5,
      cardsWithUsableImage: 0,
      cardsIndexed: 0,
      failures: 0,
    })
    expect(breakdown.indexedOfUsableImagePercent).toBeNull()
    expect(breakdown.cardsWithoutUsableImage).toBe(5)
  })

  it("matches the owner's real full-catalog hosted rebuild breakdown (19501/20946)", () => {
    const breakdown = computeCoverageBreakdown({
      totalCanonicalCards: 20946,
      cardsWithUsableImage: 19508,
      cardsIndexed: 19501,
      failures: 7,
    })
    expect(breakdown.cardsWithoutUsableImage).toBe(1438)
    expect(breakdown.totalUnindexed).toBe(1445)
    expect(breakdown.indexedOfTotalPercent).toBeCloseTo(93.1013, 2)
    expect(breakdown.indexedOfUsableImagePercent).toBeCloseTo(99.964, 2)
  })

  it('P97 (D-106): passes through aux-prototype coverage when present, absent when not (v1)', () => {
    const dual = computeCoverageBreakdown({
      totalCanonicalCards: 100,
      cardsWithUsableImage: 100,
      cardsIndexed: 100,
      failures: 0,
      cardsWithAuxPrototype: 97,
      cardsAuxFallback: 3,
    })
    expect(dual.cardsWithAuxPrototype).toBe(97)
    expect(dual.cardsAuxFallback).toBe(3)

    const single = computeCoverageBreakdown({
      totalCanonicalCards: 100,
      cardsWithUsableImage: 100,
      cardsIndexed: 100,
      failures: 0,
    })
    expect(single.cardsWithAuxPrototype).toBeUndefined()
    expect(single.cardsAuxFallback).toBeUndefined()
  })
})

describe('assertValidCoverage — P97 (D-106) auxiliary-prototype invariants', () => {
  it('accepts aux coverage that sums to exactly cardsIndexed', () => {
    expect(() => {
      assertValidCoverage(
        coverage({
          cardsWithUsableImage: 85, // P110: kept equal to cardsIndexed so the coverage-floor check (a different invariant) can't spuriously trip this aux-specific test.
          cardsWithAuxPrototype: 80,
          cardsAuxFallback: 5,
          cardsIndexed: 85,
        }),
        85,
        85,
      )
    }).not.toThrow()
  })

  it('rejects cardsWithAuxPrototype + cardsAuxFallback exceeding cardsIndexed', () => {
    expect(() => {
      assertValidCoverage(
        coverage({ cardsWithAuxPrototype: 80, cardsAuxFallback: 10, cardsIndexed: 85 }),
        85,
        85,
      )
    }).toThrow(/exceeds cardsIndexed/)
  })

  it('rejects a negative aux coverage number', () => {
    expect(() => {
      assertValidCoverage(coverage({ cardsWithAuxPrototype: -1 }), 985, 985)
    }).toThrow(/Auxiliary-prototype coverage/)
  })

  it('a v1 manifest with no aux fields at all still passes (both default to 0)', () => {
    expect(() => {
      assertValidCoverage(coverage(), 985, 985)
    }).not.toThrow()
  })
})

describe('assertValidCoverage — P110 coverage floor (prompt §4, §11)', () => {
  it('hard-fails a 20%-complete run (1000 usable, only 200 succeeded)', () => {
    expect(() => {
      assertValidCoverage(
        coverage({ totalCanonicalCards: 1000, cardsWithUsableImage: 1000, cardsIndexed: 200 }),
        200,
        200,
      )
    }).toThrow(/below the minimum acceptable coverage floor/)
  })

  it('accepts a 99.5%-complete run (1000 usable, 995 succeeded) — above the floor', () => {
    expect(() => {
      assertValidCoverage(
        coverage({ totalCanonicalCards: 1000, cardsWithUsableImage: 1000, cardsIndexed: 995 }),
        995,
        995,
      )
    }).not.toThrow()
  })

  it(`rejects a run landing exactly one card below the floor (${String(MIN_INDEXED_OF_USABLE_IMAGE_PERCENT)}%)`, () => {
    // 977/1000 = 97.7%, just under the 98% floor.
    expect(() => {
      assertValidCoverage(
        coverage({ totalCanonicalCards: 1000, cardsWithUsableImage: 1000, cardsIndexed: 977 }),
        977,
        977,
      )
    }).toThrow(CoverageInvariantError)
  })

  it('accepts a run landing exactly at the floor', () => {
    // 980/1000 = exactly 98%.
    expect(() => {
      assertValidCoverage(
        coverage({ totalCanonicalCards: 1000, cardsWithUsableImage: 1000, cardsIndexed: 980 }),
        980,
        980,
      )
    }).not.toThrow()
  })

  it('real production baseline (19501/19508, 99.964%) clears the floor with margin', () => {
    expect(() => {
      assertValidCoverage(
        coverage({ totalCanonicalCards: 20946, cardsWithUsableImage: 19508, cardsIndexed: 19501 }),
        19501,
        19501,
      )
    }).not.toThrow()
  })

  it('never divides by zero when cardsWithUsableImage is 0', () => {
    expect(() => {
      assertValidCoverage(
        { totalCanonicalCards: 5, cardsWithUsableImage: 0, cardsIndexed: 0, failures: 0 },
        0,
        0,
      )
    }).not.toThrow()
  })
})

describe('logFailureBudget (P110, prompt §5) — never collapses distinct failure causes into one number', () => {
  it('logs every bucket by its own explicit name, with DECODE_FAILURE and EMBED_FAILURE reported equal and explained', () => {
    const lines: string[] = []
    logFailureBudget(
      {
        fetchFailure: 3,
        http404: 7,
        http429: 2,
        http5xx: 1,
        httpOther: 0,
        decodeFailure: 4,
        embedFailure: 4,
      },
      (line) => lines.push(line),
    )
    const joined = lines.join('\n')
    expect(joined).toContain('FETCH_FAILURE=3')
    expect(joined).toContain('HTTP_404=7')
    expect(joined).toContain('HTTP_429=2')
    expect(joined).toContain('HTTP_5XX=1')
    expect(joined).toContain('HTTP_OTHER=0')
    expect(joined).toContain('DECODE_FAILURE=4')
    expect(joined).toContain('EMBED_FAILURE=4')
  })
})
