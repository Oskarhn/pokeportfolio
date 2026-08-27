/**
 * Visual-index coverage invariants (P77, prompt §47). The existing verify-index.ts accepted a
 * manifest claiming 1224/1000 (122.4%) coverage — it never checked coverage arithmetic at all.
 * These pin the fix shared by both the generator (pre-write) and the verifier (post-read).
 */
import { describe, expect, it } from 'vitest'
import {
  assertValidCoverage,
  CoverageInvariantError,
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
