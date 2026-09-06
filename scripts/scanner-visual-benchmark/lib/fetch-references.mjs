// Downloads a diverse REAL reference corpus from TCGdex (prompt §11/§12) into a gitignored cache.
// Nothing here is committed: docs/API_SOURCES.md's position on card artwork applies (hotlink/
// cache for our own use, never redistribute) — the cache exists only so this machine's benchmark
// run doesn't re-fetch the same images every invocation.
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BENCHMARK_SETS, REPRINT_SET } from './reference-sets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const CACHE_DIR = join(here, '..', '.benchmark-cache')
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
 * Builds the reference corpus: one row per card { cardId, name, localId, setId, setName,
 * language, imagePath }. Bounded concurrency (5) so TCGdex is not hammered (API_SOURCES.md: "no
 * published hard rate limits, but please be considerate").
 */
export async function buildCorpus({ maxPerSet = 999, concurrency = 6 } = {}) {
  await mkdir(IMAGES_DIR, { recursive: true })
  if (existsSync(CORPUS_MANIFEST)) {
    return JSON.parse(await readFile(CORPUS_MANIFEST, 'utf-8'))
  }

  const allSets = [...BENCHMARK_SETS, REPRINT_SET]
  const rows = []
  for (const set of allSets) {
    const detail = await fetchJson(`https://api.tcgdex.net/v2/en/sets/${set.id}`)
    const cards = detail.cards.slice(0, maxPerSet)
    for (const card of cards) {
      if (!card.image) continue
      rows.push({
        cardId: card.id,
        name: card.name,
        localId: card.localId,
        setId: set.id,
        setName: set.name,
        language: set.lang,
        imageUrl: `${card.image}/high.webp`,
        imagePath: join(IMAGES_DIR, `${card.id}.webp`),
      })
    }
  }

  console.log(`fetch-references: ${rows.length} candidate cards across ${allSets.length} sets`)

  let cursor = 0
  let ok = 0
  let failed = 0
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor
      cursor += 1
      const row = rows[index]
      const success = await downloadImage(row.imageUrl, row.imagePath).catch(() => false)
      if (success) ok += 1
      else failed += 1
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  console.log(`fetch-references: downloaded ${ok}, failed ${failed}`)

  const usable = rows.filter((row) => existsSync(row.imagePath))
  await writeFile(CORPUS_MANIFEST, JSON.stringify(usable, null, 2))
  return usable
}
