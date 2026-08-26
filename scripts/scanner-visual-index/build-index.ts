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
 * Resumable: writes a checkpoint file after every card; a re-run skips cards already embedded.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
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

interface Checkpoint {
  totalCanonicalCards: number
  cardsWithUsableImage: number
  failures: number
  embeddings: Record<string, number[]>
}

async function loadCheckpoint(): Promise<Checkpoint> {
  if (existsSync(CHECKPOINT_PATH)) {
    return JSON.parse(await readFile(CHECKPOINT_PATH, 'utf-8')) as Checkpoint
  }
  return { totalCanonicalCards: 0, cardsWithUsableImage: 0, failures: 0, embeddings: {} }
}
async function saveCheckpoint(checkpoint: Checkpoint) {
  mkdirSync(dirname(CHECKPOINT_PATH), { recursive: true })
  await writeFile(CHECKPOINT_PATH, JSON.stringify(checkpoint))
}

async function main() {
  const url = process.env.SUPABASE_URL ?? LOCAL_DEFAULTS.url
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_DEFAULTS.serviceRoleKey
  const isLocal = url === LOCAL_DEFAULTS.url
  console.log(`[index] connecting to ${isLocal ? 'LOCAL' : 'a NON-LOCAL'} project at ${url}`)

  const supabase = createClient(url, key)
  const { data: cards, error } = await supabase
    .from('cards')
    .select('id, local_id, name, image_base_url, is_active')
    .eq('language', 'en')
    .eq('is_active', true)
  if (error) throw new Error(`Fetching cards failed: ${error.message}`)

  const totalCanonicalCards = (cards as CardRow[]).length
  const withImage = (cards as CardRow[]).filter((c) => c.image_base_url)
  console.log(
    `[index] ${totalCanonicalCards} active English cards, ${withImage.length} have image_base_url`,
  )

  const checkpoint = await loadCheckpoint()
  checkpoint.totalCanonicalCards = totalCanonicalCards
  checkpoint.cardsWithUsableImage = withImage.length

  await warmUpModel()

  let processed = 0
  for (const card of withImage) {
    if (checkpoint.embeddings[card.id]) continue
    const imageUrl = `${card.image_base_url}/high.webp`
    try {
      const response = await fetch(imageUrl)
      if (!response.ok) throw new Error(`image fetch ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      const raw = await embedImageBuffer(buffer)
      const normalized = l2Normalize(new Float32Array(raw))
      checkpoint.embeddings[card.id] = Array.from(normalized)
    } catch (err) {
      checkpoint.failures += 1
      console.warn(`[index] failed ${card.id} (${card.name}): ${(err as Error).message}`)
    }
    processed += 1
    if (processed % 25 === 0) {
      await saveCheckpoint(checkpoint)
      console.log(`[index] progress: ${processed}/${withImage.length}`)
    }
  }
  await saveCheckpoint(checkpoint)

  const cardIds = Object.keys(checkpoint.embeddings)
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
    coverage: {
      totalCanonicalCards,
      cardsWithUsableImage: withImage.length,
      cardsIndexed: cardIds.length,
      failures: checkpoint.failures,
    },
  }
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(
    `[index] wrote ${cardIds.length} embeddings (${(int8Buffer.byteLength / 1024).toFixed(1)} KB) ` +
      `to ${OUT_DIR}. Coverage: ${cardIds.length}/${totalCanonicalCards} canonical cards ` +
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
