/**
 * P95 §14 (F-03) — the real ~19,501-card hosted confusable-group benchmark every M15 session
 * since P75 has disclosed as blocked on hosted Supabase credentials. NOT run this session (no
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in this environment) — this is the exact, ready tooling a
 * future session with credentials should run, not a design sketch. It deliberately reuses:
 *
 *   - The SAME pagination discipline as scripts/scanner-name-lexicon/build-lexicon.ts and
 *     scripts/scanner-visual-index/build-index.ts (`drainAllCardPages`, count-reconciled,
 *     duplicate-checked — never a naive unpaginated `.select()`).
 *   - The ALREADY-BUILT production visual index at
 *     scripts/scanner-visual-index/generated/visual-v1/ (card-ids.json + embeddings.bin +
 *     manifest.json) as the reference side — no re-embedding of the real catalog happens here, so
 *     this script is read-only against `cards` (only `id, set_id, local_id, name, image_base_url,
 *     language, is_active` — never cost/collection/user data) and does not touch pricing or the
 *     visual index itself.
 *   - This lab's own DINOv2-small embedding module (embedding/embed.mjs) for QUERY vectors, the
 *     exact modelId/revision the manifest confirms the real index was built with
 *     (Xenova/dinov2-small, c2bb04a51fab207c420665f1946016107bffc701) — so query and reference
 *     vectors are directly comparable, not an approximation.
 *   - This lab's confusable-groups builder (retrieval/confusable-groups.mjs) and continuous-
 *     severity augmentation (augment/continuous.mjs) for the distorted queries.
 *
 * WHAT THIS MEASURES that the 4,296-card lab corpus cannot: confusable-group TOP1/TOP5/TOP20
 * against the REAL 19,501-card discriminative scale, using the REAL production UUIDs and the REAL
 * shipped embeddings — the standing gap this project has disclosed since P75.
 *
 * Run (owner-provided credentials, read-only against `cards`):
 *   SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> \
 *     pnpm tsx scripts/scanner-recognition-lab/f03/real-hosted-benchmark.ts [--n=400]
 *
 * Safe by construction: never fetches `profiles`/`holdings`/`purchases`/any user table; never
 * prints the service-role key; never mutates `cards` or the visual index; the query sample size
 * (`--n=`) bounds both the Supabase reads (already bounded to catalog metadata only) and the
 * number of TCGdex image downloads this run performs.
 */
import { createClient } from '@supabase/supabase-js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  drainAllCardPages,
  type PageFetchResult,
} from '../../../src/domain/scanner/index-pagination'
import {
  decodeVisualIndex,
  searchVisualIndex,
  type VisualIndexManifest,
} from '../../../src/data/scanner/visual-index'
import { embedImageBuffer, warmUpModel } from '../embedding/embed.mjs'
import { buildConfusableGroups } from '../retrieval/confusable-groups.mjs'
import { composeContinuous, IPHONE_LIKE_LEVELS } from '../augment/continuous.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const VISUAL_INDEX_DIR = join(here, '..', '..', 'scanner-visual-index', 'generated', 'visual-v1')
const REPORT_DIR = join(here, '..', 'reports')

interface CardRow {
  id: string
  set_id: string
  local_id: string
  name: string
  image_base_url: string | null
  language: string
  is_active: boolean
}

function requireEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return { url, key }
}

async function fetchCatalogMetadata(url: string, key: string): Promise<CardRow[]> {
  const supabase = createClient(url, key)
  const PAGE_SIZE = 1000
  const exactCountBefore = await (async () => {
    const { count, error } = await supabase
      .from('cards')
      .select('id', { count: 'exact', head: true })
      .eq('language', 'en')
      .eq('is_active', true)
    if (error) throw new Error(`count failed: ${error.message}`)
    return count ?? 0
  })()
  // Keyset (id-cursor) pagination — the SAME discipline build-index.ts/build-lexicon.ts actually
  // use today (`WHERE id > lastSeenId ORDER BY id LIMIT pageSize`), not the offset/`.range()` walk
  // this file originally sketched against an older base. Stable under concurrent inserts/deletes.
  const rows = await drainAllCardPages<CardRow>(
    () => Promise.resolve(exactCountBefore),
    async (afterId, limit): Promise<PageFetchResult<CardRow>> => {
      let query = supabase
        .from('cards')
        .select('id, set_id, local_id, name, image_base_url, language, is_active')
        .eq('language', 'en')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .limit(limit)
      if (afterId !== null) query = query.gt('id', afterId)
      const { data, error } = await query
      return { data, error }
    },
    { pageSize: PAGE_SIZE },
  )
  return rows.filter((r) => r.image_base_url)
}

/** Follows the real P87 F-01 content-addressed pointer (`current.json` -> `generations/<contentId>
 *  /{manifest,card-ids,embeddings}`) rather than assuming a flat directory — the real committed
 *  layout since P87, which an earlier version of this file predated. Decodes through the SAME
 *  `decodeVisualIndex` the shipped worker uses, so this tool gets the identical fail-closed
 *  schema/prototype-shape validation for free and can never misalign a dual-prototype (or future)
 *  format the way a hand-rolled one-row-per-card decode would. */
async function loadProductionIndex() {
  const pointer = JSON.parse(await readFile(join(VISUAL_INDEX_DIR, 'current.json'), 'utf-8')) as {
    contentId: string
  }
  const generationDir = join(VISUAL_INDEX_DIR, 'generations', pointer.contentId)
  const manifest = JSON.parse(
    await readFile(join(generationDir, 'manifest.json'), 'utf-8'),
  ) as VisualIndexManifest
  const cardIds = JSON.parse(
    await readFile(join(generationDir, 'card-ids.json'), 'utf-8'),
  ) as string[]
  const raw = await readFile(join(generationDir, 'embeddings.bin'))
  const int8 = new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const decoded = decodeVisualIndex(manifest, cardIds, int8)
  return { manifest, cardIds, decoded }
}

function stratifiedSample<T>(rows: T[], n: number, seedStr: string): T[] {
  let seed = 1
  for (let i = 0; i < seedStr.length; i += 1) seed = (seed * 31 + seedStr.charCodeAt(i)) | 0
  const offset = Math.abs(seed) % rows.length
  const stride = Math.max(1, Math.floor(rows.length / n))
  const out: T[] = []
  for (let i = 0; i < n && i * stride < rows.length; i += 1) {
    const row = rows[(offset + i * stride) % rows.length]
    if (row !== undefined) out.push(row)
  }
  return out
}

async function main() {
  const creds = requireEnv()
  if (!creds) {
    console.log(
      '[f03] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — this is the standing gap every ' +
        'M15 session since P75 has disclosed. Nothing else in this P95 session was blocked by ' +
        'this; every other track ran against the local 4,296-card lab corpus. To run the REAL ' +
        '19,501-card benchmark once credentials are available:\n\n' +
        '  SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> \\\n' +
        '    pnpm tsx scripts/scanner-recognition-lab/f03/real-hosted-benchmark.ts [--n=400]\n',
    )
    return
  }

  const queryN = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 400)

  console.log(
    '[f03] fetching real catalog metadata (id, set_id, local_id, name, image_base_url, language) — no user/cost data...',
  )
  const metadata = await fetchCatalogMetadata(creds.url, creds.key)
  console.log(`[f03] fetched ${metadata.length} active English cards with a usable image`)

  console.log(
    '[f03] loading production visual index (scripts/scanner-visual-index/generated/visual-v1/)...',
  )
  const { manifest, decoded } = await loadProductionIndex()
  const cardIdSet = new Set(decoded.cardIds)
  console.log(
    `[f03] production index: ${String(decoded.cardIds.length)} cards, ` +
      `model ${manifest.modelId}@${manifest.modelRevision}, ` +
      `schemaVersion=${String(manifest.schemaVersion ?? 1)} prototypesPerCard=${String(decoded.prototypesPerCard)}`,
  )

  const restrictedMetadata = metadata.filter((r) => cardIdSet.has(r.id))
  console.log(
    `[f03] ${restrictedMetadata.length} of ${metadata.length} fetched cards are present in the production index`,
  )

  const corpusRows = restrictedMetadata.map((r) => ({
    cardId: r.id,
    name: r.name,
    setId: r.set_id,
  }))
  const groups = buildConfusableGroups(corpusRows)
  const cardToGroupCards = new Map<string, string[]>()
  for (const [, cardIds] of groups) for (const id of cardIds) cardToGroupCards.set(id, cardIds)
  console.log(
    `[f03] ${groups.size} confusable groups covering ${cardToGroupCards.size} of ${restrictedMetadata.length} cards`,
  )

  const groupedRows = restrictedMetadata.filter((r) => cardToGroupCards.has(r.id))
  const sample = stratifiedSample(groupedRows, queryN, 'p95-f03-real-hosted')
  console.log(`[f03] sampling ${sample.length} confusable-group cards for the query set`)

  await warmUpModel()

  const K_VALUES = [1, 5, 20]
  const tallies = {
    clean: { n: 0, topK: { 1: 0, 5: 0, 20: 0 } },
    geometryOnly: { n: 0, topK: { 1: 0, 5: 0, 20: 0 } },
    iphoneLikeModerate: { n: 0, topK: { 1: 0, 5: 0, 20: 0 } },
  }

  let done = 0
  for (const row of sample) {
    const imageUrl = `${row.image_base_url}/high.webp`
    const response = await fetch(imageUrl)
    if (!response.ok) continue
    const buf = Buffer.from(await response.arrayBuffer())

    async function evalQuery(queryBuf: Buffer, key: keyof typeof tallies) {
      const qVec = await embedImageBuffer(queryBuf)
      // Full ranking (topK = every card) — this script needs the true rank of the correct card,
      // not just its top-K membership, and searchVisualIndex already applies the real per-card
      // max-over-prototypes reduction so a dual-prototype index is searched correctly here too.
      const hits = searchVisualIndex(decoded, qVec, decoded.cardIds.length)
      const rank = hits.findIndex((h) => h.cardId === row.id) + 1 || null
      tallies[key].n += 1
      for (const k of K_VALUES) {
        if (rank !== null && rank <= k) tallies[key].topK[k as 1 | 5 | 20] += 1
      }
    }

    await evalQuery(buf, 'clean')
    const geomBuf = await composeContinuous(buf, row.id, { perspective: 2 })
    await evalQuery(geomBuf, 'geometryOnly')
    const iphoneBuf = await composeContinuous(buf, row.id, IPHONE_LIKE_LEVELS)
    await evalQuery(iphoneBuf, 'iphoneLikeModerate')

    done += 1
    if (done % 25 === 0) console.log(`[f03] progress ${done}/${sample.length}`)
  }

  const results: Record<string, unknown> = {}
  for (const [key, t] of Object.entries(tallies)) {
    results[key] = {
      n: t.n,
      top1Pct: t.n ? Number(((100 * t.topK[1]) / t.n).toFixed(1)) : null,
      top5Pct: t.n ? Number(((100 * t.topK[5]) / t.n).toFixed(1)) : null,
      top20Pct: t.n ? Number(((100 * t.topK[20]) / t.n).toFixed(1)) : null,
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    realCatalogCardCount: metadata.length,
    productionIndexCardCount: decoded.cardIds.length,
    productionIndexSchemaVersion: manifest.schemaVersion ?? 1,
    productionIndexPrototypesPerCard: decoded.prototypesPerCard,
    confusableGroupCount: groups.size,
    confusableGroupedCardCount: cardToGroupCards.size,
    querySampleSize: sample.length,
    results,
  }
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(
    join(REPORT_DIR, 'f03-real-hosted-benchmark.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
