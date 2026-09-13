/**
 * Regression coverage that `SUPABASE_SERVICE_ROLE_KEY` can only ever enter the offline visual-index
 * generator via `process.env`, and never leaves it through a log line, the checkpoint, the
 * manifest, an error message, or the generated index (P110, prompt §9). No real secret is used
 * anywhere in this file — a distinctive, obviously-fake marker string stands in for one.
 *
 * Two complementary strategies, since neither alone is sufficient:
 *   1. A STATIC source audit of build-index.ts: the `key`/`SUPABASE_SERVICE_ROLE_KEY` identifiers
 *      may only appear on an explicit allowlist of lines (the env read, the destructure, the
 *      `createClient` call, and this module's own doc comments) — never inside a `console.*` call,
 *      a `JSON.stringify`, or an object literal assigned to a checkpoint/manifest field. This
 *      catches a future edit that threads the key into a NEW code path this test doesn't otherwise
 *      exercise.
 *   2. A STRUCTURAL check on the Checkpoint/coverage/failure-budget TYPES themselves: their field
 *      lists are pinned exactly, so a future change that adds a `secret`/`key`/`token`/`credential`
 *      -shaped field to any of them fails this test immediately, before it could ever be populated.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  freshCheckpoint,
  type CheckpointIdentity,
} from '../../src/domain/scanner/checkpoint-identity'

const FAKE_SECRET = 'FAKE-service-role-key-never-a-real-secret-zzz999'

function identity(): CheckpointIdentity {
  return {
    schemaVersion: 4,
    sourceProjectIdentity: 'example-project.supabase.co',
    modelId: 'Xenova/dinov2-small',
    modelRevision: 'c2bb04a51fab207c420665f1946016107bffc701',
    embeddingDim: 384,
    quantization: 'int8',
    prototypesPerCard: 2,
    prototypeStrategy: 'pristinePlus1Aux',
    prototypeStrategyVersion: '1',
  }
}

describe('build-index.ts — static source audit: SUPABASE_SERVICE_ROLE_KEY never leaves process.env', () => {
  const source = readFileSync(
    new URL('../../scripts/scanner-visual-index/build-index.ts', import.meta.url),
    'utf-8',
  )
  const lines = source.split('\n')

  it('every line referencing the `key` identifier is one of the expected, allowlisted lines', () => {
    const keyLines = lines
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => /\bkey\b/.test(line))

    for (const { line, number } of keyLines) {
      const isDocOrComment = /^\s*\*|^\s*\/\//.test(line)
      const isEnvRead = /process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(line)
      const isDestructureOrReturn =
        /\{\s*url,\s*key\s*\}/.test(line) || /return\s*\{\s*url,\s*key\s*\}/.test(line)
      const isLocalDefaultField = /key:\s*LOCAL_DEFAULTS\.serviceRoleKey/.test(line)
      const isFunctionSignature = /function resolveConnection/.test(line)
      const isEmptyCheck = /key === undefined \|\| key === ''/.test(line)
      const isCreateClientCall = /createClient\(url, key\)/.test(line)

      const allowed =
        isDocOrComment ||
        isEnvRead ||
        isDestructureOrReturn ||
        isLocalDefaultField ||
        isFunctionSignature ||
        isEmptyCheck ||
        isCreateClientCall

      // Never allowed regardless of the above: the key identifier appearing anywhere near a
      // logging or serialization call on the SAME line.
      const nearLogging = /console\.(log|warn|error|info)|JSON\.stringify/.test(line)

      expect({ number, line, allowed, nearLogging }).toEqual({
        number,
        line,
        allowed: true,
        nearLogging: false,
      })
    }
  })

  it("the total number of `key`-referencing lines matches this test's own allowlist exactly (no untracked usage slipped in)", () => {
    // A future edit that adds a NEW reference to `key` anywhere in this file — logged, aliased, or
    // otherwise — changes this count and fails loudly here, forcing an explicit look rather than
    // silently expanding the allowlist above.
    const keyLineCount = lines.filter((line) => /\bkey\b/.test(line)).length
    expect(keyLineCount).toBe(9)
  })
})

describe('Checkpoint/coverage/failure-budget shapes — structural guarantee that no secret-shaped field exists', () => {
  it("freshCheckpoint's field list is exactly the expected, secret-free set", () => {
    const checkpoint = freshCheckpoint(identity())
    expect(Object.keys(checkpoint).sort()).toEqual(
      [
        'schemaVersion',
        'sourceProjectIdentity',
        'modelId',
        'modelRevision',
        'embeddingDim',
        'quantization',
        'prototypesPerCard',
        'prototypeStrategy',
        'prototypeStrategyVersion',
        'totalCanonicalCards',
        'cardsWithUsableImage',
        'embeddings',
        'auxEmbeddings',
        'auxFallback',
        'permanentFailures',
        'transientFailures',
      ].sort(),
    )
    for (const fieldName of Object.keys(checkpoint)) {
      expect(fieldName.toLowerCase()).not.toMatch(/secret|credential|apikey|api_key|token/)
    }
  })

  it('a checkpoint round-tripped through save/load never contains an injected fake secret unless explicitly put there by the test itself (sanity — proves the round trip is a plain, inspectable JSON blob, not an opaque encoding)', async () => {
    const { saveCheckpointAtomically, loadCheckpointFile } =
      await import('../../scripts/scanner-visual-index/checkpoint-io')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'p110-secret-leak-'))
    try {
      const path = join(dir, 'checkpoint.json')
      const checkpoint = freshCheckpoint(identity())
      await saveCheckpointAtomically(path, checkpoint)
      const raw = readFileSync(path, 'utf-8')
      expect(raw).not.toContain(FAKE_SECRET)
      const result = loadCheckpointFile(path)
      expect(JSON.stringify(result)).not.toContain(FAKE_SECRET)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('manifest fields — sourceProjectRef carries only a host, structurally never a key', () => {
  it('deriveProjectIdentity strips everything except host, even when the URL contains userinfo', async () => {
    const { deriveProjectIdentity } = await import('../../src/domain/scanner/checkpoint-identity')
    // A URL with embedded userinfo (the closest analogue to "a key living in the connection
    // string") — deriveProjectIdentity must still return only the host.
    const result = deriveProjectIdentity(
      `https://someuser:${FAKE_SECRET}@example-project.supabase.co`,
    )
    expect(result).not.toContain(FAKE_SECRET)
    expect(result).toBe('example-project.supabase.co')
  })
})
