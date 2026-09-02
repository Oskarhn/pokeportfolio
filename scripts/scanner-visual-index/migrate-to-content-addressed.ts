/**
 * ONE-TIME migration (P87 §20): repackages the already-committed, already-valid pre-P87 flat
 * index (`generated/visual-v1/{manifest.json,card-ids.json,embeddings.bin}`) under the new
 * content-addressed layout (`generated/visual-v1/current.json` +
 * `generated/visual-v1/generations/<contentId>/...`) — WITHOUT recomputing a single DINO
 * embedding or touching the database. The content id is calculated locally from the already-
 * committed bytes (index-content-id.ts), exactly the same function `build-index.ts` uses for a
 * fresh build, so a repackaged generation and a from-scratch rebuild of byte-identical content
 * would land on the identical content id.
 *
 * Run once, by hand: `pnpm exec tsx scripts/scanner-visual-index/migrate-to-content-addressed.ts`.
 * Not part of any script/CI path — this file is deliberately temporary infrastructure for the one
 * historical index this project has today; a future `pnpm scanner:index:build` run always
 * produces the new layout directly and never needs this script again.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishGenerationAtomically, publishPointerAtomically } from './atomic-publish'
import { verifyIndexGeneration } from './verify-index'
import {
  buildIndexContentPayload,
  truncateDigestHex,
} from '../../src/domain/scanner/index-content-id'
import type { VisualIndexManifest } from '../../src/data/scanner/visual-index'

const here = dirname(fileURLToPath(import.meta.url))
const VISUAL_V1_DIR = join(here, 'generated', 'visual-v1')
const GENERATIONS_DIR = join(VISUAL_V1_DIR, 'generations')

async function main() {
  const oldManifestPath = join(VISUAL_V1_DIR, 'manifest.json')
  if (!existsSync(oldManifestPath)) {
    console.log('[migrate] no pre-P87 flat manifest.json found — nothing to migrate.')
    return
  }
  const manifestJson = readFileSync(oldManifestPath, 'utf-8')
  const cardIdsJson = readFileSync(join(VISUAL_V1_DIR, 'card-ids.json'), 'utf-8')
  const embeddingsBuffer = readFileSync(join(VISUAL_V1_DIR, 'embeddings.bin'))

  // Content id computed up front, exactly like build-index.ts does, from the already-committed
  // bytes — no re-embedding, no database, no model.
  const manifest = JSON.parse(manifestJson) as VisualIndexManifest
  const payload = buildIndexContentPayload(
    manifest,
    Buffer.from(cardIdsJson, 'utf-8'),
    new Uint8Array(
      embeddingsBuffer.buffer,
      embeddingsBuffer.byteOffset,
      embeddingsBuffer.byteLength,
    ),
  )
  const contentId = truncateDigestHex(
    createHash('sha256').update(Buffer.from(payload)).digest('hex'),
  )

  console.log(
    `[migrate] repackaging existing index as generation ${contentId} (no re-embedding)...`,
  )
  const { reused } = await publishGenerationAtomically(
    GENERATIONS_DIR,
    contentId,
    {
      'embeddings.bin': embeddingsBuffer,
      'card-ids.json': cardIdsJson,
      'manifest.json': manifestJson,
    },
    (dir) => verifyIndexGeneration(dir, { expectedContentId: contentId }).then(() => {}),
  )
  console.log(reused ? '[migrate] generation already present.' : '[migrate] generation published.')

  await publishPointerAtomically(
    VISUAL_V1_DIR,
    JSON.stringify(
      {
        indexVersion: 'visual-v1',
        contentId,
        manifestPath: `generations/${contentId}/manifest.json`,
      },
      null,
      2,
    ),
  )
  console.log(`[migrate] current.json now points at ${contentId}.`)

  // The old flat files are superseded — remove them so nothing ever reads them by accident.
  rmSync(oldManifestPath)
  rmSync(join(VISUAL_V1_DIR, 'card-ids.json'))
  rmSync(join(VISUAL_V1_DIR, 'embeddings.bin'))
  console.log('[migrate] old flat manifest.json/card-ids.json/embeddings.bin removed.')
}

main().catch((error: unknown) => {
  console.error('[migrate] FAILED:', error instanceof Error ? error.message : error)
  process.exit(1)
})
