/**
 * Generates the static visual reference index (D-097, prompt §18–§20): one embedding per
 * canonical catalog card, quantized to INT8, packed as manifest.json + card-ids.json +
 * embeddings.bin under a CONTENT-ADDRESSED directory (P87 F-01):
 *   scripts/scanner-visual-index/generated/visual-v1/generations/<contentId>/
 * with `generated/visual-v1/current.json` as the tiny pointer naming the current `contentId`.
 * Those generated files ARE committed (small, binary, no card images — prompt §21) and staged
 * into public/scanner-assets/visual-v1/index/ at build time by stage-index-assets.mjs, exactly
 * like the pinned model files (staged separately, under .../model and .../ort, by
 * prepare-scanner-visual-assets.mjs — those stay content-STABLE per model revision, never
 * content-addressed, since they never change independently of a deliberate model bump).
 *
 * TARGET (P87 F-22): every run must state its intent explicitly via `--target=local` or
 * `--target=hosted` (or the `SCANNER_INDEX_TARGET` env var) — there is no silent default anymore.
 *   --target=hosted requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to already be set in the
 *     environment and refuses to run without them (never falls back to the local demo stack for
 *     what is supposed to be a shippable, hosted-sourced index).
 *   --target=local always uses the local Supabase stack's well-known demo credentials, for
 *     iteration only; its output's `sourceProjectRef` will never match a hosted expectation and is
 *     rejected by the runtime source-project gate (visual-worker.ts) outside DEV builds.
 * Credentials, when `--target=hosted`: read `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the
 * process environment — NEVER `.env.local`, same posture as scripts/portfolio-perf-benchmark.mjs
 * (docs/DEVELOPMENT.md §2). Building the REAL, hosted-scale index requires the owner to run this
 * once with the HOSTED project's service-role key exported in their OWN shell — this script (and
 * this session) never receives or requests that value.
 *
 * FULL-CATALOG KEYSET PAGINATION (P77, hardened P87 F-25): every row is fetched via
 * `drainAllCardPages` (src/domain/scanner/index-pagination.ts) using `WHERE id > lastSeenId ORDER
 * BY id LIMIT pageSize` — stable under concurrent inserts/deletes anywhere in the table, unlike
 * the original OFFSET/`.range()` walk (P77's own fix for PostgREST's silent 1000-row truncation,
 * which itself was not safe against concurrent mutation — see index-pagination.ts's header). An
 * exact COUNT is taken both BEFORE and AFTER the drain (P87 §12): a mismatch means the catalog
 * mutated meaningfully during this run and the build refuses to certify the result, rather than
 * silently shipping a possibly-inconsistent index.
 *
 * Resumable: writes a checkpoint file after every embedded card; a re-run skips cards already
 * embedded — but ONLY when the checkpoint's recorded identity (schema/source project/model/
 * revision/dimension/quantization) matches this run exactly (src/domain/scanner/
 * checkpoint-identity.ts). A mismatched or pre-P77 checkpoint is discarded loudly and rebuilt from
 * scratch — never silently reused across a project/model boundary (the 1224/1000 contamination
 * class). Packing is additionally constrained to the CURRENT fetched canonical id set
 * (defense-in-depth even if identity validation were ever bypassed), and the generator asserts
 * the same coverage invariants verify-index.ts checks before it will write any output.
 *
 * ATOMIC PUBLISH (P87 F-24): the three generation files are written to a `.tmp-<random>` staging
 * directory first, verified with the SAME checks verify-index.ts runs on a committed index, and
 * only then renamed (a single atomic filesystem operation) into their final content-addressed
 * directory. `current.json` is updated LAST, itself via write-temp-then-rename. If the process is
 * killed at any point before that final rename, `current.json` still names the previous valid
 * generation (or is simply absent, on a first-ever build) — never a torn or half-written pointer.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  checkpointMatchesIdentity,
  deriveProjectIdentity,
  freshCheckpoint,
  packCurrentCardIds,
  CHECKPOINT_SCHEMA_VERSION,
  LOCAL_SUPABASE_URL,
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
  type VisualIndexPointer,
} from '../../src/data/scanner/visual-index'
import {
  buildIndexContentPayload,
  truncateDigestHex,
} from '../../src/domain/scanner/index-content-id'
import { embedImageBuffer, warmUpModel } from '../scanner-visual-benchmark/lib/embed.mjs'
import { VISUAL_MODEL_REPO, VISUAL_MODEL_REVISION, VISUAL_EMBEDDING_DIM } from './lib/model-pin.mjs'
import { verifyIndexGeneration } from './verify-index'
import { publishGenerationAtomically, publishPointerAtomically } from './atomic-publish'

const here = dirname(fileURLToPath(import.meta.url))
const VISUAL_V1_DIR = join(here, 'generated', 'visual-v1')
const GENERATIONS_DIR = join(VISUAL_V1_DIR, 'generations')
const CHECKPOINT_PATH = join(here, '.visual-index-cache', 'build-checkpoint.json')

/** Well below PostgREST's 1000-row cap so a single page is never the truncation boundary itself. */
const PAGE_SIZE = 500

const LOCAL_DEFAULTS = {
  url: LOCAL_SUPABASE_URL,
  // Well-known LOCAL demo service-role key, printed by `supabase status` on every machine —
  // not a secret (Supabase's own local-dev fixture), never valid against a hosted project.
  serviceRoleKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
}

type BuildTarget = 'local' | 'hosted'

/** P87 F-22: explicit intent, always — no silent default into either mode. */
function resolveTarget(): BuildTarget {
  const fromArg = process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length)
  const target = fromArg ?? process.env.SCANNER_INDEX_TARGET
  if (target === 'local' || target === 'hosted') return target
  throw new Error(
    'scanner:index:build requires an explicit target: pass --target=local (iterate against the ' +
      'local Supabase stack) or --target=hosted (build the real, shippable index against the ' +
      'hosted project — requires SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY already exported in your ' +
      'shell). There is no default; a silent fallback to the local stack is exactly the P77 ' +
      'contamination-risk pattern this flag closes.',
  )
}

function resolveConnection(target: BuildTarget): { url: string; key: string } {
  if (target === 'local') {
    return { url: LOCAL_DEFAULTS.url, key: LOCAL_DEFAULTS.serviceRoleKey }
  }
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url === undefined || url === '' || key === undefined || key === '') {
    throw new Error(
      '--target=hosted requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to already be set in ' +
        'the environment. Refusing to fall back to the local demo stack for a run declared hosted ' +
        '— export both in your own shell (never committed to .env.local) and re-run.',
    )
  }
  if (url === LOCAL_DEFAULTS.url) {
    throw new Error(
      '--target=hosted but SUPABASE_URL points at the local demo stack (127.0.0.1:54321) — that ' +
        'is not a hosted project. Use --target=local for local iteration instead.',
    )
  }
  return { url, key }
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

async function exactActiveEnglishCount(supabase: SupabaseClient): Promise<number> {
  const countQuery = await supabase
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('language', 'en')
    .eq('is_active', true)
  if (countQuery.error !== null || countQuery.count === null) {
    throw new Error(`Exact count query failed: ${countQuery.error?.message ?? 'no count returned'}`)
  }
  return countQuery.count
}

async function main() {
  const target = resolveTarget()
  const { url, key } = resolveConnection(target)
  console.log(`[index] target=${target}, connecting to ${url}`)

  const supabase = createClient(url, key)

  // Exact count FIRST (prompt §4/§39 HOSTED_ACTIVE_ENGLISH_CARD_COUNT) — the number every page
  // fetched below must reconcile against.
  const exactCountBefore = await exactActiveEnglishCount(supabase)
  console.log(
    `[index] exact count (before drain): ${String(exactCountBefore)} active English cards.`,
  )

  const cards = await drainAllCardPages<CardRow>(
    () => Promise.resolve(exactCountBefore),
    async (afterId, limit): Promise<PageFetchResult<CardRow>> => {
      let query = supabase
        .from('cards')
        .select('id, local_id, name, image_base_url, is_active')
        .eq('language', 'en')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .limit(limit)
      if (afterId !== null) query = query.gt('id', afterId)
      const { data, error } = await query
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

  // P87 §12: a second exact count, taken immediately after the drain completes. This does not
  // provide true snapshot isolation (no single transaction spans the whole paginated walk) but
  // does catch gross mutation of the source catalog while this run was in flight — a sync job or
  // manual edit running concurrently with an hours-long full-catalog embed run must fail this
  // build loudly rather than let it certify a possibly-inconsistent index.
  const exactCountAfter = await exactActiveEnglishCount(supabase)
  if (exactCountAfter !== exactCountBefore) {
    throw new Error(
      `Source catalog mutated during this build: active English card count was ` +
        `${String(exactCountBefore)} at the start and ${String(exactCountAfter)} at the end. ` +
        'Refusing to certify an index built against a moving target — re-run once the catalog is ' +
        'quiet (no concurrent sync/edit).',
    )
  }

  const totalCanonicalCards = cards.length
  const withImage = cards.filter((c) => c.image_base_url !== null && c.image_base_url !== '')
  console.log(
    `[index] ${String(totalCanonicalCards)} active English cards (FULL catalog, keyset-paginated), ` +
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

  const embeddingsBuffer = Buffer.from(
    int8Buffer.buffer,
    int8Buffer.byteOffset,
    int8Buffer.byteLength,
  )
  const embeddingsSha256 = createHash('sha256').update(embeddingsBuffer).digest('hex')
  const cardIdsJson = JSON.stringify(cardIds)

  const coverage = {
    totalCanonicalCards,
    cardsWithUsableImage: withImage.length,
    cardsIndexed: cardIds.length,
    // Derived, not accumulated (P78, §18): every current-run card with a usable image that
    // didn't make it into the packed index, whatever the reason (fetch/decode failure this run,
    // or a still-unresolved failure from an earlier resumption). Counts each card at most once,
    // however many times its embedding attempt has been retried across resumptions.
    failures: withImage.length - cardIds.length,
  }
  // Hard-fail BEFORE writing anything (prompt §8): a corrupt/impossible-coverage index must
  // never ship, whether or not verify-index.ts is run afterward as a separate manual step.
  assertValidCoverage(coverage, cardIds.length, cardIds.length)

  const manifestWithoutContentId: Omit<VisualIndexManifest, 'embeddingsSha256' | 'generatedAt'> & {
    embeddingsSha256: string
    generatedAt: string
  } = {
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

  // P87 F-01: content id derived from the manifest's SEMANTIC fields (excluding generatedAt) plus
  // the raw card-ids/embeddings bytes — see index-content-id.ts's own header for exactly why each
  // of "cardCount alone", "generatedAt alone" and "modelRevision alone" are each insufficient.
  const contentPayload = buildIndexContentPayload(
    manifestWithoutContentId,
    Buffer.from(cardIdsJson, 'utf-8'),
    new Uint8Array(
      embeddingsBuffer.buffer,
      embeddingsBuffer.byteOffset,
      embeddingsBuffer.byteLength,
    ),
  )
  const contentId = truncateDigestHex(
    createHash('sha256').update(Buffer.from(contentPayload)).digest('hex'),
  )
  const manifest: VisualIndexManifest = manifestWithoutContentId

  // Atomic publish (P87 F-24): stage into a temp directory, verify, THEN rename into place — see
  // atomic-publish.ts's own header for the interruption-safety property this achieves, and its
  // dedicated test file for a proof that a simulated interruption never corrupts prior state.
  const { reused } = await publishGenerationAtomically(
    GENERATIONS_DIR,
    contentId,
    {
      'embeddings.bin': embeddingsBuffer,
      'card-ids.json': cardIdsJson,
      'manifest.json': JSON.stringify(manifest, null, 2),
    },
    // Verify the STAGED files with the exact same checks a committed index must pass — a build
    // must fail loudly on a corrupt or contract-mismatched generation, never publish one (F-23).
    (stagedDir) =>
      verifyIndexGeneration(stagedDir, { expectedContentId: contentId }).then(() => {}),
  )
  if (reused) {
    console.log(`[index] generation ${contentId} already published (byte-identical) — reusing it.`)
  }

  // current.json updated LAST: if this process is killed before this point, current.json still
  // names the previous valid generation (or is absent, on a first-ever build) — never a torn
  // pointer (P87 F-24).
  const pointer: VisualIndexPointer = {
    indexVersion: 'visual-v1',
    contentId,
    manifestPath: `generations/${contentId}/manifest.json`,
  }
  await publishPointerAtomically(VISUAL_V1_DIR, JSON.stringify(pointer, null, 2))

  console.log(
    `[index] wrote ${String(cardIds.length)} embeddings (${(int8Buffer.byteLength / 1024).toFixed(1)} KB) ` +
      `as generation ${contentId}. Coverage: ${String(cardIds.length)}/${String(totalCanonicalCards)} canonical ` +
      `cards (${((100 * cardIds.length) / Math.max(1, totalCanonicalCards)).toFixed(1)}%). ` +
      `Source project: ${target === 'local' ? 'LOCAL dev stack' : url}.`,
  )
  if (target === 'local') {
    console.warn(
      '[index] WARNING: this index was built from the LOCAL database. Its card ids are LOCAL ' +
        'gen_random_uuid() values and will NOT resolve against any hosted project, and the runtime ' +
        'source-project gate (visual-worker.ts) will reject it outside a DEV build. Re-run with ' +
        '--target=hosted and SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY pointed at the hosted project ' +
        'for a real, shippable index — see docs/DECISIONS.md D-097.',
    )
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
