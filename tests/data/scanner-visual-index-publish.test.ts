/**
 * Visual-index publishing pipeline (P87): atomic publish (F-24, including simulated
 * interruption), build-load-bearing verification (F-23), and deliberate corruption rejection
 * (§19) — exercised against REAL temp directories on disk, not mocked filesystem calls, so a
 * Node/Windows-specific rename-atomicity assumption would actually be caught here.
 */
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  publishGenerationAtomically,
  publishPointerAtomically,
  type GenerationFiles,
} from '../../scripts/scanner-visual-index/atomic-publish'
import {
  verifyIndexGeneration,
  verifyCurrentGeneration,
} from '../../scripts/scanner-visual-index/verify-index'
import {
  buildIndexContentPayload,
  truncateDigestHex,
} from '../../src/domain/scanner/index-content-id'
import {
  quantizeEmbedding,
  l2Normalize,
  type VisualIndexManifest,
} from '../../src/data/scanner/visual-index'
import {
  VISUAL_MODEL_REPO,
  VISUAL_MODEL_REVISION,
  VISUAL_EMBEDDING_DIM,
} from '../../scripts/scanner-visual-index/lib/model-pin.mjs'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'p87-index-publish-'))
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** Builds a real, internally-consistent, verify-passing generation trio + its correct content id. */
function buildValidGeneration(
  overrides: {
    cardIds?: string[]
    sourceProjectRef?: string
  } = {},
): { files: GenerationFiles; contentId: string; manifest: VisualIndexManifest } {
  const cardIds = overrides.cardIds ?? ['card-a', 'card-b']
  const dim = VISUAL_EMBEDDING_DIM
  const vectors = cardIds.map((_, i) => {
    const v = new Float32Array(dim)
    v[i % dim] = 1
    return l2Normalize(v)
  })
  const int8Buffer = new Int8Array(cardIds.length * dim)
  vectors.forEach((v, row) => {
    int8Buffer.set(quantizeEmbedding(v), row * dim)
  })
  const embeddingsBuffer = Buffer.from(
    int8Buffer.buffer,
    int8Buffer.byteOffset,
    int8Buffer.byteLength,
  )
  const embeddingsSha256 = createHash('sha256').update(embeddingsBuffer).digest('hex')
  const cardIdsJson = JSON.stringify(cardIds)

  const manifestWithoutContentId: VisualIndexManifest = {
    version: 'visual-v1',
    modelId: VISUAL_MODEL_REPO,
    modelRevision: VISUAL_MODEL_REVISION,
    modelSha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    embeddingDim: dim,
    quantization: 'int8',
    cardCount: cardIds.length,
    embeddingsSha256,
    generatedAt: '2026-09-01T00:00:00.000Z',
    coverage: {
      totalCanonicalCards: cardIds.length,
      cardsWithUsableImage: cardIds.length,
      cardsIndexed: cardIds.length,
      failures: 0,
    },
    sourceProjectRef: overrides.sourceProjectRef ?? 'nopmkroeygmlvndzjjqs.supabase.co',
    sourceEnglishActiveCount: cardIds.length,
  }
  const payload = buildIndexContentPayload(
    manifestWithoutContentId,
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

  return {
    contentId,
    manifest: manifestWithoutContentId,
    files: {
      'embeddings.bin': embeddingsBuffer,
      'card-ids.json': cardIdsJson,
      'manifest.json': JSON.stringify(manifestWithoutContentId, null, 2),
    },
  }
}

describe('publishGenerationAtomically (P87 F-24)', () => {
  it('publishes a verified generation into generations/<contentId>/', async () => {
    const generationsDir = join(workDir, 'generations')
    const { files, contentId } = buildValidGeneration()
    const { reused } = await publishGenerationAtomically(generationsDir, contentId, files, (dir) =>
      verifyIndexGeneration(dir, { expectedContentId: contentId }).then(() => {}),
    )
    expect(reused).toBe(false)
    const finalDir = join(generationsDir, contentId)
    expect(existsSync(join(finalDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(finalDir, 'card-ids.json'))).toBe(true)
    expect(existsSync(join(finalDir, 'embeddings.bin'))).toBe(true)
    // No leftover temp directories after a successful publish.
    expect(readdirSync(generationsDir).filter((n) => n.startsWith('.tmp-'))).toHaveLength(0)
  })

  it('republishing byte-identical content is idempotent (reused=true), never errors or duplicates', async () => {
    const generationsDir = join(workDir, 'generations')
    const { files, contentId } = buildValidGeneration()
    const verify = (dir: string) =>
      verifyIndexGeneration(dir, { expectedContentId: contentId }).then(() => {})
    await publishGenerationAtomically(generationsDir, contentId, files, verify)
    const second = await publishGenerationAtomically(generationsDir, contentId, files, verify)
    expect(second.reused).toBe(true)
    expect(readdirSync(join(generationsDir, contentId)).sort()).toEqual(
      ['card-ids.json', 'embeddings.bin', 'manifest.json'].sort(),
    )
  })

  it('SIMULATED INTERRUPTION: a verify() that throws leaves NO final directory and cleans up the temp staging directory', async () => {
    const generationsDir = join(workDir, 'generations')
    const { files, contentId } = buildValidGeneration()
    await expect(
      publishGenerationAtomically(generationsDir, contentId, files, () => {
        throw new Error('simulated kill mid-verification')
      }),
    ).rejects.toThrow('simulated kill mid-verification')
    expect(existsSync(join(generationsDir, contentId))).toBe(false)
    const leftovers = existsSync(generationsDir)
      ? readdirSync(generationsDir).filter((n) => n.startsWith('.tmp-'))
      : []
    expect(leftovers).toHaveLength(0)
  })

  it('a prior successful publish is untouched by a LATER interrupted publish of a different generation', async () => {
    const generationsDir = join(workDir, 'generations')
    const genA = buildValidGeneration({ cardIds: ['card-a', 'card-b'] })
    const verifyA = (dir: string) =>
      verifyIndexGeneration(dir, { expectedContentId: genA.contentId }).then(() => {})
    await publishGenerationAtomically(generationsDir, genA.contentId, genA.files, verifyA)
    const aManifestBefore = readFileSync(
      join(generationsDir, genA.contentId, 'manifest.json'),
      'utf-8',
    )

    const genB = buildValidGeneration({ cardIds: ['card-c', 'card-d', 'card-e'] })
    await expect(
      publishGenerationAtomically(generationsDir, genB.contentId, genB.files, () => {
        throw new Error('simulated kill for generation B')
      }),
    ).rejects.toThrow()

    // Generation A, published earlier, is completely unaffected by B's failed publish attempt.
    expect(readFileSync(join(generationsDir, genA.contentId, 'manifest.json'), 'utf-8')).toBe(
      aManifestBefore,
    )
    expect(existsSync(join(generationsDir, genB.contentId))).toBe(false)
  })
})

describe('publishPointerAtomically + verifyCurrentGeneration (P87 F-24)', () => {
  it('a pointer published AFTER its generation resolves correctly end-to-end', async () => {
    const visualV1Dir = workDir
    const generationsDir = join(visualV1Dir, 'generations')
    const { files, contentId } = buildValidGeneration()
    await publishGenerationAtomically(generationsDir, contentId, files, (dir) =>
      verifyIndexGeneration(dir, { expectedContentId: contentId }).then(() => {}),
    )
    await publishPointerAtomically(
      visualV1Dir,
      JSON.stringify({
        indexVersion: 'visual-v1',
        contentId,
        manifestPath: `generations/${contentId}/manifest.json`,
      }),
    )
    const result = await verifyCurrentGeneration(visualV1Dir)
    expect(result.actualContentId).toBe(contentId)
  })

  it('SIMULATED INTERRUPTION between generation publish and pointer publish: current.json keeps naming the OLD generation', async () => {
    const visualV1Dir = workDir
    const generationsDir = join(visualV1Dir, 'generations')
    const genA = buildValidGeneration({ cardIds: ['card-a', 'card-b'] })
    await publishGenerationAtomically(generationsDir, genA.contentId, genA.files, (dir) =>
      verifyIndexGeneration(dir, { expectedContentId: genA.contentId }).then(() => {}),
    )
    await publishPointerAtomically(
      visualV1Dir,
      JSON.stringify({
        indexVersion: 'visual-v1',
        contentId: genA.contentId,
        manifestPath: `generations/${genA.contentId}/manifest.json`,
      }),
    )

    // Generation B gets published successfully (files on disk)... but the process is "killed"
    // before publishPointerAtomically for B is ever called — current.json is simply never touched.
    const genB = buildValidGeneration({ cardIds: ['card-c', 'card-d', 'card-e'] })
    await publishGenerationAtomically(generationsDir, genB.contentId, genB.files, (dir) =>
      verifyIndexGeneration(dir, { expectedContentId: genB.contentId }).then(() => {}),
    )
    // (no publishPointerAtomically call for B — simulates the kill)

    const result = await verifyCurrentGeneration(visualV1Dir)
    expect(result.actualContentId).toBe(genA.contentId) // still A, never a torn/partial pointer
  })
})

describe('verifyIndexGeneration — deliberate corruption rejection (§19)', () => {
  function writeGeneration(dir: string, files: GenerationFiles): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), files['manifest.json'])
    writeFileSync(join(dir, 'card-ids.json'), files['card-ids.json'])
    writeFileSync(join(dir, 'embeddings.bin'), files['embeddings.bin'])
  }

  it('accepts a genuinely valid generation (sanity baseline for every corruption test below)', async () => {
    const { files, contentId } = buildValidGeneration()
    const dir = join(workDir, 'valid')
    writeGeneration(dir, files)
    await expect(
      verifyIndexGeneration(dir, { expectedContentId: contentId }),
    ).resolves.toMatchObject({
      actualContentId: contentId,
    })
  })

  it('rejects a corrupted manifest (checksum no longer matches embeddings.bin)', async () => {
    const { files, contentId } = buildValidGeneration()
    const dir = join(workDir, 'bad-manifest')
    const manifest = JSON.parse(files['manifest.json']) as VisualIndexManifest
    writeGeneration(dir, {
      ...files,
      'manifest.json': JSON.stringify({ ...manifest, embeddingsSha256: 'f'.repeat(64) }),
    })
    await expect(verifyIndexGeneration(dir, { expectedContentId: contentId })).rejects.toThrow(
      /checksum mismatch/,
    )
  })

  it('rejects corrupted card-ids.json (duplicate id introduced)', async () => {
    const { files } = buildValidGeneration()
    const dir = join(workDir, 'bad-ids')
    writeGeneration(dir, { ...files, 'card-ids.json': JSON.stringify(['card-a', 'card-a']) })
    await expect(verifyIndexGeneration(dir)).rejects.toThrow(/[Dd]uplicate/)
  })

  it('rejects one corrupted byte in embeddings.bin (checksum mismatch)', async () => {
    const { files, contentId } = buildValidGeneration()
    const dir = join(workDir, 'bad-byte')
    const corrupted = Buffer.from(files['embeddings.bin'])
    corrupted[0] = (corrupted[0]! + 1) % 256
    writeGeneration(dir, { ...files, 'embeddings.bin': corrupted })
    await expect(verifyIndexGeneration(dir, { expectedContentId: contentId })).rejects.toThrow(
      /checksum mismatch/,
    )
  })

  it('rejects a content id that does not match the directory it is published under', async () => {
    const { files, contentId } = buildValidGeneration()
    const dir = join(workDir, 'wrong-content-id-dir')
    writeGeneration(dir, files)
    await expect(
      verifyIndexGeneration(dir, { expectedContentId: 'ffffffffffffffff' }),
    ).rejects.toThrow(/[Cc]ontent id mismatch/)
    // Sanity: the CORRECT expected id still passes against the same files.
    await expect(verifyIndexGeneration(dir, { expectedContentId: contentId })).resolves.toBeTruthy()
  })

  it('rejects an impossible coverage (cardsIndexed exceeding totalCanonicalCards)', async () => {
    const { files } = buildValidGeneration()
    const dir = join(workDir, 'bad-coverage')
    const manifest = JSON.parse(files['manifest.json']) as VisualIndexManifest
    writeGeneration(dir, {
      ...files,
      'manifest.json': JSON.stringify({
        ...manifest,
        coverage: { ...manifest.coverage, totalCanonicalCards: 1 }, // cardsIndexed (2) now exceeds it
      }),
    })
    await expect(verifyIndexGeneration(dir)).rejects.toThrow(/exceeds totalCanonicalCards/)
  })

  it('rejects a card-id count mismatch against manifest.cardCount', async () => {
    const { files } = buildValidGeneration()
    const dir = join(workDir, 'bad-count')
    const manifest = JSON.parse(files['manifest.json']) as VisualIndexManifest
    writeGeneration(dir, {
      ...files,
      'manifest.json': JSON.stringify({ ...manifest, cardCount: 99 }),
    })
    // decodeVisualIndex's own cardCount/card-ids-length agreement check fires first (a stricter,
    // earlier check than assertValidCoverage's own manifest.cardCount-vs-coverage.cardsIndexed
    // comparison) — either way the corrupted manifest is rejected, which is what this test proves.
    await expect(verifyIndexGeneration(dir)).rejects.toThrow(/99 cards/)
  })

  it('rejects an embeddings.bin byte-length mismatch against the declared shape', async () => {
    const { files, contentId } = buildValidGeneration()
    const dir = join(workDir, 'bad-length')
    const truncated = files['embeddings.bin'].subarray(0, files['embeddings.bin'].length - 4)
    writeGeneration(dir, { ...files, 'embeddings.bin': Buffer.from(truncated) })
    // Truncating changes the checksum first — either failure mode proves corruption is caught.
    await expect(verifyIndexGeneration(dir, { expectedContentId: contentId })).rejects.toThrow()
  })

  it('F-22: rejects a source project that does not match an explicitly configured expectation', async () => {
    const { files } = buildValidGeneration({ sourceProjectRef: 'wrong-project.supabase.co' })
    const dir = join(workDir, 'wrong-project')
    writeGeneration(dir, files)
    await expect(
      verifyIndexGeneration(dir, { expectedSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co' }),
    ).rejects.toThrow(/[Ss]ource project mismatch/)
  })

  it('F-22: accepts the matching source project when one is explicitly configured', async () => {
    const { files } = buildValidGeneration({ sourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co' })
    const dir = join(workDir, 'right-project')
    writeGeneration(dir, files)
    await expect(
      verifyIndexGeneration(dir, { expectedSourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co' }),
    ).resolves.toBeTruthy()
  })

  it('F-22: without an expected ref configured, ANY source project passes (informational only — CI placeholder-URL builds must stay green)', async () => {
    const { files } = buildValidGeneration({ sourceProjectRef: 'literally-anything.supabase.co' })
    const dir = join(workDir, 'unconfigured-project')
    writeGeneration(dir, files)
    await expect(verifyIndexGeneration(dir)).resolves.toBeTruthy()
  })

  it('rejects a wrong model revision', async () => {
    const { files } = buildValidGeneration()
    const dir = join(workDir, 'bad-revision')
    const manifest = JSON.parse(files['manifest.json']) as VisualIndexManifest
    writeGeneration(dir, {
      ...files,
      'manifest.json': JSON.stringify({ ...manifest, modelRevision: 'not-the-pinned-revision' }),
    })
    await expect(verifyIndexGeneration(dir)).rejects.toThrow(/[Mm]odel revision mismatch/)
  })
})
