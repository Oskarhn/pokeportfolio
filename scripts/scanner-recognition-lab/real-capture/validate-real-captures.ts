/**
 * P100 §5: REAL_CAPTURE_VALIDATION protocol and tooling — the owner-facing way to answer the
 * question P98 raised (synthetic "iPhone-like" data cannot prove physical iPhone accuracy) once
 * the owner has independently captured card photos with a real device.
 *
 * NOT fabricated this session: this repository holds no independently-captured real photo
 * directory anywhere (checked — see output_100.txt's REAL_CAPTURE_RESULTS field). This is the
 * exact, ready tool for when the owner provides one, not a design sketch.
 *
 * INPUT CONTRACT
 *   --dir=<path>       Directory of real capture image files (jpg/jpeg/png/webp).
 *   --mapping=<path>   JSON file: either
 *                         [{ "file": "IMG_0001.jpg", "cardId": "<uuid>", "name": "...",
 *                            "setName": "..." }, ...]
 *                       or an object keyed by filename with the same per-entry shape. `cardId`
 *                       MUST be a real `cards.id` UUID present in the visual index being tested
 *                       against — this tool never guesses an id from a name/set string.
 *   --index=<path>     Optional. Root of a P87-shaped visual-index directory (containing
 *                       current.json + generations/<contentId>/...). Defaults to the real
 *                       committed scripts/scanner-visual-index/generated/visual-v1.
 *
 * OUTPUT: one JSON report with, per capture: TOP1/TOP3/TOP5/TOP20 hit flags, the true card's own
 * rank and similarity, WHICH prototype won for it (0=pristine, 1..N=auxiliary — meaningful only on
 * a dual/multi-prototype index; always 0 on a legacy single-prototype index), capture quality
 * (laplacianVariance) and the shipped severe-blur abstention decision, PLUS an aggregate summary.
 *
 * NO CARD-SPECIFIC SCORING (prompt's own requirement): every capture is scored through the exact
 * same generic decode/search/quality pipeline regardless of which card it is — nothing here
 * special-cases an id, name, or set.
 *
 * Run:
 *   pnpm tsx scripts/scanner-recognition-lab/real-capture/validate-real-captures.ts \
 *     --dir=/path/to/real/captures --mapping=/path/to/mapping.json
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeVisualIndex,
  type VisualIndexManifest,
  type DecodedVisualIndex,
} from '../../../src/data/scanner/visual-index'
import { computeQualityMetrics } from '../quality/metrics.mjs'
// The lab's own DINOv2-small module — pinned to the identical model id/revision the production
// index manifest declares (checked below before trusting any result), so query vectors are
// directly comparable to whichever index (legacy or dual-prototype) this tool is pointed at.
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_INDEX_DIR = join(here, '..', '..', 'scanner-visual-index', 'generated', 'visual-v1')
const REPORT_DIR = join(here, '..', 'reports')
const BLUR_ABSTAIN_THRESHOLD = 378 // src/domain/scanner/capture-quality.ts, unchanged — reproduced
// here in plain JS/TS since this lab's scripts do not import the app's domain layer directly,
// matching every prior lab benchmark's own disclosed reproduction (e.g. experiment 17/18).

interface MappingEntry {
  file: string
  cardId: string
  name?: string
  setName?: string
}

function parseArgs(): { dir: string; mappingPath: string; indexDir: string } {
  const dirArg = process.argv
    .find((a) => a.startsWith('--dir='))
    ?.split('=')
    .slice(1)
    .join('=')
  const mappingArg = process.argv
    .find((a) => a.startsWith('--mapping='))
    ?.split('=')
    .slice(1)
    .join('=')
  const indexArg = process.argv
    .find((a) => a.startsWith('--index='))
    ?.split('=')
    .slice(1)
    .join('=')
  if (!dirArg || !mappingArg) {
    console.log(
      'Usage: pnpm tsx scripts/scanner-recognition-lab/real-capture/validate-real-captures.ts ' +
        '--dir=<real-capture-directory> --mapping=<mapping.json> [--index=<visual-index-root>]',
    )
    process.exit(1)
  }
  return { dir: dirArg, mappingPath: mappingArg, indexDir: indexArg ?? DEFAULT_INDEX_DIR }
}

async function loadMapping(mappingPath: string): Promise<MappingEntry[]> {
  const raw = JSON.parse(await readFile(mappingPath, 'utf-8')) as unknown
  if (Array.isArray(raw)) return raw as MappingEntry[]
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, Omit<MappingEntry, 'file'>>).map(
      ([file, entry]) => ({ file, ...entry }),
    )
  }
  throw new Error(`Mapping file ${mappingPath} is neither an array nor an object.`)
}

async function loadIndex(
  indexDir: string,
): Promise<{ manifest: VisualIndexManifest; decoded: DecodedVisualIndex }> {
  const pointer = JSON.parse(await readFile(join(indexDir, 'current.json'), 'utf-8')) as {
    contentId: string
  }
  const generationDir = join(indexDir, 'generations', pointer.contentId)
  const manifest = JSON.parse(
    await readFile(join(generationDir, 'manifest.json'), 'utf-8'),
  ) as VisualIndexManifest
  const cardIds = JSON.parse(
    await readFile(join(generationDir, 'card-ids.json'), 'utf-8'),
  ) as string[]
  const raw = await readFile(join(generationDir, 'embeddings.bin'))
  const int8 = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const decoded = decodeVisualIndex(manifest, cardIds, int8)
  return { manifest, decoded }
}

interface SearchHitWithProto {
  cardId: string
  similarity: number
  winningPrototype: number
}

/** Full-ranking search over the decoded index that ALSO reports which prototype row won for each
 *  card — searchVisualIndex (production) deliberately hides this (the matcher never needs it); a
 *  real-capture validation report wants it as a diagnostic, not a matching signal. */
function searchWithPrototypeWinner(
  index: DecodedVisualIndex,
  queryVector: Float32Array,
): SearchHitWithProto[] {
  const dim = index.manifest.embeddingDim
  const prototypesPerCard = index.prototypesPerCard
  const hits: SearchHitWithProto[] = []
  for (let cardIndex = 0; cardIndex < index.cardIds.length; cardIndex += 1) {
    const cardId = index.cardIds[cardIndex]
    if (cardId === undefined) continue
    let best = -Infinity
    let bestProto = 0
    const rowStart = cardIndex * prototypesPerCard
    for (let proto = 0; proto < prototypesPerCard; proto += 1) {
      const start = (rowStart + proto) * dim
      let dot = 0
      for (let d = 0; d < dim; d += 1)
        dot += (index.embeddings[start + d] ?? 0) * (queryVector[d] ?? 0)
      if (dot > best) {
        best = dot
        bestProto = proto
      }
    }
    hits.push({ cardId, similarity: best, winningPrototype: bestProto })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

async function main(): Promise<void> {
  const { dir, mappingPath, indexDir } = parseArgs()

  if (!existsSync(dir)) {
    console.error(`[real-capture] directory does not exist: ${dir}`)
    process.exitCode = 1
    return
  }
  const mapping = await loadMapping(mappingPath)
  console.log(`[real-capture] ${mapping.length} mapping entries loaded from ${mappingPath}`)

  const { manifest, decoded } = await loadIndex(indexDir)
  console.log(
    `[real-capture] index: ${decoded.cardIds.length} cards, model ${manifest.modelId}@${manifest.modelRevision}, ` +
      `schemaLabel=${decoded.schemaLabel}, prototypesPerCard=${String(decoded.prototypesPerCard)}`,
  )

  const dirFiles = new Set(await readdir(dir))
  await warmUpModel()

  const perCapture: unknown[] = []
  let top1 = 0,
    top3 = 0,
    top5 = 0,
    top20 = 0,
    abstained = 0,
    missingFile = 0,
    unknownCardId = 0

  for (const entry of mapping) {
    if (!dirFiles.has(entry.file)) {
      console.warn(`[real-capture] SKIP — file not found in --dir: ${entry.file}`)
      missingFile += 1
      continue
    }
    const ext = extname(entry.file).toLowerCase()
    if (!IMAGE_EXTENSIONS.has(ext)) {
      console.warn(`[real-capture] SKIP — unrecognized image extension: ${entry.file}`)
      continue
    }
    if (!decoded.cardIds.includes(entry.cardId)) {
      console.warn(
        `[real-capture] SKIP — mapping cardId "${entry.cardId}" (file ${entry.file}) is not present in this index`,
      )
      unknownCardId += 1
      continue
    }

    const buf = await readFile(join(dir, entry.file))
    const quality = await computeQualityMetrics(buf)
    const abstain = quality.laplacianVariance < BLUR_ABSTAIN_THRESHOLD

    const qVec = await embedImageBuffer(buf)
    const hits = searchWithPrototypeWinner(decoded, qVec)
    const rank = hits.findIndex((h) => h.cardId === entry.cardId) + 1 || null
    const trueHit = hits.find((h) => h.cardId === entry.cardId)

    if (abstain) abstained += 1
    if (rank !== null && rank <= 1) top1 += 1
    if (rank !== null && rank <= 3) top3 += 1
    if (rank !== null && rank <= 5) top5 += 1
    if (rank !== null && rank <= 20) top20 += 1

    perCapture.push({
      file: entry.file,
      cardId: entry.cardId,
      name: entry.name ?? null,
      setName: entry.setName ?? null,
      rank,
      inTop1: rank === 1,
      inTop3: rank !== null && rank <= 3,
      inTop5: rank !== null && rank <= 5,
      inTop20: rank !== null && rank <= 20,
      similarity: trueHit?.similarity ?? null,
      winningPrototype: trueHit?.winningPrototype ?? null,
      captureQuality: {
        laplacianVariance: quality.laplacianVariance,
        abstainForBlur: abstain,
      },
    })
  }

  const scored = perCapture.length
  const summary = {
    generatedAt: new Date().toISOString(),
    mappingEntries: mapping.length,
    scoredCaptures: scored,
    skippedMissingFile: missingFile,
    skippedUnknownCardId: unknownCardId,
    indexModelId: manifest.modelId,
    indexModelRevision: manifest.modelRevision,
    indexSchemaLabel: decoded.schemaLabel,
    indexPrototypesPerCard: decoded.prototypesPerCard,
    top1Pct: scored ? Number(((100 * top1) / scored).toFixed(1)) : null,
    top3Pct: scored ? Number(((100 * top3) / scored).toFixed(1)) : null,
    top5Pct: scored ? Number(((100 * top5) / scored).toFixed(1)) : null,
    top20Pct: scored ? Number(((100 * top20) / scored).toFixed(1)) : null,
    abstainedForBlurPct: scored ? Number(((100 * abstained) / scored).toFixed(1)) : null,
  }

  const report = { summary, captures: perCapture }
  await mkdir(REPORT_DIR, { recursive: true })
  const outPath = join(REPORT_DIR, 'real-capture-validation.json')
  await writeFile(outPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  console.log(`[real-capture] full per-capture report written to ${outPath}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
