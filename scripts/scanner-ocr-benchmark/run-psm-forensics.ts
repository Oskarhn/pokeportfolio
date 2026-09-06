/**
 * P85 §3/§4/§7 — Tesseract.js 7 configuration forensics. A SEARCH over page-segmentation mode ×
 * preprocessing pass for the name and collector-number ROI fields, run against a small
 * representative subset of the real OCR corpus (see run-recognition-benchmark.ts for the full
 * ~200+ card final accuracy numbers using whatever this search finds). Deliberately bounded to a
 * subset — this answers "which config wins," not "what is the final accuracy," so it does not
 * need the full corpus × full profile set to be a real, decisive measurement.
 *
 * Run: `pnpm scanner:ocr:benchmark:psm-forensics [--cards=30]`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOcrCorpus } from './lib/corpus-lexicon.mjs'
import { buildOcrQueries } from './lib/prepare-query'
import { extractPreparedRoiPng, type RoiPreprocess } from './lib/roi-extract'
import { recognizeWithConfig, disposeOcr, PSM } from './lib/ocr-node.mjs'
import { NAME_ROI_CANDIDATES, NUMBER_ROI_CANDIDATES } from '../../src/features/scanner/roi'
import {
  normalizeCardText,
  parseCollectorNumber,
  compareCollectorNumber,
} from '../../src/domain/scanner'
import { buildNameLexicon, rankLexiconMatches } from '../../src/domain/scanner/name-lexicon'

const here = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(here, 'reports')

interface CorpusRow {
  cardId: string
  name: string
  localId: string
  setId: string
  setName: string
  language: string
  imagePath: string
}

const NAME_PSM_CANDIDATES = [
  PSM.SINGLE_LINE,
  PSM.SINGLE_WORD,
  PSM.SPARSE_TEXT,
  PSM.SINGLE_BLOCK,
  PSM.AUTO,
]
const NUMBER_PSM_CANDIDATES = [
  PSM.SINGLE_LINE,
  PSM.SINGLE_WORD,
  PSM.SPARSE_TEXT,
  PSM.SINGLE_BLOCK,
  PSM.AUTO,
]
/** Real printed ids only ever use these characters (P67 §7 formats: "049/197", "TG01/TG30",
 *  "SWSH007", "H31"); a fixed, reasoned whitelist rather than a swept dimension — sweeping
 *  whitelist on/off as a THIRD grid axis would multiply this search's runtime for a dimension
 *  with an obvious right answer for a bounded strip already cropped to "the number region." */
const NUMBER_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/-'
const PREPROCESS_OPTIONS: RoiPreprocess[] = ['contrast', 'binarize']

/** Representative subset (not the full 9): one clean-ish profile, one already-good-crop defect
 *  profile, one blur/compression profile, one profile that needs the real rectify pipeline. */
const FORENSICS_PROFILES = ['clean-resize', 'brightness-contrast', 'blur-jpeg', 'tilted-offcenter']

interface ConfigTally {
  attempts: number
  nameExact: number
  nameFuzzy: number
  numberExact: number
  numberNormalized: number
}
function freshTally(): ConfigTally {
  return { attempts: 0, nameExact: 0, nameFuzzy: 0, numberExact: 0, numberNormalized: 0 }
}
function tallyFor(map: Map<string, ConfigTally>, key: string): ConfigTally {
  const existing = map.get(key)
  if (existing) return existing
  const created = freshTally()
  map.set(key, created)
  return created
}
function rate(n: number, d: number): number {
  return d === 0 ? 0 : Number(((100 * n) / d).toFixed(1))
}

async function main() {
  const cardsArg = process.argv.find((a) => a.startsWith('--cards='))
  const maxCards = cardsArg ? Number(cardsArg.split('=')[1]) : 30

  console.log('[psm-forensics] loading corpus...')
  const fullCorpus = (await loadOcrCorpus()) as CorpusRow[]
  const corpus = fullCorpus.slice(0, maxCards)
  console.log(
    `[psm-forensics] using ${String(corpus.length)}/${String(fullCorpus.length)} cards, profiles=${FORENSICS_PROFILES.join(',')}`,
  )

  const lexicon = buildNameLexicon(fullCorpus.map((c) => c.name))

  const nameTallies = new Map<string, ConfigTally>() // key `${preprocess}|${psm}`
  const numberTallies = new Map<string, ConfigTally>()

  let queryCount = 0
  for (const row of corpus) {
    const buf = await readFile(row.imagePath)
    const allQueries = await buildOcrQueries(buf, row.cardId)
    const queries = allQueries.filter((q) => FORENSICS_PROFILES.includes(q.profile))
    for (const query of queries) {
      queryCount += 1
      for (const candidate of NAME_ROI_CANDIDATES) {
        for (const preprocess of PREPROCESS_OPTIONS) {
          const prepared = await extractPreparedRoiPng(query.rgba, candidate.fractions, preprocess)
          if (!prepared) continue
          for (const psm of NAME_PSM_CANDIDATES) {
            const { text } = await recognizeWithConfig(prepared.png, { psm })
            const cleaned = text.replace(/\s+/g, ' ').trim()
            if (cleaned.length < 3) continue
            const tally = tallyFor(nameTallies, `${preprocess}|${psm}`)
            tally.attempts += 1
            if (normalizeCardText(cleaned) === normalizeCardText(row.name)) tally.nameExact += 1
            const ranked = rankLexiconMatches(cleaned, lexicon)
            if (ranked[0]?.name === normalizeCardText(row.name)) tally.nameFuzzy += 1
          }
        }
      }
      for (const candidate of NUMBER_ROI_CANDIDATES) {
        for (const preprocess of PREPROCESS_OPTIONS) {
          const prepared = await extractPreparedRoiPng(query.rgba, candidate.fractions, preprocess)
          if (!prepared) continue
          for (const psm of NUMBER_PSM_CANDIDATES) {
            const { text } = await recognizeWithConfig(prepared.png, {
              psm,
              whitelist: NUMBER_WHITELIST,
            })
            const cleaned = text.replace(/\s+/g, ' ').trim()
            if (cleaned.length < 1) continue
            const tally = tallyFor(numberTallies, `${preprocess}|${psm}`)
            tally.attempts += 1
            const parsed = parseCollectorNumber(cleaned)
            if (parsed !== null) {
              const evidence = compareCollectorNumber(parsed, row.localId)
              if (evidence === 'exact') {
                tally.numberExact += 1
                tally.numberNormalized += 1
              } else if (evidence === 'folded' || evidence === 'numeric') {
                tally.numberNormalized += 1
              }
            }
          }
        }
      }
    }
    console.log(`[psm-forensics] ${row.cardId} done (${String(queryCount)} queries so far)`)
  }

  function summarize(map: Map<string, ConfigTally>, kind: 'name' | 'number') {
    return [...map.entries()]
      .map(([key, t]) => {
        const [preprocess, psm] = key.split('|')
        return {
          preprocess,
          psm,
          attempts: t.attempts,
          exactRate:
            kind === 'name' ? rate(t.nameExact, t.attempts) : rate(t.numberExact, t.attempts),
          fuzzyOrNormalizedRate:
            kind === 'name' ? rate(t.nameFuzzy, t.attempts) : rate(t.numberNormalized, t.attempts),
        }
      })
      .sort(
        (a, b) => b.exactRate - a.exactRate || b.fuzzyOrNormalizedRate - a.fuzzyOrNormalizedRate,
      )
  }

  const nameSummary = summarize(nameTallies, 'name')
  const numberSummary = summarize(numberTallies, 'number')
  const bestName = nameSummary[0]
  const bestNumber = numberSummary[0]

  const report = {
    generatedAt: new Date().toISOString(),
    cardsUsed: corpus.length,
    profilesUsed: FORENSICS_PROFILES,
    queryCount,
    excludedPsm: {
      values: ['0 (OSD)', '2 (OSD)', '12 (OSD)'],
      reason:
        'osd.traineddata is not staged (scripts/prepare-scanner-assets.mjs) — confirmed directly ' +
        'to silently degrade to empty text/zero confidence rather than throw, so these are not a ' +
        'usable option for this project without adding a new staged asset.',
    },
    name: { best: bestName, all: nameSummary },
    number: { best: bestNumber, all: numberSummary },
  }

  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(join(REPORT_DIR, 'psm-forensics-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await disposeOcr()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
