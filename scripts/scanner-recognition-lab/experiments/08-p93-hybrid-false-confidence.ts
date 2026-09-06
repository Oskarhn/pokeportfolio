/**
 * P93 §15/§16/§21 — real, corpus-scale adversarial benchmark of the REDESIGNED hybrid matcher
 * (src/domain/scanner/engine.ts's `matchScannerObservation`, D-106), not just the visual-only
 * retrieval layer P91's own 06-dominance-threshold.mjs measured. Reuses P91's cached ~4,300-card
 * corpus/reference-index (copied from the sibling `p91-m15-recognition-rnd` worktree per this
 * prompt's own "do not redownload needlessly" instruction — see scripts/scanner-recognition-lab/
 * .cache/corpus.json's `imagePath` fields, which point at that worktree's images directory
 * directly rather than duplicating ~330MB of JPEGs; this script therefore requires that sibling
 * worktree to still exist on disk, documented here rather than silently assumed).
 *
 * For each sampled card, three real embedded queries are produced against the REAL DINOv2 model
 * (no synthetic similarity numbers): the pristine reference re-embedded ('clean'), P84/P91's own
 * 'tilted-offcenter' geometry-only hard-defect profile (the regime whose MEAN similarity, 0.812,
 * is the exact operating point P92's audit flagged as broken under the old absolute 0.82
 * dominance guard), and 'tilted-glare-shadow-blur' (the catastrophic regime, where the guard must
 * stay structurally inert).
 *
 * The adversarial construction: for EACH query, in addition to the true card's own real visual
 * similarity, a DIFFERENT, randomly chosen WRONG card from the corpus is given a coincidental
 * TEXT-ONLY match (its own printed id + name, as if OCR had read them exactly) while the TRUE
 * card carries ZERO text evidence of its own — the exact F-02 mechanism, run at real scale against
 * real images rather than one hand-picked unit-test pair. `matchScannerObservation` (the actual
 * production function, imported directly — not reimplemented) then decides the winner.
 *
 * Run: `pnpm scanner:recognition-lab:p93-adversarial`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  matchScannerObservation,
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

function toCandidate(row: CorpusRow): ScannerCandidateRecord {
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
  }
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

/** Deterministic pseudo-random "wrong card" pick, distinct from `trueId`, stable per query so
 *  reruns are reproducible without a stored RNG state. */
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
  profile: string
  trueId: string
  wrongId: string
  trueSimilarity: number | null
  wrongSimilarity: number | null
  winnerId: string | null
  tier: string
  correct: boolean
  falseHigh: boolean
}

async function main() {
  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 300)
  const { rows, vectors } = (await buildReferenceIndex()) as {
    rows: CorpusRow[]
    vectors: Map<string, Float32Array>
  }
  await warmUpModel()
  const sample = stratifiedSample(rows, queryN, 'p93-hybrid-false-confidence')
  console.log(`[p93-adversarial] sample ${sample.length} of ${rows.length}`)

  const trials: Trial[] = []
  let done = 0

  for (const trueRow of sample) {
    const trueId = trueRow.cardId
    const buf = await readFile(trueRow.imagePath)
    const wrongRow = pickWrongCard(rows, trueId, 'wrong-pick')

    function evalQuery(queryVec: Float32Array, profile: string) {
      const hits = searchIndex(queryVec, vectors) as { cardId: string; similarity: number }[]
      const trueSimilarity = hits.find((h) => h.cardId === trueId)?.similarity ?? null
      const wrongSimilarity = hits.find((h) => h.cardId === wrongRow.cardId)?.similarity ?? null

      const visualScoresMutable = new Map<string, number>()
      if (trueSimilarity !== null) visualScoresMutable.set(trueId, trueSimilarity)
      if (wrongSimilarity !== null) visualScoresMutable.set(wrongRow.cardId, wrongSimilarity)
      const visualScores: VisualEvidenceByCard = visualScoresMutable

      // The F-02 adversarial construction: the WRONG card's own printed id+name are handed to
      // the matcher as if OCR read them exactly; the TRUE card carries zero text evidence.
      const match = matchScannerObservation(
        { rawNameText: wrongRow.name, rawCollectorNumberText: wrongRow.localId },
        [toCandidate(trueRow), toCandidate(wrongRow)],
        visualScores,
      )
      const winnerId = match.candidates[0]?.card.cardId ?? null
      trials.push({
        profile,
        trueId,
        wrongId: wrongRow.cardId,
        trueSimilarity,
        wrongSimilarity,
        winnerId,
        tier: match.tier,
        correct: winnerId === trueId,
        falseHigh: winnerId === wrongRow.cardId && match.tier === 'high',
      })
    }

    // Embed the true card under three real conditions (P84/P91's own calibrated profiles).
    evalQuery(await embedImageBuffer(buf), 'clean')
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
      evalQuery(await embedImageBuffer(cropped), hq.profile)
    }

    done += 1
    if (done % 50 === 0) console.log(`[p93-adversarial] progress ${done}/${sample.length}`)
  }

  const byProfile: Record<
    string,
    { n: number; correctPct: number; falseHighPct: number; abstainedOrLowPct: number }
  > = {}
  for (const profile of [...new Set(trials.map((t) => t.profile))]) {
    const subset = trials.filter((t) => t.profile === profile)
    const correct = subset.filter((t) => t.correct).length
    const falseHigh = subset.filter((t) => t.falseHigh).length
    const notHigh = subset.filter((t) => t.tier !== 'high').length
    byProfile[profile] = {
      n: subset.length,
      correctPct: Number(((100 * correct) / subset.length).toFixed(1)),
      falseHighPct: Number(((100 * falseHigh) / subset.length).toFixed(2)),
      abstainedOrLowPct: Number(((100 * notHigh) / subset.length).toFixed(1)),
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    description:
      'P93 real-corpus adversarial hybrid-matcher benchmark: for each query, a DIFFERENT ' +
      "corpus card is given the true card's own coincidental id+name text match, while the " +
      'true card carries zero text evidence — the F-02 mechanism at real scale.',
    querySampleSize: sample.length,
    totalTrials: trials.length,
    byProfile,
    // Diagnostic: how the true card's own real similarity distributes per profile, so the report
    // is independently checkable against P84/P91's own documented calibration numbers.
    similarityByProfile: Object.fromEntries(
      [...new Set(trials.map((t) => t.profile))].map((profile) => {
        const sims = trials
          .filter((t) => t.profile === profile && t.trueSimilarity !== null)
          .map((t) => t.trueSimilarity as number)
        const mean = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : null
        return [profile, { n: sims.length, meanTrueSimilarity: mean }]
      }),
    ),
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, '08-p93-hybrid-false-confidence.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
}
