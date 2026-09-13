/**
 * P99 §7/§8 — revalidates `SCORING_TIERS` (engine.ts: highMinScore=80, mediumMinScore=45,
 * lowMinScore=20, highMinMargin=15, mediumMinMargin=8) against the NEW achievable raw-score range
 * P93's matcher redesign introduced (D-106's anchor-reliability boost), rather than trusting that
 * the byte-identical-to-pre-P93 constants remain correct by coincidence (P98's own §6 finding).
 *
 * Reuses the EXACT trial-generation machinery of `08-p93-hybrid-false-confidence.ts` (real corpus,
 * real DINOv2 embeddings, the real production `matchScannerObservation`/`rankScannerCandidatesFull`
 * functions — never a reimplementation of the matcher itself) and extends it to FOUR scenario
 * categories instead of one, reusing already-computed real similarity values across categories so
 * no extra embedding calls are needed beyond what 08-p93 already does per sampled card:
 *
 *   - disagreement   — the F-02 shape (08-p93's own construction): a DIFFERENT wrong card gets a
 *                       coincidental full id+name text match; the true card carries zero text.
 *   - text-only      — the SAME true/wrong pair, but with NO visual evidence at all (visualScores
 *                       omitted): isolates the ABSOLUTE-score thresholds against pure text signal.
 *   - visual-only    — the SAME true/wrong pair with NO text evidence for either candidate: isolates
 *                       the anchor-reliability-boosted visual score against the tier thresholds —
 *                       directly relevant to D-106/P98's quadratic-coupling finding.
 *   - same-name-print — a decoy candidate sharing the true card's own NAME (not id) — simulating a
 *                       same-name different-printing collision — gets a coincidental id+set match
 *                       while the true card carries zero text.
 *
 * Only the FINAL tier-decision arithmetic (the exact formula in `rankScannerCandidates`, copied
 * here verbatim in `decideTier` — not re-derived or approximated) is swept over a parameter grid,
 * applied post-hoc to the real captured raw scores — cheap (pure arithmetic), so a broad grid is
 * affordable without re-running the expensive embedding step for each combination.
 *
 * Run: `pnpm scanner:recognition-lab:p99-scoring-tiers-sweep`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  matchScannerObservation,
  SCORING_TIERS,
  type ScannerCandidateRecord,
  type VisualEvidenceByCard,
} from '../../../src/domain/scanner/index'
import { buildReferenceIndex, searchIndex } from '../retrieval/build-index.mjs'
import { warmUpModel, embedImageBuffer } from '../embedding/embed.mjs'
import { hardAugmentAll, cropToNominalRect } from '../augment/hard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, '..', 'reports')

interface CorpusRow {
  cardId: string
  name: string
  localId: string
  setId: string
  setName: string
  language: string
  imagePath: string
}

function toCandidate(row: CorpusRow, overrides: Partial<ScannerCandidateRecord> = {}) {
  return {
    cardId: row.cardId,
    name: row.name,
    localId: row.localId,
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language: row.language === 'ja' ? 'ja' : 'en',
    setId: row.setId,
    setName: row.setName,
    variantCount: 1,
    ...overrides,
  } satisfies ScannerCandidateRecord
}

function stratifiedSample<T>(rows: readonly T[], n: number, seedStr: string): T[] {
  let seed = 0
  for (const c of seedStr) seed = (seed * 31 + c.charCodeAt(0)) | 0
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out: T[] = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1) {
    const row = rows[(offset + i * stride) % rows.length]
    if (row) out.push(row)
  }
  return out
}

function pickWrongCard(rows: readonly CorpusRow[], trueId: string, salt: string): CorpusRow {
  let seed = 0
  for (const c of `${trueId}::${salt}`) seed = (seed * 31 + c.charCodeAt(0)) | 0
  for (let attempt = 0; attempt < rows.length; attempt += 1) {
    const idx = Math.abs(seed + attempt * 7919) % rows.length
    const candidate = rows[idx]
    if (candidate && candidate.cardId !== trueId) return candidate
  }
  throw new Error('corpus too small to pick a distinct wrong card')
}

interface Trial {
  category: 'disagreement' | 'text-only' | 'visual-only' | 'same-name-print'
  visualProfile: string
  trueId: string
  wrongId: string
  /** The real winner under the CURRENT shipped SCORING_TIERS — captured directly from the real
   *  `matchScannerObservation` call, never re-derived, so `decideTier` below can be cross-checked
   *  against it as a correctness self-test on the baseline row of the sweep. */
  shippedWinnerId: string | null
  shippedTier: string
  topRawScore: number
  runnerUpRawScore: number | null
  topIsTrueCard: boolean
  visualTextDisagreement: boolean
}

/** Verbatim copy of `rankScannerCandidates`'s own tier-decision arithmetic (engine.ts) — swept
 *  over parameters here, NOT re-derived or approximated. `disagreementFired` mirrors that
 *  function's own high->medium demotion when visual/text disagree on a moderate/strong visual
 *  read; captured once per trial against the REAL production check (see `visualTextDisagreement`
 *  above), not recomputed per grid point (the disagreement condition does not depend on the
 *  threshold parameters being swept). */
function decideTier(
  topRawScore: number,
  runnerUpRawScore: number | null,
  disagreementFired: boolean,
  params: {
    highMinScore: number
    mediumMinScore: number
    lowMinScore: number
    highMinMargin: number
    mediumMinMargin: number
  },
): 'high' | 'medium' | 'low' | 'none' {
  let tier: 'high' | 'medium' | 'low' | 'none' =
    topRawScore >= params.highMinScore
      ? 'high'
      : topRawScore >= params.mediumMinScore
        ? 'medium'
        : topRawScore >= params.lowMinScore
          ? 'low'
          : 'none'
  if (runnerUpRawScore !== null) {
    const margin = topRawScore - runnerUpRawScore
    if (tier === 'high' && margin < params.highMinMargin) tier = 'medium'
    else if (tier === 'medium' && margin < params.mediumMinMargin) tier = 'low'
  }
  if (disagreementFired && tier === 'high') tier = 'medium'
  return tier
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 300)
  const { rows, vectors } = (await buildReferenceIndex()) as {
    rows: CorpusRow[]
    vectors: Map<string, Float32Array>
  }
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN, 'p99-scoring-tiers-sweep')
  console.log(`[p99-sweep] sample ${sample.length} of ${rows.length}`)

  const trials: Trial[] = []
  let done = 0

  for (const trueRow of sample) {
    const trueId = trueRow.cardId
    const buf = await readFile(trueRow.imagePath)
    const wrongRow = pickWrongCard(rows, trueId, 'wrong-pick')

    function recordTrial(
      category: Trial['category'],
      visualProfile: string,
      match: ReturnType<typeof matchScannerObservation>,
    ): void {
      const top = match.candidates[0]
      const runnerUp = match.candidates[1]
      if (!top) return
      trials.push({
        category,
        visualProfile,
        trueId,
        wrongId: wrongRow.cardId,
        shippedWinnerId: top.card.cardId,
        shippedTier: match.tier,
        topRawScore: top.rawRankScore,
        runnerUpRawScore: runnerUp?.rawRankScore ?? null,
        topIsTrueCard: top.card.cardId === trueId,
        visualTextDisagreement: match.notes.includes('visual-text-disagreement'),
      })
    }

    function evalDisagreement(queryVec: Float32Array, profile: string): void {
      const hits = searchIndex(queryVec, vectors) as { cardId: string; similarity: number }[]
      const trueSim = hits.find((h) => h.cardId === trueId)?.similarity ?? null
      const wrongSim = hits.find((h) => h.cardId === wrongRow.cardId)?.similarity ?? null
      const visualScoresMutable = new Map<string, number>()
      if (trueSim !== null) visualScoresMutable.set(trueId, trueSim)
      if (wrongSim !== null) visualScoresMutable.set(wrongRow.cardId, wrongSim)
      const visualScores: VisualEvidenceByCard = visualScoresMutable

      // Category 1: disagreement (F-02 shape) — wrong card gets full text, true card gets none.
      recordTrial(
        'disagreement',
        profile,
        matchScannerObservation(
          { rawNameText: wrongRow.name, rawCollectorNumberText: wrongRow.localId },
          [toCandidate(trueRow), toCandidate(wrongRow)],
          visualScores,
        ),
      )

      // Category 2: text-only — same pair, NO visual evidence at all.
      recordTrial(
        'text-only',
        profile,
        matchScannerObservation(
          { rawNameText: wrongRow.name, rawCollectorNumberText: wrongRow.localId },
          [toCandidate(trueRow), toCandidate(wrongRow)],
          undefined,
        ),
      )

      // Category 3: visual-only — same pair, NO text evidence for either candidate.
      recordTrial(
        'visual-only',
        profile,
        matchScannerObservation(
          { rawNameText: '', rawCollectorNumberText: '' },
          [toCandidate(trueRow), toCandidate(wrongRow)],
          visualScores,
        ),
      )

      // Category 4: same-name-print — a decoy sharing the TRUE card's own name (a same-name
      // different-printing collision), given a coincidental id+set match; true card gets zero text.
      const sameNameDecoy = toCandidate(wrongRow, {
        cardId: `${wrongRow.cardId}::reprint-decoy`,
        name: trueRow.name,
      })
      recordTrial(
        'same-name-print',
        profile,
        matchScannerObservation(
          { rawNameText: trueRow.name, rawCollectorNumberText: wrongRow.localId },
          [toCandidate(trueRow), sameNameDecoy],
          visualScoresMutable.has(trueId)
            ? new Map([[trueId, visualScoresMutable.get(trueId) as number]])
            : undefined,
        ),
      )
    }

    evalDisagreement(await embedImageBuffer(buf), 'clean')
    // P100 brought in `augment/hard.d.mts` with a real, concretely-typed nominalRect — the
    // manual any-shaped cast this file used before that declaration existed is no longer needed.
    const hardQueries = await hardAugmentAll(buf, trueId, [
      'tilted-offcenter',
      'tilted-glare-shadow-blur',
    ])
    for (const hq of hardQueries) {
      const cropped = await cropToNominalRect(
        hq.buffer,
        hq.nominalRect,
        hq.canvasWidth,
        hq.canvasHeight,
      )
      evalDisagreement(await embedImageBuffer(cropped), hq.profile)
    }

    done += 1
    if (done % 50 === 0) console.log(`[p99-sweep] progress ${done}/${sample.length}`)
  }

  // Self-check: decideTier() applied with the CURRENT shipped constants must reproduce the real
  // production tier exactly (modulo the visual-text-disagreement demotion, already folded into
  // `decideTier` via the captured `visualTextDisagreement` flag) — proves the copied formula is
  // faithful before trusting the swept numbers at all.
  let selfCheckMismatches = 0
  for (const t of trials) {
    const recomputed = decideTier(t.topRawScore, t.runnerUpRawScore, t.visualTextDisagreement, {
      highMinScore: SCORING_TIERS.highMinScore,
      mediumMinScore: SCORING_TIERS.mediumMinScore,
      lowMinScore: SCORING_TIERS.lowMinScore,
      highMinMargin: SCORING_TIERS.highMinMargin,
      mediumMinMargin: SCORING_TIERS.mediumMinMargin,
    })
    if (recomputed !== t.shippedTier) selfCheckMismatches += 1
  }
  console.log(
    `[p99-sweep] decideTier self-check: ${trials.length - selfCheckMismatches}/${trials.length} ` +
      `match the real production tier exactly`,
  )

  // Parameter grid — centered on the shipped values, spanning a real range in both directions.
  const highMinScoreGrid = [70, 75, 80, 85, 90]
  const mediumMinScoreGrid = [35, 40, 45, 50, 55]
  const lowMinScoreGrid = [10, 15, 20, 25, 30]
  const highMinMarginGrid = [10, 15, 20, 25]
  const mediumMinMarginGrid = [4, 8, 12, 16]

  interface GridResult {
    params: {
      highMinScore: number
      mediumMinScore: number
      lowMinScore: number
      highMinMargin: number
      mediumMinMargin: number
    }
    isShipped: boolean
    falseHighCount: number
    falseHighRatePct: number
    falseMediumOrAboveCount: number
    falseMediumOrAboveRatePct: number
    trueCardHighRecallPct: number
    n: number
  }

  const results: GridResult[] = []
  for (const highMinScore of highMinScoreGrid) {
    for (const mediumMinScore of mediumMinScoreGrid) {
      if (mediumMinScore >= highMinScore) continue
      for (const lowMinScore of lowMinScoreGrid) {
        if (lowMinScore >= mediumMinScore) continue
        for (const highMinMargin of highMinMarginGrid) {
          for (const mediumMinMargin of mediumMinMarginGrid) {
            const params = {
              highMinScore,
              mediumMinScore,
              lowMinScore,
              highMinMargin,
              mediumMinMargin,
            }
            let falseHigh = 0
            let falseMediumOrAbove = 0
            let trueCardHigh = 0
            for (const t of trials) {
              const tier = decideTier(
                t.topRawScore,
                t.runnerUpRawScore,
                t.visualTextDisagreement,
                params,
              )
              const winnerIsWrong = !t.topIsTrueCard
              if (winnerIsWrong && tier === 'high') falseHigh += 1
              if (winnerIsWrong && (tier === 'high' || tier === 'medium')) falseMediumOrAbove += 1
              if (t.topIsTrueCard && tier === 'high') trueCardHigh += 1
            }
            const isShipped =
              highMinScore === SCORING_TIERS.highMinScore &&
              mediumMinScore === SCORING_TIERS.mediumMinScore &&
              lowMinScore === SCORING_TIERS.lowMinScore &&
              highMinMargin === SCORING_TIERS.highMinMargin &&
              mediumMinMargin === SCORING_TIERS.mediumMinMargin
            results.push({
              params,
              isShipped,
              falseHighCount: falseHigh,
              falseHighRatePct: Number(((100 * falseHigh) / trials.length).toFixed(3)),
              falseMediumOrAboveCount: falseMediumOrAbove,
              falseMediumOrAboveRatePct: Number(
                ((100 * falseMediumOrAbove) / trials.length).toFixed(2),
              ),
              trueCardHighRecallPct: Number(((100 * trueCardHigh) / trials.length).toFixed(1)),
              n: trials.length,
            })
          }
        }
      }
    }
  }

  const shippedResult = results.find((r) => r.isShipped) ?? null
  // "Better" defined narrowly and conservatively: strictly fewer false-HIGH occurrences (the
  // release-critical failure mode) with no worse false-medium-or-above rate and no worse true-card
  // HIGH recall — a combination that dominates shipped on every axis this sweep measures, not
  // merely one metric traded against another.
  const dominatingShipped = shippedResult
    ? results.filter(
        (r) =>
          !r.isShipped &&
          r.falseHighCount < shippedResult.falseHighCount &&
          r.falseMediumOrAboveRatePct <= shippedResult.falseMediumOrAboveRatePct &&
          r.trueCardHighRecallPct >= shippedResult.trueCardHighRecallPct,
      )
    : []

  const byCategory = Object.fromEntries(
    (['disagreement', 'text-only', 'visual-only', 'same-name-print'] as const).map((category) => {
      const subset = trials.filter((t) => t.category === category)
      const correct = subset.filter((t) => t.topIsTrueCard).length
      const falseHigh = subset.filter((t) => !t.topIsTrueCard && t.shippedTier === 'high').length
      return [
        category,
        {
          n: subset.length,
          shippedTopCorrectPct: Number(((100 * correct) / subset.length).toFixed(1)),
          shippedFalseHighCount: falseHigh,
        },
      ]
    }),
  )

  const report = {
    generatedAt: new Date().toISOString(),
    description:
      "P99 SCORING_TIERS revalidation sweep against the real production matcher's achievable " +
      'raw-score range, over 4 real-corpus adversarial scenario categories, applied post-hoc to ' +
      'real captured raw scores via a verbatim copy of the shipped tier-decision formula.',
    querySampleSize: sample.length,
    totalTrials: trials.length,
    decideTierSelfCheckMismatches: selfCheckMismatches,
    shippedConstants: {
      highMinScore: SCORING_TIERS.highMinScore,
      mediumMinScore: SCORING_TIERS.mediumMinScore,
      lowMinScore: SCORING_TIERS.lowMinScore,
      highMinMargin: SCORING_TIERS.highMinMargin,
      mediumMinMargin: SCORING_TIERS.mediumMinMargin,
    },
    shippedResult,
    gridSize: results.length,
    combinationsDominatingShipped: dominatingShipped.length,
    top5DominatingCombinations: dominatingShipped
      .sort((a, b) => a.falseHighCount - b.falseHighCount)
      .slice(0, 5),
    byCategory,
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '10-p99-scoring-tiers-sweep.json'),
    JSON.stringify({ report, results }, null, 2),
  )
  console.log('')
  console.log('=== SCORING_TIERS SWEEP SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
