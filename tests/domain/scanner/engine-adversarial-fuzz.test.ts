import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  parseScannerSignals,
  rankScannerCandidates,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../../src/domain/scanner'

/**
 * P113 §26 — matcher adversarial fuzz. `tests/domain/scanner/engine.test.ts`'s own property suite
 * already fuzzes over CANDIDATE identity fields (name/id/set) against a fixed, realistic
 * observation. This file fuzzes the EVIDENCE space itself — visual similarity (including
 * adversarial non-finite values a poisoned or buggy upstream worker could hand the matcher),
 * OCR confidence, and evidence sparsity/absence — which is the surface prompt §26 asks for:
 * "generate huge random evidence matrices... visual similarity, visual margin, OCR name
 * confidence, collector confidence". The production code (`visual-evidence.ts`'s
 * `visualEvidencePoints`/`visualEvidenceTier`, `engine.ts`'s `ocrTextReliability`/
 * `computeVisualAnchorReliability`) already documents explicit NaN/Infinity fail-closed handling
 * (F-27) — this suite exists to VERIFY that contract holds under genuinely adversarial random
 * input at scale, not just the handful of hand-picked cases the unit tests above cover.
 */

function card(
  cardId: string,
  name: string,
  localId: string,
  setName: string,
): ScannerCandidateRecord {
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

const CANDIDATE_POOL: ScannerCandidateRecord[] = Array.from({ length: 12 }, (_, i) =>
  card(
    `fuzz-${String(i)}`,
    `Pokémon ${String(i)}`,
    `${String((i % 250) + 1)}/400`,
    `Set ${String(i % 5)}`,
  ),
)

/** Deliberately adversarial similarity values — real cosine similarity never produces most of
 *  these, which is exactly the point: a corrupted/poisoned worker message, a serialization bug,
 *  or a future refactor must not be trusted to only ever hand the matcher a "reasonable" number. */
const arbAdversarialSimilarity = fc.oneof(
  fc.double({ min: -2, max: 2, noNaN: false }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(0),
  fc.constant(-0),
)

/** Adversarial OCR confidence — real Tesseract confidence is 0-100, but nothing in
 *  `ScannerObservation`'s type narrows it at the boundary (untrusted input, per the module's own
 *  doc), so this covers out-of-range and non-finite values too. */
const arbAdversarialConfidence = fc.oneof(
  fc.double({ min: -1000, max: 1000, noNaN: false }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(null),
  fc.constant(undefined),
)

const arbVisualScores = fc
  .array(
    fc.tuple(fc.constantFrom(...CANDIDATE_POOL.map((c) => c.cardId)), arbAdversarialSimilarity),
    {
      maxLength: CANDIDATE_POOL.length,
    },
  )
  .map((entries): VisualEvidenceByCard => new Map(entries))

const arbObservation = fc.record({
  rawNameText: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom('Pokémon 3', 'garbage', ''),
  ),
  rawCollectorNumberText: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom('3/400', 'xx'),
  ),
  rawSetText: fc.oneof(fc.constant(undefined), fc.constantFrom('Set 3', 'nonsense')),
  languageHint: fc.constantFrom<'en' | 'ja' | undefined>('en', 'ja', undefined),
  nameOcrConfidence: arbAdversarialConfidence,
  collectorOcrConfidence: arbAdversarialConfidence,
})

const FUZZ_RUNS = 20_000

// fast-check's own `numRuns` iterates WITHIN one vitest `it()` block — vitest's default 5000ms
// per-test timeout is unrelated and far too short for 20,000 property evaluations; every large-N
// test below passes its own generous timeout explicitly (not a global config change).
const FUZZ_TEST_TIMEOUT_MS = 60_000

describe('matcher adversarial fuzz (P113 §26) — adversarial visual similarity + OCR confidence', () => {
  it(
    `${String(FUZZ_RUNS)} random evidence matrices: every score/rawRankScore stays finite`,
    () => {
      fc.assert(
        fc.property(arbObservation, arbVisualScores, (observation, visualScores) => {
          const signals = parseScannerSignals(observation)
          const result = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          for (const ranked of result.candidates) {
            expect(Number.isFinite(ranked.score)).toBe(true)
            expect(Number.isFinite(ranked.rawRankScore)).toBe(true)
            expect(Number.isFinite(ranked.visualReliability)).toBe(true)
            expect(Number.isNaN(ranked.score)).toBe(false)
            expect(Number.isNaN(ranked.rawRankScore)).toBe(false)
          }
        }),
        { numRuns: FUZZ_RUNS },
      )
    },
    FUZZ_TEST_TIMEOUT_MS,
  )

  it(
    `${String(FUZZ_RUNS)} random evidence matrices: ranking is deterministic even with NaN/Infinity-laden evidence`,
    () => {
      fc.assert(
        fc.property(arbObservation, arbVisualScores, (observation, visualScores) => {
          const signals = parseScannerSignals(observation)
          const first = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          const second = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          expect(second).toEqual(first)
        }),
        { numRuns: FUZZ_RUNS },
      )
    },
    FUZZ_TEST_TIMEOUT_MS,
  )

  it('an empty or undefined visualScores map contributes exactly zero visual evidence to every candidate', () => {
    fc.assert(
      fc.property(arbObservation, (observation) => {
        const signals = parseScannerSignals(observation)
        for (const visualScores of [undefined, new Map<string, number>()]) {
          const result = rankScannerCandidates(signals, CANDIDATE_POOL, visualScores)
          for (const ranked of result.candidates) {
            expect(ranked.visualReliability).toBe(0)
            expect(ranked.reasons).not.toContain('visual-strong')
            expect(ranked.reasons).not.toContain('visual-moderate')
            expect(ranked.reasons).not.toContain('visual-weak')
            expect(ranked.reasons).not.toContain('visual-anchor-corroborated')
          }
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('a visualScores map containing ONLY non-finite similarity values scores IDENTICALLY to no visual evidence at all (diagnostic-only field aside)', () => {
    const arbAllNonFinite = fc
      .array(
        fc.tuple(
          fc.constantFrom(...CANDIDATE_POOL.map((c) => c.cardId)),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        ),
        { maxLength: CANDIDATE_POOL.length, minLength: 1 },
      )
      .map((entries): VisualEvidenceByCard => new Map(entries))

    fc.assert(
      fc.property(arbObservation, arbAllNonFinite, (observation, poisonedScores) => {
        const signals = parseScannerSignals(observation)
        const poisoned = rankScannerCandidates(signals, CANDIDATE_POOL, poisonedScores)
        const clean = rankScannerCandidates(signals, CANDIDATE_POOL, undefined)
        expect(poisoned.tier).toBe(clean.tier)
        expect(poisoned.candidates).toHaveLength(clean.candidates.length)
        for (const [i, poisonedCandidate] of poisoned.candidates.entries()) {
          const cleanCandidate = clean.candidates[i]
          // The scoring/ranking OUTCOME must be byte-identical either way — a poisoned NaN/
          // Infinity carries zero weight, same as no evidence at all.
          expect(poisonedCandidate.card.cardId).toBe(cleanCandidate?.card.cardId)
          expect(poisonedCandidate.score).toBe(cleanCandidate?.score)
          expect(poisonedCandidate.rawRankScore).toBe(cleanCandidate?.rawRankScore)
          expect(poisonedCandidate.visualReliability).toBe(cleanCandidate?.visualReliability)
          expect(poisonedCandidate.reasons).toEqual(cleanCandidate?.reasons)
          // P113 finding (benign, documented, not fixed): the RAW diagnostic `visualSimilarity`
          // field is NOT sanitized the same way — it honestly reports "this card's raw evidence
          // was a poisoned non-finite value" (kept verbatim) as distinct from "no evidence was
          // ever supplied for this card" (`null`). This is a meaningful debugging distinction
          // (did a corrupted upstream message arrive, vs. did nothing arrive at all), so this
          // field is deliberately excluded from the byte-identical claim above — every field that
          // actually DRIVES scoring/ranking/tier is proven identical regardless.
        }
      }),
      { numRuns: 5000 },
    )
  })

  it('never reaches HIGH tier when there is truly zero evidence (no text signal, no finite visual evidence)', () => {
    fc.assert(
      fc.property(arbVisualScores, (visualScores) => {
        // Filter to only non-finite entries so this specific case models GENUINE zero evidence —
        // a finite (even adversarial-range) similarity is still "some" visual evidence by design.
        const zeroEvidence: VisualEvidenceByCard = new Map(
          [...visualScores.entries()].filter(([, s]) => !Number.isFinite(s)),
        )
        const signals = parseScannerSignals({})
        const result = rankScannerCandidates(signals, CANDIDATE_POOL, zeroEvidence)
        expect(result.tier).not.toBe('high')
        expect(result.tier).toBe('none')
      }),
      { numRuns: 5000 },
    )
  })
})
