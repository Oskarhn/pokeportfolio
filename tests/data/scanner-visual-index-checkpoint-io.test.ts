/**
 * Atomic checkpoint write + corrupt-checkpoint recovery (P110, prompt §2-3 — P107's
 * DUAL_BUILD_RISK_VERDICT §19). Exercised against a REAL temp directory on disk, not a mocked
 * filesystem, matching tests/data/scanner-visual-index-publish.test.ts's own convention — a
 * Node/Windows-specific rename-atomicity assumption would actually be caught here.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadCheckpointFile,
  saveCheckpointAtomically,
} from '../../scripts/scanner-visual-index/checkpoint-io'

let workDir: string
let checkpointDir: string
let checkpointPath: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'p110-checkpoint-io-'))
  checkpointDir = join(workDir, '.visual-index-cache')
  checkpointPath = join(checkpointDir, 'build-checkpoint.json')
})
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function writeRaw(contents: string): void {
  mkdirSync(checkpointDir, { recursive: true })
  writeFileSync(checkpointPath, contents)
}

describe('loadCheckpointFile', () => {
  it('reports "absent" when no checkpoint file exists yet (first-ever build)', () => {
    const result = loadCheckpointFile(checkpointPath)
    expect(result).toEqual({ status: 'absent' })
  })

  it('loads a valid checkpoint as-is', () => {
    writeRaw(JSON.stringify({ hello: 'world' }))
    const result = loadCheckpointFile(checkpointPath)
    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect(result.checkpoint).toEqual({ hello: 'world' })
    }
  })
})

describe('loadCheckpointFile — corruption recovery (never crashes, never silently deletes evidence)', () => {
  it('truncated JSON: reports "corrupt", quarantines the original file, never throws', () => {
    writeRaw('{"embeddings": {"card-a": [0.1, 0.2') // truncated mid-array
    const result = loadCheckpointFile(checkpointPath)
    expect(result.status).toBe('corrupt')
    expect(existsSync(checkpointPath)).toBe(false) // moved aside, not left in place
    if (result.status === 'corrupt') {
      expect(existsSync(result.quarantinePath)).toBe(true)
      expect(readFileSync(result.quarantinePath, 'utf-8')).toContain('"card-a"') // evidence preserved
      expect(result.reason).toMatch(/not valid JSON/)
    }
  })

  it('empty file: reports "corrupt", never crashes', () => {
    writeRaw('')
    const result = loadCheckpointFile(checkpointPath)
    expect(result.status).toBe('corrupt')
    if (result.status === 'corrupt') expect(result.reason).toMatch(/not valid JSON/)
  })

  it('wrong schema (valid JSON, but not an object): reports "corrupt" for an array, null, and a string', () => {
    writeRaw('[1,2,3]')
    const arrayResult = loadCheckpointFile(checkpointPath)
    expect(arrayResult.status).toBe('corrupt')
    if (arrayResult.status === 'corrupt') {
      expect(arrayResult.reason).toMatch(/did not contain a JSON object/)
    }

    writeRaw('null')
    expect(loadCheckpointFile(checkpointPath).status).toBe('corrupt')

    writeRaw('"just a string"')
    expect(loadCheckpointFile(checkpointPath).status).toBe('corrupt')
  })

  it("valid old checkpoint (a real, well-formed object missing newer fields) loads successfully — identity mismatch is the CALLER's job, not this module's", () => {
    writeRaw(JSON.stringify({ schemaVersion: 2, embeddings: { 'card-a': [0.1] } }))
    const result = loadCheckpointFile(checkpointPath)
    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect((result.checkpoint as { schemaVersion: number }).schemaVersion).toBe(2)
    }
  })

  it('interrupted temp file left over from a killed prior save does not affect loading the real checkpoint', () => {
    writeRaw(JSON.stringify({ schemaVersion: 4, embeddings: {} }))
    writeFileSync(join(checkpointDir, '.tmp-checkpoint-leftover'), '{"trunc')
    const result = loadCheckpointFile(checkpointPath)
    expect(result.status).toBe('loaded')
    // The leftover temp file from a simulated prior kill is simply ignored — never read as if it
    // were the real checkpoint, and never cleaned up by loadCheckpointFile (that isn't its job).
    expect(existsSync(join(checkpointDir, '.tmp-checkpoint-leftover'))).toBe(true)
  })
})

describe('saveCheckpointAtomically', () => {
  it('writes the checkpoint and leaves no leftover temp file behind', async () => {
    await saveCheckpointAtomically(checkpointPath, { schemaVersion: 4, embeddings: { a: [1] } })
    expect(existsSync(checkpointPath)).toBe(true)
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8'))).toEqual({
      schemaVersion: 4,
      embeddings: { a: [1] },
    })
    expect(readdirSync(checkpointDir).filter((n) => n.startsWith('.tmp-'))).toHaveLength(0)
  })

  it('a second save fully replaces the first (no merge, no stale leftover fields)', async () => {
    await saveCheckpointAtomically(checkpointPath, { schemaVersion: 4, embeddings: { a: [1] } })
    await saveCheckpointAtomically(checkpointPath, { schemaVersion: 4, embeddings: { b: [2] } })
    expect(JSON.parse(readFileSync(checkpointPath, 'utf-8'))).toEqual({
      schemaVersion: 4,
      embeddings: { b: [2] },
    })
  })

  it('the checkpoint directory is created on demand — the first-ever save does not require it to pre-exist', async () => {
    const freshPath = join(workDir, 'nested', 'deeper', 'checkpoint.json')
    await saveCheckpointAtomically(freshPath, { schemaVersion: 4 })
    expect(existsSync(freshPath)).toBe(true)
  })

  it('round-trips through loadCheckpointFile successfully', async () => {
    const payload = { schemaVersion: 4, embeddings: { 'card-x': [0.5, -0.5] }, auxEmbeddings: {} }
    await saveCheckpointAtomically(checkpointPath, payload)
    const result = loadCheckpointFile(checkpointPath)
    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') expect(result.checkpoint).toEqual(payload)
  })
})
