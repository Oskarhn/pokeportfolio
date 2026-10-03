#!/usr/bin/env node
/**
 * LOCAL-ONLY evidence helper (P184): composes photo-like JPEGs (card on a table background,
 * 1200x1600) from card images that an EARLIER phase already cached on this machine
 * (scripts/scanner-recognition-lab/.cache/images, gitignored). The output goes to
 * <repo>/.p184-scratch/real-art (gitignored) and is NEVER committed or copied into a document: it
 * exists so the device run can show real card artwork going through the real on-device pipeline.
 * Nothing is downloaded.
 *
 *   node scripts/p184/make-real-art-photos.mjs <cacheImagesDir> base1-1 base1-4 ...
 */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const sharp = createRequire(join(repoRoot, 'package.json'))('sharp')
const [cacheDir, ...ids] = process.argv.slice(2)
if (cacheDir === undefined || ids.length === 0) throw new Error('usage: <cacheImagesDir> <id>...')
const outDir = join(repoRoot, '.p184-scratch', 'real-art')
mkdirSync(outDir, { recursive: true })

const W = 1200
const H = 1600
const table = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="0.3" cy="0.2" r="0.9"><stop offset="0" stop-color="#5a4530"/><stop offset="1" stop-color="#2b2118"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`,
)
for (const id of ids) {
  const card = await sharp(join(cacheDir, `${id}.webp`))
    .resize({ height: 1500 })
    .toBuffer()
  const meta = await sharp(card).metadata()
  const left = Math.round((W - (meta.width ?? 1000)) / 2)
  await sharp(table)
    .composite([{ input: card, left, top: 50 }])
    .jpeg({ quality: 90 })
    .toFile(join(outDir, `real-${id}.jpg`))
  console.log(`wrote real-${id}.jpg`)
}
