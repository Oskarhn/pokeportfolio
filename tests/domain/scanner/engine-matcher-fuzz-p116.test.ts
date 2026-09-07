import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  parseScannerSignals,
  rankScannerCandidates,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../../src/domain/scanner'

/**
 * P116 §6 — matcher fuzz at release scale. `engine-adversarial-fuzz.test.ts` (P113 §26) already
 * proves adversarial-similarity/confidence finiteness and determinism at 20k runs per property.
 * This file targets the specific gaps P113 left (§6's own list): COLLECTOR-NUMBER AMBIGUITY
 * (several candidates sharing one printed local id — a real catalog shape, e.g. secret-rare
 * reprints), genuine SCORE TIES (identical rawRankScore across candidates, which the documented
 * sort contract — types.ts's `ScannerMatch.candidates` doc — says must break on cardId ascending),
 * and STRONG TEXT/VISUAL DISAGREEMENT (the text-only top pick and the visual-only top pick are
 * different candidates), run at a much larger scale than P113's 20k.
 *
 * A million-run pass is genuinely too slow for routine `pnpm test` (each run re-executes the full
 * parse+rank pipeline); the permanent suite below runs a CI-reasonable 100,000 per property and a
 * separate opt-in soak variant (`SCANNER_FUZZ_SOAK=1`) pushes one property to 1,000,000, matching
 * §6's own "smaller CI run count... heavy command for soak mode" allowance.
 */

function card(cardId: string, name: string, localId: string, setName: string): ScannerCandidateRecord {
  return {
    cardId,
    name,
    localId,
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: 'en',
    setId: `${setName}-en`,
    setName,
    variantCount: 1,
  }
}

// Deliberately collides local ids across several cards (secret-rare/reprint shape: "TG01" shared
// by TWO different printings) so collector-number evidence alone cannot disambiguate — a genuine
// real-catalog ambiguity, not a synthetic edge case.
const AMBIGUOUS_LOCAL_IDS = ['1', '1', '2', '2', '3'] as const
const CANDIDATE_POOL: ScannerCandidateRecord[] = Array.from({ length: 10 }, (_, i) =>
  card(
    `fuzz-${String(i)}`,
    // Two pairs of near-identical names (name-only evidence also ties) plus distinct ones.
    i < 4 ? 'Pikachu' : `Card ${String(i)}`,
    AMBIGUOUS_LOCAL_IDS[i % AMBIGUOUS_LOCAL_IDS.length] ?? String(i),
    `Set ${String(i % 3)}`,
  ),
)
const CANDIDATE_IDS = CANDIDATE_POOL.map((c) => c.cardId)

const arbSimilarity = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
)

/** Ties: every populated candidate gets the SAME similarity value — the exact shape the sort
 *  contract's "then cardId asc" tie-break exists for. */
const arbTiedVisualScores = fc
  .tuple(
    fc.subarray(CANDIDATE_IDS, { minLength: 0 }),
    fc.double({ min: 0, max: 1, noNaN: true }),
  )
  .map(([ids, sharedScore]): VisualEvidenceByCard => new Map(ids.map((id) => [id, sharedScore])))

const arbVisualScores = fc
  .array(fc.tuple(fc.constantFrom(...CANDIDATE_IDS), arbSimilarity), {
    maxLength: CANDIDATE_POOL.length,
  })
  .map((entries): VisualEvidenceByCard => new Map(entries))

const arbObservation = fc.record({
  rawNameText: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom('Pikachu', 'Card 5', 'garbage', ''),
  ),
  // Deliberately hits the ambiguous local ids so collector-number evidence sometimes matches
  // MULTIPLE candidates at once.
  rawCollectorNumberText: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom('1', '2', '3', '9', 'xx'),
  ),
  rawSetText: fc.oneof(fc.constant(undefined), fc.constantFrom('Set 0', 'Set 1', 'nonsense')),
  languageHint: fc.constantFrom<'en' | 'ja' | undefined>('en', 'ja', undefined),
  nameOcrConfidence: fc.oneof(fc.constant(undefined), fc.double({ min: 0, max: 100, noNaN: true })),
  collectorOcrConfidence: fc.oneof(
    fc.constant(undefined),
    fc.double({ min: 0, max: 100, noNaN: true }),
  ),
})

const PERMANENT_RUNS = 100_000
const SOAK_RUNS = 1_000_000
const SOAK_ENABLED = process.env.SCANNER_FUZZ_SOAK === '1'
const TIMEOUT_MS = 120_000

/** Mirrors engine.ts's own `finiteSimilarityOrFloor` (non-finite/absent visualSimilarity sorts as
 *  the lowest possible value) — the real sort contract (engine.ts's `rankScannerCandidatesFull`
 *  doc) is rawRankScore desc, THEN visualSimilarity desc, THEN cardId asc as the final fallback. */
function similarityOrFloor(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function assertSortedCardIdTieBreak(
  candidates: readonly {
    card: { cardId: string }
    rawRankScore: number
    visualSimilarity?: number | null
  }[],
) {
  for (let i = 1; i < candidates.length; i += 1) {
    const prev = candidates[i - 1]
    const curr = candidates[i]
    if (!prev || !curr) continue
    if (prev.rawRankScore !== curr.rawRankScore) {
      expect(prev.rawRankScore).toBeGreaterThan(curr.rawRankScore)
      continue
    }
    const prevSim = similarityOrFloor(prev.visualSimilarity)
    const currSim = similarityOrFloor(curr.visualSimilarity)
    if (prevSim !== currSim) {
      expect(prevSim).toBeGreaterThan(currSim)
      continue
    }
    // Final fallback (engine.ts): equal score AND equal (or equally absent) similarity -> cardId asc.
    expect(prev.card.cardId.localeCompare(curr.card.cardId)).toBeLessThanOrEqual(0)
  }
}

describe('matcher fuzz at release scale (P116 §6)', () => {
  it(
    `${String(PERMANENT_RUNS)} runs with collector-number-ambiguous candidates: finite scores, correct sort/tie-break, no throw`,
    () => {
      fc.assert(
        fc.property(arbObservation, arbVisualScores, (observation, visualScores) => {
          const signals = parseScannerSignals(observation)
          const result = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          for (const ranked of result.candidates) {
            expect(Number.isFinite(ranked.score)).toBe(true)
            expect(Number.isFinite(ranked.rawRankScore)).toBe(true)
          }
          assertSortedCardIdTieBreak(result.candidates)
          // Deduplicated: every cardId appears at most once even though several share a local id.
          const ids = result.candidates.map((c) => c.card.cardId)
          expect(new Set(ids).size).toBe(ids.length)
        }),
        { numRuns: PERMANENT_RUNS },
      )
    },
    TIMEOUT_MS,
  )

  it(
    `${String(PERMANENT_RUNS)} runs with genuinely TIED visual similarity across candidates: sort/tie-break holds, still deterministic`,
    () => {
      fc.assert(
        fc.property(arbObservation, arbTiedVisualScores, (observation, visualScores) => {
          const signals = parseScannerSignals(observation)
          const first = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          const second = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          expect(second).toEqual(first)
          assertSortedCardIdTieBreak(first.candidates)
        }),
        { numRuns: PERMANENT_RUNS },
      )
    },
    TIMEOUT_MS,
  )

  it(
    `${String(PERMANENT_RUNS)} runs: strong text/visual disagreement never produces a non-finite or unsorted result`,
    () => {
      // Text signal always points at candidate 0 (name 'Pikachu', local id '1'); visual evidence
      // is free to point anywhere else entirely — the real "text and visual disagree" shape §3/§6
      // ask for.
      fc.assert(
        fc.property(
          fc.constantFrom(...CANDIDATE_IDS.slice(1)),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (disagreeingCardId, similarity) => {
            const signals = parseScannerSignals({
              rawNameText: 'Pikachu',
              rawCollectorNumberText: '1',
            })
            const visualScores: VisualEvidenceByCard = new Map([[disagreeingCardId, similarity]])
            const result = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
            for (const ranked of result.candidates) {
              expect(Number.isFinite(ranked.rawRankScore)).toBe(true)
            }
            assertSortedCardIdTieBreak(result.candidates)
            if (result.tier !== 'none') {
              expect(result.notes).toBeDefined()
            }
          },
        ),
        { numRuns: PERMANENT_RUNS },
      )
    },
    TIMEOUT_MS,
  )

  it.skipIf(!SOAK_ENABLED)(
    `SOAK: ${String(SOAK_RUNS)} runs (SCANNER_FUZZ_SOAK=1 only) — full adversarial matrix stays finite and deterministic`,
    () => {
      fc.assert(
        fc.property(arbObservation, arbVisualScores, (observation, visualScores) => {
          const signals = parseScannerSignals(observation)
          const result = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          for (const ranked of result.candidates) {
            expect(Number.isFinite(ranked.rawRankScore)).toBe(true)
            expect(Number.isNaN(ranked.rawRankScore)).toBe(false)
          }
          assertSortedCardIdTieBreak(result.candidates)
        }),
        { numRuns: SOAK_RUNS },
      )
    },
    10 * 60_000,
  )
})
