/**
 * Generates the static visual reference index (D-097, prompt §18–§20): one embedding per
 * canonical catalog card, quantized to INT8, packed as manifest.json + card-ids.json +
 * embeddings.bin under scripts/scanner-visual-index/generated/visual-v1/. Those generated files
 * ARE committed (small, binary, no card images — prompt §21) and staged into
 * public/scanner-assets/visual-v1/ at build time by stage-index-assets.mjs, exactly like the
 * pinned model files.
 *
 * Credentials: reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the process environment —
 * NEVER `.env.local`, same posture as scripts/portfolio-perf-benchmark.mjs (docs/DEVELOPMENT.md
 * §2). Defaults to the LOCAL stack's well-known dev keys when unset, so `pnpm scanner:index:build`
 * works out of the box against `supabase start` for iteration. Building the REAL, hosted-scale
 * index requires the owner to run this once with the HOSTED project's service-role key exported
 * in their OWN shell — this script (and this session) never receives or requests that value.
 *
 * FULL-CATALOG PAGINATION (P77): the original version of this script ran one unpaginated
 * `.select(...)` query, which PostgREST silently truncates at its default 1000-row cap — the
 * exact bug the owner's hosted rebuild hit ("1000 active English cards, 985 have
 * image_base_url"). Every row is now fetched via `drainAllCardPages` (src/domain/scanner/
 * index-pagination.ts): an exact COUNT taken up front, `.order('id').range(...)` pages well below
 * the cap, cross-page duplicate detection, and a hard failure if the final received count ever
 * disagrees with the exact count. See docs/DECISIONS.md D-097's P77 addendum.
 *
 * Resumable: writes a checkpoint file after every embedded card; a re-run skips cards already
 * embedded — but ONLY when the checkpoint's recorded identity (schema/source project/model/
 * revision/dimension/quantization) matches this run exactly (src/domain/scanner/
 * checkpoint-identity.ts). A mismatched or pre-P77 checkpoint is discarded loudly and rebuilt from
 * scratch — never silently reused across a project/model boundary (the 1224/1000 contamination
 * class). Packing is additionally constrained to the CURRENT fetched canonical id set
 * (defense-in-depth even if identity validation were ever bypassed), and the generator asserts
 * the same coverage invariants verify-index.ts checks before it will write any output.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
  checkpointMatchesIdentity,
  deriveProjectIdentity,
  freshCheckpoint,
  packCurrentCardIds,
  CHECKPOINT_SCHEMA_VERSION,
  type Checkpoint,
  type CheckpointIdentity,
} from '../../src/domain/scanner/checkpoint-identity'
import { assertValidCoverage } from '../../src/domain/scanner/index-coverage'
import { drainAllCardPages, type PageFetchResult } from '../../src/domain/scanner/index-pagination'
import {
  quantizeEmbedding,
  l2Normalize,
  VISUAL_INDEX_QUANTIZATION,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'
import { embedImageBuffer, warmUpModel } from '../scanner-visual-benchmark/lib/embed.mjs'
import { VISUAL_MODEL_REPO, VISUAL_MODEL_REVISION, VISUAL_EMBEDDING_DIM } from './lib/model-pin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(here, 'generated', 'visual-v1')
const CHECKPOINT_PATH = join(here, '.visual-index-cache', 'build-checkpoint.json')

/** Well below PostgREST's 1000-row cap so a single page is never the truncation boundary itself. */
const PAGE_SIZE = 500

const LOCAL_DEFAULTS = {
  url: 'http://127.0.0.1:54321',
  // Well-known LOCAL demo service-role key, printed by `supabase status` on every machine —
  // not a secret (Supabase's own local-dev fixture), never valid against a hosted project.
  serviceRoleKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
}

interface CardRow {
  id: string
  local_id: string
  name: string
  image_base_url: string | null
  is_active: boolean
}

async function loadCheckpointFile(): Promise<unknown> {
  if (!existsSync(CHECKPOINT_PATH)) return null
  return JSON.parse(await readFile(CHECKPOINT_PATH, 'utf-8')) as unknown
}
async function saveCheckpoint(checkpoint: Checkpoint & Partial<CheckpointIdentity>) {
  mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true })
  await writeFile(CHECKPOINT_PATH, JSON.stringify(checkpoint))
}

/** Reference-image fetch/decode failures, classified (prompt §19) — never silently folded into a
 *  zero vector; every failure means the card is simply excluded from this index run. */
interface ImageFailureCounts {
  notFound: number // HTTP 404
  otherHttp: number // any other non-OK HTTP status
  decode: number // fetch succeeded but embedding/decoding threw
}

async function main() {
  const url = process.env.SUPABASE_URL ?? LOCAL_DEFAULTS.url
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_DEFAULTS.serviceRoleKey
  const isLocal = url === LOCAL_DEFAULTS.url
  console.log(`[index] connecting to ${isLocal ? 'LOCAL' : 'a NON-LOCAL'} project at ${url}`)

  const supabase = createClient(url, key)

  // Exact count FIRST (prompt §4/§39 HOSTED_ACTIVE_ENGLISH_CARD_COUNT) — the number every page
  // fetched below must reconcile against. A `count:'exact'` HEAD request never returns rows, so
  // it is cheap even against a large catalog.
  const countQuery = await supabase
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('language', 'en')
    .eq('is_active', true)
  if (countQuery.error !== null || countQuery.count === null) {
    throw new Error(`Exact count query failed: ${countQuery.error?.message ?? 'no count returned'}`)
  }
  const exactCount = countQuery.count
  console.log(`[index] exact count: ${String(exactCount)} active English cards.`)

  const cards = await drainAllCardPages<CardRow>(
    () => Promise.resolve(exactCount),
    async (from, to): Promise<PageFetchResult<CardRow>> => {
      const { data, error } = await supabase
        .from('cards')
        .select('id, local_id, name, image_base_url, is_active')
        .eq('language', 'en')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to)
      return { data, error }
    },
    {
      pageSize: PAGE_SIZE,
      onPage: ({ page, rowsThisPage, totalSoFar }) => {
        console.log(
          `[index] page ${String(page)}: ${String(rowsThisPage)} rows, running total ${String(totalSoFar)}`,
        )
      },
    },
  )

  const totalCanonicalCards = cards.length
  const withImage = cards.filter((c) => c.image_base_url !== null && c.image_base_url !== '')
  console.log(
    `[index] ${String(totalCanonicalCards)} active English cards (FULL catalog, paginated), ` +
      `${String(withImage.length)} have image_base_url`,
  )

  // ---- Checkpoint: load, then validate identity BEFORE trusting a single embedded row ----
  const expectedIdentity: CheckpointIdentity = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sourceProjectIdentity: deriveProjectIdentity(url),
    modelId: VISUAL_MODEL_REPO,
    modelRevision: VISUAL_MODEL_REVISION,
    embeddingDim: VISUAL_EMBEDDING_DIM,
    quantization: VISUAL_INDEX_QUANTIZATION,
  }
  const loaded = await loadCheckpointFile()
  let checkpoint: Checkpoint & Partial<CheckpointIdentity>
  if (loaded === null) {
    checkpoint = freshCheckpoint(expectedIdentity)
  } else {
    const candidate = loaded as Checkpoint & Partial<CheckpointIdentity>
    if (checkpointMatchesIdentity(candidate, expectedIdentity)) {
      checkpoint = candidate
      console.log(
        `[index] resuming checkpoint (${String(Object.keys(candidate.embeddings).length)} ` +
          'embeddings already cached) — source/model identity matches this run.',
      )
    } else {
      console.warn(
        '[index] WARNING: discarding the existing checkpoint — its recorded identity ' +
          '(schema/source project/model/revision/dimension/quantization) does not match this ' +
          'run, or it predates identity binding entirely (P77). Reusing it would risk mixing ' +
          'embeddings from a different project/model into this index (the historical 1224/1000 ' +
          'contamination bug). Starting a fresh checkpoint — already-embedded cards WILL be ' +
          're-embedded.',
      )
      checkpoint = freshCheckpoint(expectedIdentity)
    }
  }
  checkpoint = { ...checkpoint, totalCanonicalCards, cardsWithUsableImage: withImage.length }

  await warmUpModel()

  const imageFailures: ImageFailureCounts = { notFound: 0, otherHttp: 0, decode: 0 }
  let processed = 0
  for (const card of withImage) {
    if (Object.hasOwn(checkpoint.embeddings, card.id)) continue
    const imageUrl = `${card.image_base_url}/high.webp`
    try {
      const response = await fetch(imageUrl)
      if (!response.ok) {
        if (response.status === 404) imageFailures.notFound += 1
        else imageFailures.otherHttp += 1
        throw new Error(`image fetch ${String(response.status)}`)
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      let raw: Float32Array
      try {
        raw = await embedImageBuffer(buffer)
      } catch (decodeError) {
        imageFailures.decode += 1
        throw decodeError
      }
      const normalized = l2Normalize(new Float32Array(raw))
      checkpoint.embeddings[card.id] = Array.from(normalized)
    } catch (err) {
      // No persisted failure counter here (P78, §18): a card that keeps failing across resumed
      // runs used to increment a checkpoint-carried total every attempt, double-counting the SAME
      // card each time the build was resumed. `coverage.failures` below is derived fresh from
      // cardsWithUsableImage - cardsIndexed at pack time instead — current-build-based, never
      // cumulative.
      console.warn(`[index] failed ${card.id} (${card.name}): ${(err as Error).message}`)
    }
    processed += 1
    if (processed % 25 === 0) {
      await saveCheckpoint(checkpoint)
      console.log(`[index] progress: ${String(processed)}/${String(withImage.length)}`)
    }
  }
  await saveCheckpoint(checkpoint)
  console.log(
    `[index] image failures — 404: ${String(imageFailures.notFound)}, other HTTP: ` +
      `${String(imageFailures.otherHttp)}, decode: ${String(imageFailures.decode)}.`,
  )

  // ---- Pack: constrained to the CURRENT canonical fetch, in its deterministic id order ----
  // (prompt §7 index-membership defense-in-depth) — never `Object.keys(checkpoint.embeddings)`
  // directly, which is exactly how a stale/contaminated checkpoint used to leak extra rows in.
  const currentIdsInOrder = withImage.map((c) => c.id)
  const cardIds = packCurrentCardIds(currentIdsInOrder, checkpoint.embeddings)
  const staleCount = Object.keys(checkpoint.embeddings).length - cardIds.length
  if (staleCount > 0) {
    console.warn(
      `[index] discarding ${String(staleCount)} checkpoint embeddings not in the current ` +
        'canonical fetch (deactivated, image removed, or leftover from a prior identity).',
    )
  }

  const dim = VISUAL_EMBEDDING_DIM
  const int8Buffer = new Int8Array(cardIds.length * dim)
  cardIds.forEach((cardId, row) => {
    const stored = checkpoint.embeddings[cardId]
    if (!stored) throw new Error(`Missing embedding for ${cardId} while packing the index.`)
    const quantized = quantizeEmbedding(new Float32Array(stored))
    int8Buffer.set(quantized, row * dim)
  })

  mkdirSync(OUT_DIR, { recursive: true })
  const embeddingsPath = join(OUT_DIR, 'embeddings.bin')
  await writeFile(embeddingsPath, Buffer.from(int8Buffer.buffer))
  const embeddingsSha256 = createHash('sha256').update(Buffer.from(int8Buffer.buffer)).digest('hex')

  await writeFile(join(OUT_DIR, 'card-ids.json'), JSON.stringify(cardIds))

  const coverage = {
    totalCanonicalCards,
    cardsWithUsableImage: withImage.length,
    cardsIndexed: cardIds.length,
    // Derived, not accumulated (P78, §18) — every current-run card with a usable image that
    // didn't make it into the packed index, whatever the reason (fetch/decode failure this run,
    // or a still-unresolved failure from an earlier resumption). Counts each card at most once,
    // however many times its embedding attempt has been retried across resumptions.
    failures: withImage.length - cardIds.length,
  }
  // Hard-fail BEFORE writing manifest.json (prompt §8): a corrupt/impossible-coverage index must
  // never ship, whether or not verify-index.ts is run afterward as a separate manual step.
  assertValidCoverage(coverage, cardIds.length, cardIds.length)

  const manifest: VisualIndexManifest = {
    version: 'visual-v1',
    modelId: VISUAL_MODEL_REPO,
    modelRevision: VISUAL_MODEL_REVISION,
    modelSha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    embeddingDim: dim,
    quantization: VISUAL_INDEX_QUANTIZATION,
    cardCount: cardIds.length,
    embeddingsSha256,
    generatedAt: new Date().toISOString(),
    coverage,
    sourceProjectRef: deriveProjectIdentity(url),
    sourceEnglishActiveCount: totalCanonicalCards,
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(
    `[index] wrote ${String(cardIds.length)} embeddings (${(int8Buffer.byteLength / 1024).toFixed(1)} KB) ` +
      `to ${OUT_DIR}. Coverage: ${String(cardIds.length)}/${String(totalCanonicalCards)} canonical cards ` +
      `(${((100 * cardIds.length) / Math.max(1, totalCanonicalCards)).toFixed(1)}%). ` +
      `Source project: ${isLocal ? 'LOCAL dev stack' : url}.`,
  )
  if (isLocal) {
    console.warn(
      '[index] WARNING: this index was built from the LOCAL database. Its card ids are LOCAL ' +
        'gen_random_uuid() values and will NOT resolve against any hosted project. Re-run with ' +
        'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY pointed at the hosted project for a real, ' +
        'shippable index — see docs/DECISIONS.md D-097.',
    )
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
