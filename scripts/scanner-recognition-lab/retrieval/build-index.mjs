// Embeds the FULL P91 reference corpus once (CLS token, production-equivalent — see embedding/
// embed.mjs) and caches it to disk so every downstream experiment searches against the same real
// ~4,300-card index instead of re-embedding references per experiment. This is the "reference
// index" every retrieval/confusable/threshold experiment in this lab loads and searches.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  embedImageBuffer,
  warmUpModel,
  VISUAL_MODEL_ID,
  VISUAL_MODEL_REVISION,
} from '../embedding/embed.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(here, '..', '.cache')
const CORPUS_MANIFEST = join(CACHE_DIR, 'corpus.json')
export const INDEX_PATH = join(CACHE_DIR, 'reference-index-cls.json')

export async function loadCorpus() {
  return JSON.parse(await readFile(CORPUS_MANIFEST, 'utf-8'))
}

/** Builds (or loads a cached) { cardId -> Float32Array(384) } reference index for the full
 *  corpus. Returns { rows, vectors: Map<cardId, Float32Array> }. */
export async function buildReferenceIndex({ force = false, limit = null } = {}) {
  const corpus = await loadCorpus()
  const rows = limit ? corpus.slice(0, limit) : corpus

  if (!force && existsSync(INDEX_PATH) && !limit) {
    const cached = JSON.parse(await readFile(INDEX_PATH, 'utf-8'))
    if (cached.cardIds.length === rows.length) {
      const vectors = new Map()
      for (let i = 0; i < cached.cardIds.length; i += 1) {
        vectors.set(cached.cardIds[i], Float32Array.from(cached.vectors[i]))
      }
      return { rows, vectors, model: cached.model }
    }
  }

  await warmUpModel()
  const vectors = new Map()
  let done = 0
  for (const row of rows) {
    const buf = await readFile(row.imagePath)
    const vec = await embedImageBuffer(buf)
    vectors.set(row.cardId, vec)
    done += 1
    if (done % 500 === 0) console.log(`[index] embedded ${done}/${rows.length}`)
  }

  if (!limit) {
    await mkdir(CACHE_DIR, { recursive: true })
    const cardIds = rows.map((r) => r.cardId)
    const payload = {
      model: {
        id: VISUAL_MODEL_ID,
        revision: VISUAL_MODEL_REVISION,
        dim: 384,
        dtype: 'q8',
        representation: 'CLS',
      },
      cardIds,
      vectors: cardIds.map((id) => Array.from(vectors.get(id))),
    }
    await writeFile(INDEX_PATH, JSON.stringify(payload))
    console.log(`[index] wrote ${INDEX_PATH} (${cardIds.length} cards)`)
  }

  return {
    rows,
    vectors,
    model: { id: VISUAL_MODEL_ID, revision: VISUAL_MODEL_REVISION, dim: 384 },
  }
}

/** Brute-force cosine (dot product; vectors are pre-L2-normalized) search over a Map<cardId,
 *  Float32Array> index. Returns hits sorted descending by similarity. */
export function searchIndex(queryVec, vectors, { excludeCardId = null } = {}) {
  const hits = []
  for (const [cardId, refVec] of vectors) {
    if (cardId === excludeCardId) continue
    let dot = 0
    for (let i = 0; i < refVec.length; i += 1) dot += refVec[i] * queryVec[i]
    hits.push({ cardId, similarity: dot })
  }
  hits.sort((a, b) => b.similarity - a.similarity)
  return hits
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force')
  const { rows, vectors } = await buildReferenceIndex({ force })
  console.log(`[index] DONE: ${vectors.size} reference vectors for ${rows.length} cards`)
}
