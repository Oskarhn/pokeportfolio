// P95 §6: art-crop reference index, the missing piece that made P91's own art-crop experiment
// (07-art-crop-confusable.mjs) inconclusive by construction — that experiment only ever compared a
// CLEAN query against the reference's own art crop (a ceiling-effect tautology). This module builds
// (and disk-caches, same convention as retrieval/build-index.mjs) one art-crop embedding per corpus
// card so a DISTORTED query can be compared against art crops properly.
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
import { artCrop } from '../quality/art-crop.mjs'
import { loadCorpus } from './build-index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(here, '..', '.cache')
export const ART_CROP_INDEX_PATH = join(CACHE_DIR, 'reference-index-artcrop.json')

export async function buildArtCropIndex({ force = false } = {}) {
  const rows = await loadCorpus()

  if (!force && existsSync(ART_CROP_INDEX_PATH)) {
    const cached = JSON.parse(await readFile(ART_CROP_INDEX_PATH, 'utf-8'))
    if (cached.cardIds.length === rows.length) {
      const vectors = new Map()
      for (let i = 0; i < cached.cardIds.length; i += 1) {
        vectors.set(cached.cardIds[i], Float32Array.from(cached.vectors[i]))
      }
      return { rows, vectors }
    }
  }

  await warmUpModel()
  const vectors = new Map()
  let done = 0
  for (const row of rows) {
    const buf = await readFile(row.imagePath)
    const cropped = await artCrop(buf)
    const vec = await embedImageBuffer(cropped)
    vectors.set(row.cardId, vec)
    done += 1
    if (done % 500 === 0) console.log(`[art-crop-index] embedded ${done}/${rows.length}`)
  }

  await mkdir(CACHE_DIR, { recursive: true })
  const cardIds = rows.map((r) => r.cardId)
  await writeFile(
    ART_CROP_INDEX_PATH,
    JSON.stringify({
      model: {
        id: VISUAL_MODEL_ID,
        revision: VISUAL_MODEL_REVISION,
        dim: 384,
        crop: 'quality/art-crop.mjs',
      },
      cardIds,
      vectors: cardIds.map((id) => Array.from(vectors.get(id))),
    }),
  )
  console.log(`[art-crop-index] wrote ${ART_CROP_INDEX_PATH} (${cardIds.length} cards)`)
  return { rows, vectors }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force')
  const { vectors } = await buildArtCropIndex({ force })
  console.log(`[art-crop-index] DONE: ${vectors.size} art-crop reference vectors`)
}
