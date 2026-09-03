/**
 * Content-addressed visual-index generation id (P87 F-01). Pure-function coverage; the Node/
 * browser hashing sides (createHash / crypto.subtle) are exercised end-to-end by
 * tests/data/scanner-visual-index-publish.test.ts and visual-worker.ts's own runtime path.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildIndexContentPayload,
  truncateDigestHex,
  isWellFormedContentId,
  INDEX_CONTENT_ID_HEX_LENGTH,
  type IndexContentIdManifestFields,
} from '../../../src/domain/scanner/index-content-id'

function fields(
  overrides: Partial<IndexContentIdManifestFields> = {},
): IndexContentIdManifestFields {
  return {
    version: 'visual-v1',
    modelId: 'Xenova/dinov2-small',
    modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
    modelSha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
    embeddingDim: 384,
    quantization: 'int8',
    cardCount: 2,
    coverage: { totalCanonicalCards: 2, cardsWithUsableImage: 2, cardsIndexed: 2, failures: 0 },
    sourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
    sourceEnglishActiveCount: 2,
    ...overrides,
  }
}

const cardIdsBytes = new TextEncoder().encode(JSON.stringify(['a', 'b']))
const embeddingsBytes = new Uint8Array([1, 2, 3, 4])

function hashHex(payload: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(payload)).digest('hex')
}

describe('buildIndexContentPayload / deriveIndexContentId (P87 F-01)', () => {
  it('is deterministic: the same inputs always produce the same payload/hash', () => {
    const p1 = buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes)
    const p2 = buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes)
    expect(hashHex(p1)).toBe(hashHex(p2))
  })

  it('is NOT affected by generatedAt-style timestamps — those are deliberately not part of the fields object', () => {
    // IndexContentIdManifestFields has no generatedAt field at all, so a caller cannot
    // accidentally feed it in — this test documents that contract directly.
    const withoutTimestampField: IndexContentIdManifestFields = fields()
    expect('generatedAt' in withoutTimestampField).toBe(false)
  })

  it('changes when cardCount changes — cardCount ALONE is insufficient, but it does contribute', () => {
    const a = hashHex(
      buildIndexContentPayload(fields({ cardCount: 2 }), cardIdsBytes, embeddingsBytes),
    )
    const b = hashHex(
      buildIndexContentPayload(fields({ cardCount: 3 }), cardIdsBytes, embeddingsBytes),
    )
    expect(a).not.toBe(b)
  })

  it('changes when the card-ids bytes change even if every manifest field is identical (cardCount alone is insufficient)', () => {
    const sameFields = fields({ cardCount: 2 })
    const idsA = new TextEncoder().encode(JSON.stringify(['a', 'b']))
    const idsB = new TextEncoder().encode(JSON.stringify(['c', 'd'])) // same count, different cards
    const a = hashHex(buildIndexContentPayload(sameFields, idsA, embeddingsBytes))
    const b = hashHex(buildIndexContentPayload(sameFields, idsB, embeddingsBytes))
    expect(a).not.toBe(b)
  })

  it('changes when the embeddings bytes change, even with identical manifest fields and card ids', () => {
    const a = hashHex(
      buildIndexContentPayload(fields(), cardIdsBytes, new Uint8Array([1, 2, 3, 4])),
    )
    const b = hashHex(
      buildIndexContentPayload(fields(), cardIdsBytes, new Uint8Array([1, 2, 3, 5])),
    )
    expect(a).not.toBe(b)
  })

  it('changes when sourceProjectRef changes — modelRevision alone is insufficient to distinguish generations', () => {
    const a = hashHex(
      buildIndexContentPayload(
        fields({ sourceProjectRef: 'project-a.supabase.co' }),
        cardIdsBytes,
        embeddingsBytes,
      ),
    )
    const b = hashHex(
      buildIndexContentPayload(
        fields({ sourceProjectRef: 'project-b.supabase.co' }),
        cardIdsBytes,
        embeddingsBytes,
      ),
    )
    expect(a).not.toBe(b)
  })

  it('two byte-identical generations built on different days produce the SAME content id (no generatedAt dependency)', () => {
    // Nothing time-dependent ever enters buildIndexContentPayload — simulated here by simply
    // calling it twice with identical inputs, which is exactly what "rebuilt tomorrow with no
    // real change" looks like from this function's point of view.
    const a = hashHex(buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes))
    const b = hashHex(buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes))
    expect(a).toBe(b)
  })
})

describe('P97 (D-106) — dual-prototype fields in the content-id hash', () => {
  it('a v1 manifest (no prototype fields at all) hashes IDENTICALLY before and after this change — backward compatibility for the already-published real index', () => {
    // fields() never sets prototypeCount/prototypeStrategy/prototypeStrategyVersion, so they are
    // `undefined` here — the exact shape every already-committed single-prototype manifest has.
    // JSON.stringify drops undefined-valued keys, so this payload must be byte-identical to what
    // this function produced before prototype fields existed at all.
    const v1Payload = buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes)
    const expectedV1Json = JSON.stringify({
      version: 'visual-v1',
      modelId: 'Xenova/dinov2-small',
      modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
      modelSha256: '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917',
      embeddingDim: 384,
      quantization: 'int8',
      cardCount: 2,
      coverage: { totalCanonicalCards: 2, cardsWithUsableImage: 2, cardsIndexed: 2, failures: 0 },
      sourceProjectRef: 'nopmkroeygmlvndzjjqs.supabase.co',
      sourceEnglishActiveCount: 2,
    })
    const expectedFieldsBytes = new TextEncoder().encode(expectedV1Json)
    const expectedPayload = new Uint8Array(
      expectedFieldsBytes.length + cardIdsBytes.length + embeddingsBytes.length,
    )
    expectedPayload.set(expectedFieldsBytes, 0)
    expectedPayload.set(cardIdsBytes, expectedFieldsBytes.length)
    expectedPayload.set(embeddingsBytes, expectedFieldsBytes.length + cardIdsBytes.length)
    expect(hashHex(v1Payload)).toBe(hashHex(expectedPayload))
  })

  it('changes the content id when prototypeCount/strategy/version are present, even with identical card ids and embeddings bytes', () => {
    const v1 = hashHex(buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes))
    const v2 = hashHex(
      buildIndexContentPayload(
        fields({
          prototypeCount: 2,
          prototypeStrategy: 'pristinePlus1Aux',
          prototypeStrategyVersion: '1',
        }),
        cardIdsBytes,
        embeddingsBytes,
      ),
    )
    expect(v1).not.toBe(v2)
  })

  it('changes the content id when only prototypeStrategyVersion changes — a recipe change must never collide with the old recipe', () => {
    const withDualProtoFields = (version: string) =>
      hashHex(
        buildIndexContentPayload(
          fields({
            prototypeCount: 2,
            prototypeStrategy: 'pristinePlus1Aux',
            prototypeStrategyVersion: version,
          }),
          cardIdsBytes,
          embeddingsBytes,
        ),
      )
    expect(withDualProtoFields('1')).not.toBe(withDualProtoFields('2'))
  })

  it('changes the content id when cardsWithAuxPrototype/cardsAuxFallback differ, even with everything else identical', () => {
    const a = hashHex(
      buildIndexContentPayload(
        fields({
          coverage: {
            totalCanonicalCards: 2,
            cardsWithUsableImage: 2,
            cardsIndexed: 2,
            failures: 0,
            cardsWithAuxPrototype: 2,
            cardsAuxFallback: 0,
          },
        }),
        cardIdsBytes,
        embeddingsBytes,
      ),
    )
    const b = hashHex(
      buildIndexContentPayload(
        fields({
          coverage: {
            totalCanonicalCards: 2,
            cardsWithUsableImage: 2,
            cardsIndexed: 2,
            failures: 0,
            cardsWithAuxPrototype: 1,
            cardsAuxFallback: 1,
          },
        }),
        cardIdsBytes,
        embeddingsBytes,
      ),
    )
    expect(a).not.toBe(b)
  })
})

describe('truncateDigestHex / isWellFormedContentId', () => {
  it('truncates to exactly INDEX_CONTENT_ID_HEX_LENGTH hex characters', () => {
    const full = hashHex(buildIndexContentPayload(fields(), cardIdsBytes, embeddingsBytes))
    const truncated = truncateDigestHex(full)
    expect(truncated.length).toBe(INDEX_CONTENT_ID_HEX_LENGTH)
    expect(full.startsWith(truncated)).toBe(true)
  })

  it('accepts a well-formed lowercase hex content id of the expected length', () => {
    expect(isWellFormedContentId('0123456789abcdef')).toBe(true)
  })

  it('rejects the wrong length, uppercase, non-hex characters, or a non-string', () => {
    expect(isWellFormedContentId('0123456789abcde')).toBe(false) // one short
    expect(isWellFormedContentId('0123456789abcdef0')).toBe(false) // one long
    expect(isWellFormedContentId('0123456789ABCDEF')).toBe(false) // uppercase
    expect(isWellFormedContentId('0123456789abcdeg')).toBe(false) // non-hex char
    expect(isWellFormedContentId(undefined)).toBe(false)
    expect(isWellFormedContentId(null)).toBe(false)
    expect(isWellFormedContentId(42)).toBe(false)
    // Guards against a path-traversal-shaped value ever being trusted as a content id (it would
    // otherwise be interpolated directly into a fetch URL by visual-worker.ts's loadIndex()).
    expect(isWellFormedContentId('../../../etc/passwd')).toBe(false)
  })
})
