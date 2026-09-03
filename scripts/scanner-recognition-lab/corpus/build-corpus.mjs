// Downloads the P91 real reference corpus from TCGdex's public API into a gitignored cache
// (scripts/scanner-recognition-lab/.cache/). Same politeness discipline as the pre-existing P76
// benchmark tooling (bounded concurrency, cache-and-reuse, never redistribute artwork — see
// docs/API_SOURCES.md).
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CORPUS_SETS } from './sets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = join(here, '..', '.cache')
export const IMAGES_DIR = join(CACHE_DIR, 'images')
export const CORPUS_MANIFEST = join(CACHE_DIR, 'corpus.json')

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)
  return response.json()
}

async function downloadImage(url, destPath) {
  if (existsSync(destPath)) return true
  const response = await fetch(url)
  if (!response.ok) return false
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(destPath, buffer)
  return true
}

/**
 * Builds the P91 reference corpus: one row per card { cardId, name, localId, setId, setName,
 * language, imageUrl, imagePath }. Reuses a manifest if one already exists (idempotent re-run).
 * Pass `force: true` to re-fetch the set listings (still skips already-downloaded image files).
 */
export async function buildCorpus({ sets = CORPUS_SETS, concurrency = 8, force = false } = {}) {
  await mkdir(IMAGES_DIR, { recursive: true })
  if (existsSync(CORPUS_MANIFEST) && !force) {
    return JSON.parse(await readFile(CORPUS_MANIFEST, 'utf-8'))
  }

  const rows = []
  const perSetCounts = []
  for (const set of sets) {
    let detail
    try {
      detail = await fetchJson(`https://api.tcgdex.net/v2/en/sets/${set.id}`)
    } catch (error) {
      console.error(`[corpus] failed to fetch set ${set.id}: ${error.message}`)
      continue
    }
    let count = 0
    for (const card of detail.cards) {
      if (!card.image) continue
      rows.push({
        cardId: card.id,
        name: card.name,
        localId: card.localId,
        setId: set.id,
        setName: set.name,
        language: 'en',
        imageUrl: `${card.image}/high.webp`,
        imagePath: join(IMAGES_DIR, `${card.id}.webp`),
      })
      count += 1
    }
    perSetCounts.push({ setId: set.id, name: set.name, count })
    console.log(`[corpus] ${set.id} (${set.name}): ${count} cards`)
  }

  console.log(`[corpus] ${rows.length} candidate cards across ${sets.length} sets`)

  let cursor = 0
  let ok = 0
  let failed = 0
  let skipped = 0
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor
      cursor += 1
      const row = rows[index]
      const alreadyThere = existsSync(row.imagePath)
      const success = await downloadImage(row.imageUrl, row.imagePath).catch(() => false)
      if (success) {
        if (alreadyThere) skipped += 1
        else ok += 1
      } else failed += 1
      if ((ok + failed) % 250 === 0 && ok + failed > 0) {
        console.log(
          `[corpus] progress: downloaded=${ok} skipped=${skipped} failed=${failed} of ${rows.length}`,
        )
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  console.log(`[corpus] downloaded ${ok}, reused-cached ${skipped}, failed ${failed}`)

  const usable = rows.filter((row) => existsSync(row.imagePath))
  await writeFile(CORPUS_MANIFEST, JSON.stringify(usable, null, 2))
  await writeFile(
    join(CACHE_DIR, 'corpus-per-set-counts.json'),
    JSON.stringify(perSetCounts, null, 2),
  )
  return usable
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force')
  const rows = await buildCorpus({ force })
  console.log(`[corpus] DONE: ${rows.length} usable cards`)
}
