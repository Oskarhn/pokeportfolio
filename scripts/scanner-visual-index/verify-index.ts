/**
 * Verifies the generated visual index (prompt §43): manifest/model/dimension/count agreement,
 * checksum, no duplicate ids, finite values, expected quantization range. Run automatically as
 * part of `pnpm scanner:index:verify` and, cheaply, is what stage-index-assets.mjs relies on
 * before copying anything into public/ at build time — a build must fail loudly on a corrupt or
 * contract-mismatched index, never ship one silently (§43/§67).
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeVisualIndex, type VisualIndexManifest } from '../../src/data/scanner/visual-index'
import { VISUAL_MODEL_REPO, VISUAL_MODEL_REVISION, VISUAL_EMBEDDING_DIM } from './lib/model-pin.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const INDEX_DIR = join(here, 'generated', 'visual-v1')

async function main() {
  const manifest = JSON.parse(
    await readFile(join(INDEX_DIR, 'manifest.json'), 'utf-8'),
  ) as VisualIndexManifest
  const cardIds = JSON.parse(await readFile(join(INDEX_DIR, 'card-ids.json'), 'utf-8')) as string[]
  const embeddingsBuffer = await readFile(join(INDEX_DIR, 'embeddings.bin'))
  const embeddingsBytes = new Int8Array(
    embeddingsBuffer.buffer,
    embeddingsBuffer.byteOffset,
    embeddingsBuffer.byteLength,
  )

  const actualChecksum = createHash('sha256').update(embeddingsBuffer).digest('hex')
  if (actualChecksum !== manifest.embeddingsSha256) {
    throw new Error(
      `embeddings.bin checksum mismatch: manifest says ${manifest.embeddingsSha256}, actual ${actualChecksum}`,
    )
  }

  if (manifest.modelId !== VISUAL_MODEL_REPO) {
    throw new Error(
      `Model id mismatch: index built with ${manifest.modelId}, expected ${VISUAL_MODEL_REPO}`,
    )
  }
  if (manifest.modelRevision !== VISUAL_MODEL_REVISION) {
    throw new Error(
      `Model revision mismatch: index built with ${manifest.modelRevision}, expected ${VISUAL_MODEL_REVISION}`,
    )
  }
  if (manifest.embeddingDim !== VISUAL_EMBEDDING_DIM) {
    throw new Error(
      `Embedding dim mismatch: index has ${manifest.embeddingDim}, expected ${VISUAL_EMBEDDING_DIM}`,
    )
  }

  // decodeVisualIndex already asserts: quantization contract, card count vs. buffer length
  // agreement, no duplicate ids, every value finite.
  const decoded = decodeVisualIndex(manifest, cardIds, embeddingsBytes)

  let outOfRange = 0
  for (const value of decoded.embeddings) {
    if (value < -1.01 || value > 1.01) outOfRange += 1
  }
  if (outOfRange > 0) {
    throw new Error(`${outOfRange} dequantized values fall outside the expected [-1,1] range.`)
  }

  console.log(
    `[verify] OK — ${decoded.cardIds.length} cards, dim ${manifest.embeddingDim}, ` +
      `${manifest.quantization}, checksum verified, no duplicates, all finite, in-range.`,
  )
  console.log(
    `[verify] coverage: ${manifest.coverage.cardsIndexed}/${manifest.coverage.totalCanonicalCards} ` +
      `canonical cards (${manifest.coverage.failures} failures).`,
  )
}

main().catch((error: unknown) => {
  console.error('[verify] FAILED:', error instanceof Error ? error.message : error)
  process.exit(1)
})
