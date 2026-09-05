/**
 * Visual-index checkpoint identity binding and packing (P77, prompt §46 CP1–CP7). Reproduces the
 * exact P76 contamination bug: a checkpoint built against one source (local dev, or a different
 * hosted project/model/revision/dim) must never be silently reused, and packing must never trust
 * `Object.keys(checkpoint.embeddings)` beyond the CURRENT canonical id set.
 */
import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_SCHEMA_VERSION,
  canonicalizeProjectIdentity,
  checkpointMatchesIdentity,
  deriveProjectIdentity,
  freshCheckpoint,
  LOCAL_PROJECT_IDENTITY_SENTINEL,
  packCurrentCardIds,
  type CheckpointIdentity,
} from '../../../src/domain/scanner/checkpoint-identity'
import {
  assertValidCoverage,
  CoverageInvariantError,
} from '../../../src/domain/scanner/index-coverage'

function identity(overrides: Partial<CheckpointIdentity> = {}): CheckpointIdentity {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sourceProjectIdentity: 'nopmkroeygmlvndzjjqs.supabase.co',
    modelId: 'Xenova/dinov2-small',
    modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
    embeddingDim: 384,
    quantization: 'int8',
    prototypesPerCard: 2,
    prototypeStrategy: 'pristinePlus1Aux',
    prototypeStrategyVersion: '1',
    ...overrides,
  }
}

describe('deriveProjectIdentity', () => {
  it('extracts only the host — never credentials — from a project URL', () => {
    expect(deriveProjectIdentity('https://nopmkroeygmlvndzjjqs.supabase.co')).toBe(
      'nopmkroeygmlvndzjjqs.supabase.co',
    )
    expect(deriveProjectIdentity('http://127.0.0.1:54321')).toBe('127.0.0.1:54321')
  })
})

describe('canonicalizeProjectIdentity (P94 N-13)', () => {
  it('normalizes every local Supabase alias to the same sentinel, any port', () => {
    expect(canonicalizeProjectIdentity('http://127.0.0.1:54321')).toBe(
      LOCAL_PROJECT_IDENTITY_SENTINEL,
    )
    expect(canonicalizeProjectIdentity('http://localhost:54321')).toBe(
      LOCAL_PROJECT_IDENTITY_SENTINEL,
    )
    expect(canonicalizeProjectIdentity('http://localhost:9999')).toBe(
      LOCAL_PROJECT_IDENTITY_SENTINEL,
    )
    expect(canonicalizeProjectIdentity('http://[::1]:54321')).toBe(LOCAL_PROJECT_IDENTITY_SENTINEL)
    // Also accepts a bare `host` string (deriveProjectIdentity's own return shape), not just a URL.
    expect(canonicalizeProjectIdentity('127.0.0.1:54321')).toBe(LOCAL_PROJECT_IDENTITY_SENTINEL)
    expect(canonicalizeProjectIdentity('localhost:54321')).toBe(LOCAL_PROJECT_IDENTITY_SENTINEL)
  })

  it('strips the .supabase.co suffix to the bare project ref', () => {
    expect(canonicalizeProjectIdentity('https://nopmkroeygmlvndzjjqs.supabase.co')).toBe(
      'nopmkroeygmlvndzjjqs',
    )
    // The raw host string form already committed in an existing manifest (no port on hosted URLs).
    expect(canonicalizeProjectIdentity('nopmkroeygmlvndzjjqs.supabase.co')).toBe(
      'nopmkroeygmlvndzjjqs',
    )
  })

  it('a hosted URL and its already-committed raw-host-string manifest value canonicalize identically (migration compatibility)', () => {
    const fromRuntimeUrl = canonicalizeProjectIdentity('https://nopmkroeygmlvndzjjqs.supabase.co')
    const fromStoredManifestHost = canonicalizeProjectIdentity(
      deriveProjectIdentity('https://nopmkroeygmlvndzjjqs.supabase.co'),
    )
    expect(fromRuntimeUrl).toBe(fromStoredManifestHost)
  })

  it('falls back to the bare lowercased hostname for an unrecognized (future custom) domain', () => {
    expect(canonicalizeProjectIdentity('https://Db.MyCompany.example')).toBe('db.mycompany.example')
  })
})

describe('CP1 — a local checkpoint cannot be reused for a hosted build', () => {
  it('rejects identity match across local vs. hosted source project', () => {
    const local = freshCheckpoint(identity({ sourceProjectIdentity: '127.0.0.1:54321' }))
    const hosted = identity({ sourceProjectIdentity: 'nopmkroeygmlvndzjjqs.supabase.co' })
    expect(checkpointMatchesIdentity(local, hosted)).toBe(false)
  })
})

describe('CP2 — hosted project A cannot be reused for hosted project B', () => {
  it('rejects identity match across two different hosted projects', () => {
    const projectA = freshCheckpoint(identity({ sourceProjectIdentity: 'project-a.supabase.co' }))
    const projectB = identity({ sourceProjectIdentity: 'project-b.supabase.co' })
    expect(checkpointMatchesIdentity(projectA, projectB)).toBe(false)
  })
})

describe('CP3 — a model revision mismatch invalidates the checkpoint', () => {
  it('rejects identity match when only modelRevision differs', () => {
    const old = freshCheckpoint(identity({ modelRevision: 'old-revision-sha' }))
    const current = identity({ modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701' })
    expect(checkpointMatchesIdentity(old, current)).toBe(false)
  })
})

describe('CP4 — an embedding dimension mismatch invalidates the checkpoint', () => {
  it('rejects identity match when only embeddingDim differs', () => {
    const old = freshCheckpoint(identity({ embeddingDim: 512 }))
    const current = identity({ embeddingDim: 384 })
    expect(checkpointMatchesIdentity(old, current)).toBe(false)
  })
})

describe('CP5 — a canonical id removed from the current fetch cannot survive into output', () => {
  it('packs only ids present in the current canonical set, dropping stale embeddings', () => {
    // 'card-b' was embedded in a prior run but the card is no longer active/fetched this run.
    const embeddings = { 'card-a': [1, 2, 3], 'card-b': [4, 5, 6], 'card-c': [7, 8, 9] }
    const currentIds = ['card-a', 'card-c']
    expect(packCurrentCardIds(currentIds, embeddings)).toEqual(['card-a', 'card-c'])
  })

  it('preserves the current-fetch order, not the checkpoint insertion order', () => {
    const embeddings = { z: [1], a: [2], m: [3] }
    expect(packCurrentCardIds(['a', 'm', 'z'], embeddings)).toEqual(['a', 'm', 'z'])
  })
})

describe('CP6 — a restart on the SAME project/config resumes successfully', () => {
  it('accepts identity match when every field agrees', () => {
    const checkpoint = freshCheckpoint(identity())
    expect(checkpointMatchesIdentity(checkpoint, identity())).toBe(true)
  })

  it('rejects a checkpoint written before identity binding existed (missing fields)', () => {
    const legacyCheckpoint: Partial<CheckpointIdentity> = {}
    expect(checkpointMatchesIdentity(legacyCheckpoint, identity())).toBe(false)
  })
})

describe('CP7 — the 1224/1000 historical failure shape is rejected', () => {
  it('throws CoverageInvariantError for cardsIndexed exceeding totalCanonicalCards', () => {
    expect(() => {
      assertValidCoverage(
        { totalCanonicalCards: 1000, cardsWithUsableImage: 1224, cardsIndexed: 1224, failures: 0 },
        1224,
        1224,
      )
    }).toThrow(CoverageInvariantError)
  })

  it('the packing constraint alone also prevents this shape from arising in the first place', () => {
    // Even if a checkpoint somehow held 1224 embeddings, packing against a 1000-card current
    // fetch can never output more than 1000 ids.
    const embeddings: Record<string, number[]> = {}
    for (let i = 0; i < 1224; i += 1) embeddings[`card-${String(i)}`] = [i]
    const currentIds = Array.from({ length: 1000 }, (_, i) => `card-${String(i)}`)
    const packed = packCurrentCardIds(currentIds, embeddings)
    expect(packed.length).toBe(1000)
  })
})

describe('CP8 (P97, D-106) — a checkpoint built under one prototype strategy cannot resume another', () => {
  it('rejects a checkpoint whose prototypesPerCard differs (a single-prototype checkpoint resuming a dual-prototype build)', () => {
    const singleProto = freshCheckpoint(
      identity({
        prototypesPerCard: 1,
        prototypeStrategy: 'pristineOnly',
        prototypeStrategyVersion: '0',
      }),
    )
    const dualProto = identity({
      prototypesPerCard: 2,
      prototypeStrategy: 'pristinePlus1Aux',
      prototypeStrategyVersion: '1',
    })
    expect(checkpointMatchesIdentity(singleProto, dualProto)).toBe(false)
  })

  it('rejects identity match when only prototypeStrategy differs', () => {
    const a = freshCheckpoint(identity({ prototypeStrategy: 'pristinePlus1Aux' }))
    const b = identity({ prototypeStrategy: 'centroidAll' })
    expect(checkpointMatchesIdentity(a, b)).toBe(false)
  })

  it('rejects identity match when only prototypeStrategyVersion differs (a recipe change)', () => {
    const a = freshCheckpoint(identity({ prototypeStrategyVersion: '1' }))
    const b = identity({ prototypeStrategyVersion: '2' })
    expect(checkpointMatchesIdentity(a, b)).toBe(false)
  })

  it('accepts identity match when every prototype field agrees too', () => {
    const checkpoint = freshCheckpoint(identity())
    expect(checkpointMatchesIdentity(checkpoint, identity())).toBe(true)
  })

  it('every pre-P97 checkpoint (schemaVersion 2, no prototype fields) is rejected outright by the schema-version bump alone', () => {
    const preP97: Partial<CheckpointIdentity> = {
      schemaVersion: 2,
      sourceProjectIdentity: 'nopmkroeygmlvndzjjqs.supabase.co',
      modelId: 'Xenova/dinov2-small',
      modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
      embeddingDim: 384,
      quantization: 'int8',
    }
    expect(checkpointMatchesIdentity(preP97, identity())).toBe(false)
  })

  it('freshCheckpoint always starts with empty auxEmbeddings/auxFallback maps', () => {
    const checkpoint = freshCheckpoint(identity())
    expect(checkpoint.auxEmbeddings).toEqual({})
    expect(checkpoint.auxFallback).toEqual({})
  })

  it('P110: freshCheckpoint always starts with empty permanentFailures/transientFailures maps', () => {
    const checkpoint = freshCheckpoint(identity())
    expect(checkpoint.permanentFailures).toEqual({})
    expect(checkpoint.transientFailures).toEqual({})
  })

  it('P110: a checkpoint missing prototypesPerCard/permanentFailures entirely (pre-P97/pre-P110 shape) is rejected by the schema-version bump alone', () => {
    const prePrior: Partial<CheckpointIdentity> = {
      schemaVersion: 3,
      sourceProjectIdentity: 'nopmkroeygmlvndzjjqs.supabase.co',
      modelId: 'Xenova/dinov2-small',
      modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
      embeddingDim: 384,
      quantization: 'int8',
      prototypesPerCard: 2,
      prototypeStrategy: 'pristinePlus1Aux',
      prototypeStrategyVersion: '1',
    }
    expect(checkpointMatchesIdentity(prePrior, identity())).toBe(false)
  })
})
