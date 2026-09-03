/**
 * P85 §12 — full-corpus OCR recognition benchmark. Runs the REAL production adaptive-ROI pipeline
 * (the exact exported functions `src/features/scanner/analyze.ts` uses: `NAME_ROI_CANDIDATES`/
 * `NUMBER_ROI_CANDIDATES`, `scoreNameRoiCandidate`/`scoreNumberRoiCandidate`,
 * `isNameRoiConfident`/`isNumberRoiConfident`, `extractCollectorNumberLine`, `cleanSignal`) against
 * a diverse, real, ground-truthed corpus with realistic phone-like perturbations, and reports
 * BASELINE (the P82/P83 pipeline — contrast then binarize passes only) vs NEW (this session's
 * P85 addition — the bounded multi-line third pass for the collector-number field) side by side.
 * The name field is byte-for-byte identical between the two (this session did not change name
 * recognition), so it is only measured once.
 *
 * Run: `pnpm scanner:ocr:benchmark:recognition [--cards-per-set=35]`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOcrCorpus, type OcrCorpusRow } from './lib/corpus-lexicon.mjs'
import { buildOcrQueries, type OcrQuery } from './lib/prepare-query'
import { extractPreparedRoiPng, type RoiPreprocess } from './lib/roi-extract'
import { recognizeWithConfig, disposeOcr, PSM } from './lib/ocr-node.mjs'
import {
  NAME_ROI_CANDIDATES,
  NUMBER_ROI_CANDIDATES,
  type NamedRoiCandidate,
} from '../../src/features/scanner/roi'
import {
  cleanSignal,
  scoreNameRoiCandidate,
  scoreNumberRoiCandidate,
  isNameRoiConfident,
  isNumberRoiConfident,
  extractCollectorNumberLine,
  MIN_NAME_TEXT_LENGTH,
  MIN_NUMBER_TEXT_LENGTH,
} from '../../src/features/scanner/analyze'
import {
  normalizeCardText,
  parseCollectorNumber,
  compareCollectorNumber,
} from '../../src/domain/scanner'
import { buildNameLexicon, rankLexiconMatches } from '../../src/domain/scanner/name-lexicon'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')

/** Forensics winner (docs/SCANNER_RESEARCH.md §7f, run-psm-forensics.ts): PSM 7 (single-line)
 *  decisively beats every other mode for a candidate crop that genuinely IS one line, for BOTH
 *  fields — the pre-existing default was already correct. */
const SINGLE_LINE_PSM = PSM.SINGLE_LINE
const MULTI_LINE_PSM = PSM.SINGLE_BLOCK

interface FieldPipelineResult {
  text: string | null
  roiId: string | null
  calls: number
}

/**
 * Byte-for-byte the same control flow as analyze.ts's `readBestRoi`: contrast pass over every
 * candidate (early exit on confidence) → binarize retry over every candidate ONLY if contrast
 * found nothing at all → (NEW, P85) multi-line retry ONLY if `multiLineExtract` is provided AND
 * both earlier passes still found nothing. Passing `multiLineExtract: undefined` reproduces the
 * exact BASELINE (P82/P83) behavior; passing it reproduces the NEW (P85) behavior — the ONLY
 * difference this session made to number-field recognition.
 */
async function runAdaptiveRoiPipeline(
  rgba: { data: Uint8ClampedArray; width: number; height: number },
  candidates: readonly NamedRoiCandidate[],
  minLength: number,
  score: (cleanedText: string, confidence: number) => number,
  isConfident: (cleanedText: string, confidence: number) => boolean,
  multiLineExtract?: (rawText: string) => string | null,
): Promise<FieldPipelineResult> {
  let calls = 0
  let bestText: string | null = null
  let bestRoiId: string | null = null
  let bestScore = -Infinity

  // Returns whether anything usable was found, not just whether it was confident — reading a
  // closure-mutated `let` back at the caller after an awaited nested call is invisible to
  // TypeScript's own control-flow narrowing (same pitfall analyze.ts's own `readBestRoi`
  // documents); returning the fact explicitly sidesteps it instead of fighting it.
  async function tryPass(
    preprocess: RoiPreprocess,
    psm: string,
    extract?: (t: string) => string | null,
  ): Promise<{ confident: boolean; foundAny: boolean }> {
    let foundAny = false
    for (const candidate of candidates) {
      const prepared = await extractPreparedRoiPng(rgba, candidate.fractions, preprocess)
      if (!prepared) continue
      calls += 1
      const { text, confidence } = await recognizeWithConfig(prepared.png, { psm })
      const rawForCleaning = extract ? (extract(text) ?? '') : text
      const cleaned = cleanSignal(rawForCleaning, minLength)
      if (cleaned === null) continue
      foundAny = true
      const candidateScore = score(cleaned, confidence)
      if (candidateScore > bestScore) {
        bestScore = candidateScore
        bestText = cleaned
        bestRoiId = candidate.id
      }
      if (isConfident(cleaned, confidence)) return { confident: true, foundAny: true }
    }
    return { confident: false, foundAny }
  }

  const contrastResult = await tryPass('contrast', SINGLE_LINE_PSM)
  if (!contrastResult.confident && !contrastResult.foundAny) {
    const binarizeResult = await tryPass('binarize', SINGLE_LINE_PSM)
    if (!binarizeResult.confident && !binarizeResult.foundAny && multiLineExtract) {
      await tryPass('contrast', MULTI_LINE_PSM, multiLineExtract)
    }
  }
  return { text: bestText, roiId: bestRoiId, calls }
}

interface FieldMetrics {
  total: number
  exact: number
  fuzzyOrNormalized: number
  top3: number
  calls: number
}
function freshMetrics(): FieldMetrics {
  return { total: 0, exact: 0, fuzzyOrNormalized: 0, top3: 0, calls: 0 }
}
function pct(n: number, d: number): number {
  return d === 0 ? 0 : Number(((100 * n) / d).toFixed(1))
}

/** Proportional diverse sample across every real set in the corpus (not just the first N rows,
 *  which would silently be all-vintage or all-modern depending on corpus.json's own row order —
 *  a real methodology bug this session found and corrected mid-session). */
function diverseSample(corpus: OcrCorpusRow[], perSet: number): OcrCorpusRow[] {
  const bySet = new Map<string, OcrCorpusRow[]>()
  for (const row of corpus) {
    const list = bySet.get(row.setId) ?? []
    list.push(row)
    bySet.set(row.setId, list)
  }
  const sample: OcrCorpusRow[] = []
  for (const rows of bySet.values()) sample.push(...rows.slice(0, perSet))
  return sample
}

async function main() {
  const perSetArg = process.argv.find((a) => a.startsWith('--cards-per-set='))
  const perSet = perSetArg ? Number(perSetArg.split('=')[1]) : 35

  console.log('[recognition-bench] loading corpus...')
  const fullCorpus = await loadOcrCorpus()
  const corpus = diverseSample(fullCorpus, perSet)
  const bySet = new Map<string, number>()
  for (const row of corpus) bySet.set(row.setId, (bySet.get(row.setId) ?? 0) + 1)
  console.log(
    `[recognition-bench] sample=${String(corpus.length)}/${String(fullCorpus.length)} cards, per-set=${JSON.stringify(Object.fromEntries(bySet))}`,
  )

  const lexicon = buildNameLexicon(fullCorpus.map((row) => row.name))

  const name = freshMetrics()
  const numberBaseline = freshMetrics()
  const numberNew = freshMetrics()
  const byCategory: Record<
    string,
    {
      name: ReturnType<typeof freshMetrics>
      numberBaseline: ReturnType<typeof freshMetrics>
      numberNew: ReturnType<typeof freshMetrics>
    }
  > = {}
  function categoryFor(row: OcrCorpusRow): string {
    if (['base1', 'base2', 'neo1'].includes(row.setId)) return 'vintage'
    if (['swsh1', 'swsh7', 'sv01'].includes(row.setId)) return 'modern'
    return 'other'
  }
  function metricsFor(category: string) {
    return (byCategory[category] ??= {
      name: freshMetrics(),
      numberBaseline: freshMetrics(),
      numberNew: freshMetrics(),
    })
  }

  let queryCount = 0
  let recoveredByMultiLine = 0
  const start = Date.now()

  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const queries: OcrQuery[] = await buildOcrQueries(buf, row.cardId)
    const category = categoryFor(row)
    const catMetrics = metricsFor(category)

    for (const query of queries) {
      queryCount += 1
      const trueName = normalizeCardText(row.name)

      const nameResult = await runAdaptiveRoiPipeline(
        query.rgba,
        NAME_ROI_CANDIDATES,
        MIN_NAME_TEXT_LENGTH,
        scoreNameRoiCandidate,
        isNameRoiConfident,
      )
      name.total += 1
      catMetrics.name.total += 1
      name.calls += nameResult.calls
      if (nameResult.text !== null) {
        if (normalizeCardText(nameResult.text) === trueName) {
          name.exact += 1
          catMetrics.name.exact += 1
        }
        const ranked = rankLexiconMatches(nameResult.text, lexicon)
        if (ranked[0]?.name === trueName) {
          name.fuzzyOrNormalized += 1
          catMetrics.name.fuzzyOrNormalized += 1
        }
        if (ranked.slice(0, 3).some((m) => m.name === trueName)) {
          name.top3 += 1
          catMetrics.name.top3 += 1
        }
      }

      const numberBaselineResult = await runAdaptiveRoiPipeline(
        query.rgba,
        NUMBER_ROI_CANDIDATES,
        MIN_NUMBER_TEXT_LENGTH,
        scoreNumberRoiCandidate,
        isNumberRoiConfident,
      )
      const numberNewResult = await runAdaptiveRoiPipeline(
        query.rgba,
        NUMBER_ROI_CANDIDATES,
        MIN_NUMBER_TEXT_LENGTH,
        scoreNumberRoiCandidate,
        isNumberRoiConfident,
        extractCollectorNumberLine,
      )

      for (const [metrics, catMetric, result] of [
        [numberBaseline, catMetrics.numberBaseline, numberBaselineResult],
        [numberNew, catMetrics.numberNew, numberNewResult],
      ] as const) {
        metrics.total += 1
        catMetric.total += 1
        metrics.calls += result.calls
        if (result.text !== null) {
          const parsed = parseCollectorNumber(result.text)
          if (parsed !== null) {
            const evidence = compareCollectorNumber(parsed, row.localId)
            if (evidence === 'exact') {
              metrics.exact += 1
              catMetric.exact += 1
              metrics.fuzzyOrNormalized += 1
              catMetric.fuzzyOrNormalized += 1
            } else if (evidence === 'folded' || evidence === 'numeric') {
              metrics.fuzzyOrNormalized += 1
              catMetric.fuzzyOrNormalized += 1
            }
          }
        }
      }
      if (numberBaselineResult.text === null && numberNewResult.text !== null) {
        recoveredByMultiLine += 1
      }
    }
    if (queryCount % 90 === 0) {
      console.log(
        `[recognition-bench] ${String(queryCount)} queries done (${((Date.now() - start) / 1000).toFixed(0)}s elapsed)`,
      )
    }
  }

  function summarize(m: FieldMetrics) {
    return {
      total: m.total,
      exactPct: pct(m.exact, m.total),
      fuzzyOrNormalizedPct: pct(m.fuzzyOrNormalized, m.total),
      top3Pct: pct(m.top3, m.total),
      avgCallsPerQuery: Number((m.calls / m.total).toFixed(2)),
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sampleCards: corpus.length,
    fullCorpusCards: fullCorpus.length,
    queryCount,
    perturbationProfiles: 9,
    lexicon: { uniqueNames: lexicon.length },
    name: summarize(name),
    numberBaseline: summarize(numberBaseline),
    numberNew: summarize(numberNew),
    numberRecoveredByMultiLinePass: recoveredByMultiLine,
    numberRecoveredByMultiLinePassPct: pct(recoveredByMultiLine, numberBaseline.total),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([cat, m]) => [
        cat,
        {
          name: summarize(m.name),
          numberBaseline: summarize(m.numberBaseline),
          numberNew: summarize(m.numberNew),
        },
      ]),
    ),
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, 'recognition-benchmark-report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
  await disposeOcr()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
