/**
 * Verifies one visual-index GENERATION directory (P87 restructure of the P77 verifier): manifest/
 * model/dimension agreement, checksum, no duplicate ids, finite values, expected quantization
 * range, coverage invariants (P77, prompt §8 — the original verifier accepted a manifest claiming
 * 1224/1000 (122.4%) coverage because it never checked coverage arithmetic at all), and (P87 F-01)
 * that the directory's own content id matches what its content actually hashes to.
 *
 * `verifyIndexGeneration` is the load-bearing export: stage-index-assets.mjs now calls it directly
 * before copying anything into public/ (P87 F-23 — this file's checks used to run ONLY when a
 * developer remembered `pnpm scanner:index:verify` by hand; `stage-index-assets.mjs`'s own body
 * was a plain `copyFileSync` with no verification at all, so a corrupt or truncated index could be
 * committed, staged, built and deployed with every gate green). The CLI entry point at the bottom
 * (`pnpm scanner:index:verify`) is now a thin wrapper over the same function, for manual/local use.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertValidCoverage, logCoverageBreakdown } from '../../src/domain/scanner/index-coverage'
import { decodeVisualIndex, type VisualIndexManifest } from '../../src/data/scanner/visual-index'
import {
  buildIndexContentPayload,
  truncateDigestHex,
  isWellFormedContentId,
} from '../../src/domain/scanner/index-content-id'
import { VISUAL_MODEL_REPO, VISUAL_MODEL_REVISION, VISUAL_EMBEDDING_DIM } from './lib/model-pin.mjs'

export interface VerifyIndexOptions {
  /**
   * The content id this generation is EXPECTED to be published under (its own directory name) —
   * checked against a fresh hash of the actual content, so a manifest/card-ids/embeddings trio
   * copied into the wrong directory (or a directory renamed by hand) is caught even though each
   * individual file's own internal checksum still passes.
   */
  readonly expectedContentId?: string
  /**
   * When provided, `manifest.sourceProjectRef` must equal this exactly or verification fails
   * (P87 F-22 — previously this field was logged/warned on but never gated). Deliberately NOT
   * read from `VITE_SUPABASE_URL` automatically here: that variable is set to a placeholder in CI
   * (`build-and-test`'s `pnpm build` step) and would make ordinary CI runs fail against the real
   * committed hosted index. Pass this explicitly (`SCANNER_INDEX_EXPECTED_SOURCE_REF` in the CLI
   * wrapper below) only when there is a genuine expectation to enforce.
   */
  readonly expectedSourceProjectRef?: string
}

export interface VerifyIndexResult {
  readonly manifest: VisualIndexManifest
  readonly cardIds: readonly string[]
  readonly actualContentId: string
}

export async function verifyIndexGeneration(
  dir: string,
  options: VerifyIndexOptions = {},
): Promise<VerifyIndexResult> {
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf-8'),
  ) as VisualIndexManifest
  const cardIdsRaw = await readFile(join(dir, 'card-ids.json'), 'utf-8')
  const cardIds = JSON.parse(cardIdsRaw) as string[]
  const embeddingsBuffer = await readFile(join(dir, 'embeddings.bin'))
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

  // P97 (D-106): NOT pinned to today's PROTOTYPES_PER_CARD/STRATEGY — this generation may legitimately
  // be either the v1 (single-prototype, prototypesPerCard undefined) format every already-committed
  // generation uses, or the dual-prototype format. verify-index.ts's job is "is this generation
  // internally valid", not "is this exactly the newest format" — decodeVisualIndex below (the one
  // shared implementation) already enforces the actual invariants: prototypesPerCard must be a
  // positive integer, prototypeStrategy/prototypeStrategyVersion must both be present whenever it
  // is > 1, and the embeddings/rowCount byte lengths must agree with it exactly.

  // decodeVisualIndex already asserts: quantization contract, card count/prototype-count vs.
  // buffer length agreement, rowCount cross-check, no duplicate ids, every value finite.
  const decoded = decodeVisualIndex(manifest, cardIds, embeddingsBytes)

  // Coverage invariants (P77, prompt §8): cardsIndexed can never exceed totalCanonicalCards or
  // cardsWithUsableImage, and the id-list/manifest/coverage counts must all agree with each
  // other — the SAME shared check the generator runs before writing (index-coverage.ts), so a
  // committed index can never silently drift out of the rule the generator itself enforces.
  assertValidCoverage(manifest.coverage, cardIds.length, manifest.cardCount)

  // P87 F-01: the directory's own name must equal what its content actually hashes to — catches a
  // manifest/card-ids/embeddings trio staged into (or renamed into) the wrong content-addressed
  // path, which per-file checksums alone cannot detect.
  const contentPayload = buildIndexContentPayload(
    manifest,
    Buffer.from(cardIdsRaw, 'utf-8'),
    new Uint8Array(
      embeddingsBuffer.buffer,
      embeddingsBuffer.byteOffset,
      embeddingsBuffer.byteLength,
    ),
  )
  const actualContentId = truncateDigestHex(
    createHash('sha256').update(Buffer.from(contentPayload)).digest('hex'),
  )
  if (options.expectedContentId !== undefined && actualContentId !== options.expectedContentId) {
    throw new Error(
      `Content id mismatch: directory is published as ${options.expectedContentId}, but its ` +
        `content actually hashes to ${actualContentId}. This generation was moved, renamed, or ` +
        'its files were edited after publishing — refusing to trust it.',
    )
  }

  // P87 F-22: source-project identity is now an enforceable gate, not just a logged field, when
  // the caller has configured an expectation.
  if (options.expectedSourceProjectRef !== undefined) {
    if (manifest.sourceProjectRef !== options.expectedSourceProjectRef) {
      throw new Error(
        `Source project mismatch: index was built against "${String(manifest.sourceProjectRef)}", ` +
          `expected "${options.expectedSourceProjectRef}". Refusing to ship an index built against ` +
          'the wrong Supabase project — its card ids would not resolve against the real catalog.',
      )
    }
  } else if (manifest.sourceProjectRef !== undefined) {
    console.log(
      `[verify] source project: ${manifest.sourceProjectRef} (${String(manifest.sourceEnglishActiveCount ?? '?')} active English cards there at build time) — no expected ref configured, not gated.`,
    )
  } else {
    console.warn(
      '[verify] manifest predates source-identity tracking (P77) — cannot confirm which project this index was built against.',
    )
  }

  let outOfRange = 0
  for (const value of decoded.embeddings) {
    if (value < -1.01 || value > 1.01) outOfRange += 1
  }
  if (outOfRange > 0) {
    throw new Error(`${outOfRange} dequantized values fall outside the expected [-1,1] range.`)
  }

  console.log(
    `[verify] OK — ${decoded.cardIds.length} cards, dim ${manifest.embeddingDim}, ` +
      `${manifest.quantization}, checksum verified, content id ${actualContentId}, no duplicates, all finite, in-range.`,
  )
  console.log(
    `[verify] INDEX_SCHEMA_VERSION=${String(manifest.schemaVersion ?? 1)} ` +
      `INDEX_PAYLOAD_FORMAT=${decoded.schemaLabel} ` +
      `INDEX_PROTOTYPES_PER_CARD=${String(decoded.prototypesPerCard)} ` +
      `INDEX_PROTOTYPE_STRATEGY=${manifest.prototypeStrategy ?? '(v1 pristine-only)'} ` +
      `INDEX_ROW_COUNT=${String(decoded.cardIds.length * decoded.prototypesPerCard)}`,
  )
  logCoverageBreakdown(manifest.coverage)

  return { manifest, cardIds, actualContentId }
}

/** Reads `current.json` under `visualV1Dir` and verifies the generation it points at. Used by
 *  both the CLI entry point below and stage-index-assets.mjs. */
export async function verifyCurrentGeneration(
  visualV1Dir: string,
  options: VerifyIndexOptions = {},
): Promise<VerifyIndexResult> {
  const pointerRaw = await readFile(join(visualV1Dir, 'current.json'), 'utf-8')
  const pointer = JSON.parse(pointerRaw) as { indexVersion?: string; contentId?: string }
  if (!isWellFormedContentId(pointer.contentId)) {
    throw new Error(
      `current.json's contentId is not a well-formed content id: ${String(pointer.contentId)}`,
    )
  }
  const generationDir = join(visualV1Dir, 'generations', pointer.contentId)
  return verifyIndexGeneration(generationDir, {
    ...options,
    expectedContentId: pointer.contentId,
  })
}

// ---------------------------------------------------------------------------------------------
// CLI entry point — `pnpm scanner:index:verify`. Only runs when this module is the process's own
// entry point (not when imported by stage-index-assets.mjs or build-index.ts), matching Node's
// standard "is this the main module" pattern for an ESM/tsx script.
// ---------------------------------------------------------------------------------------------
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMainModule) {
  const visualV1Dir = join(here, 'generated', 'visual-v1')
  const expectedSourceProjectRef = process.env.SCANNER_INDEX_EXPECTED_SOURCE_REF
  verifyCurrentGeneration(visualV1Dir, {
    expectedSourceProjectRef:
      expectedSourceProjectRef !== undefined && expectedSourceProjectRef !== ''
        ? expectedSourceProjectRef
        : undefined,
  }).catch((error: unknown) => {
    console.error('[verify] FAILED:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
