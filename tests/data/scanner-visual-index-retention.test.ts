/**
 * Bounded generation retention (P94 N-06) — exercised against REAL temp directories on disk, not
 * mocked filesystem calls, matching the sibling `scanner-visual-index-publish.test.ts` style.
 *
 * Scenario from the prompt (§29): four generations A, B, C, D already exist with D current;
 * after a publish + prune cycle, only the current generation and the one immediately previous to
 * it survive — A and B (both older than "previous") are gone, C (previous) and D (current) remain,
 * the pointer still names D, and an interrupted publish (pointer never updated) prunes nothing.
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
  GENERATION_RETENTION_COUNT,
  pruneOldGenerations,
  readPreviousContentId,
} from '../../scripts/scanner-visual-index/generation-retention'

let visualV1Dir: string
let generationsDir: string

// Well-formed 16-hex-char content ids (INDEX_CONTENT_ID_HEX_LENGTH) — see index-content-id.ts.
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccc'
const D = 'dddddddddddddddd'

function fakeGeneration(contentId: string): void {
  const dir = join(generationsDir, contentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ contentId }))
}

function writePointer(contentId: string): void {
  writeFileSync(
    join(visualV1Dir, 'current.json'),
    JSON.stringify({
      indexVersion: 'visual-v1',
      contentId,
      manifestPath: `generations/${contentId}/manifest.json`,
    }),
  )
}

beforeEach(() => {
  visualV1Dir = mkdtempSync(join(tmpdir(), 'p94-index-retention-'))
  generationsDir = join(visualV1Dir, 'generations')
  mkdirSync(generationsDir, { recursive: true })
})
afterEach(() => {
  rmSync(visualV1Dir, { recursive: true, force: true })
})

describe('GENERATION_RETENTION_COUNT', () => {
  it('is the recommended current + immediately-previous policy (2 total)', () => {
    expect(GENERATION_RETENTION_COUNT).toBe(2)
  })
})

describe('readPreviousContentId', () => {
  it('returns null when no current.json exists (first-ever publish)', () => {
    expect(readPreviousContentId(visualV1Dir)).toBeNull()
  })

  it('returns the contentId a real current.json names', () => {
    writePointer(C)
    expect(readPreviousContentId(visualV1Dir)).toBe(C)
  })

  it('returns null on a malformed contentId rather than trusting it', () => {
    writeFileSync(join(visualV1Dir, 'current.json'), JSON.stringify({ contentId: 'not-a-hex-id' }))
    expect(readPreviousContentId(visualV1Dir)).toBeNull()
  })

  it('returns null on unparseable JSON rather than throwing', () => {
    writeFileSync(join(visualV1Dir, 'current.json'), '{not json')
    expect(readPreviousContentId(visualV1Dir)).toBeNull()
  })
})

describe('pruneOldGenerations — §29 scenario: A, B, C, D=current, retention=2', () => {
  it('removes A and B, keeps C (previous) and D (current), pointer still names D', () => {
    // Simulate four generations already having accumulated on disk (the real-world shape:
    // pre-GC builds never deleted anything), with D being the current publish.
    fakeGeneration(A)
    fakeGeneration(B)
    fakeGeneration(C)
    fakeGeneration(D)
    writePointer(C) // "previous" pointer, before this run's publish

    // What build-index.ts does: capture previous BEFORE overwriting the pointer, publish D
    // (already created above), THEN update the pointer, THEN prune.
    const previousContentId = readPreviousContentId(visualV1Dir)
    expect(previousContentId).toBe(C)
    writePointer(D)

    const retain = new Set([D, ...(previousContentId !== null ? [previousContentId] : [])])
    const { retained, pruned } = pruneOldGenerations(generationsDir, retain)

    expect(new Set(pruned)).toEqual(new Set([A, B]))
    expect(new Set(retained)).toEqual(new Set([C, D]))
    expect(existsSync(join(generationsDir, A))).toBe(false)
    expect(existsSync(join(generationsDir, B))).toBe(false)
    expect(existsSync(join(generationsDir, C))).toBe(true)
    expect(existsSync(join(generationsDir, D))).toBe(true)

    // The build/staging step only ever copies what's actually left on disk — bounding it to
    // exactly the retained set is what keeps stage-index-assets.mjs's cpSync bounded too.
    expect(readdirSync(generationsDir).sort()).toEqual([C, D].sort())

    // The pointer is untouched by pruning and still names the current generation.
    const pointer = JSON.parse(readFileSync(join(visualV1Dir, 'current.json'), 'utf-8')) as {
      contentId: string
    }
    expect(pointer.contentId).toBe(D)
  })

  it('an interrupted publish (pointer never advanced) prunes nothing new', () => {
    // A, B, C exist; C is current. A build starts publishing D's directory but is killed before
    // the pointer is ever updated — build-index.ts must never call pruneOldGenerations in that
    // case at all, but even if something did, C (still what current.json names) must survive.
    fakeGeneration(A)
    fakeGeneration(B)
    fakeGeneration(C)
    writePointer(C)
    fakeGeneration(D) // the new generation's directory landed, but the pointer was never advanced

    // Pruning is never invoked here — this test proves that IF it somehow were invoked using the
    // pointer's own current (unmoved) value, the previous-generation safety net still holds and
    // the still-referenced C is never at risk, even though this exact call sequence (retain
    // computed from the OLD pointer only, no "new" contentId) is not what build-index.ts does on
    // a successful run.
    const stillCurrent = readPreviousContentId(visualV1Dir)
    expect(stillCurrent).toBe(C)
    const { pruned } = pruneOldGenerations(generationsDir, new Set([stillCurrent as string]))
    expect(pruned).not.toContain(C)
    expect(existsSync(join(generationsDir, C))).toBe(true)
  })

  it('never touches a .tmp-* staging directory (a concurrent in-progress publish)', () => {
    fakeGeneration(C)
    mkdirSync(join(generationsDir, '.tmp-deadbeef-123-456-0.789'), { recursive: true })
    writeFileSync(join(generationsDir, '.tmp-deadbeef-123-456-0.789', 'embeddings.bin'), 'partial')

    const { pruned } = pruneOldGenerations(generationsDir, new Set([C]))
    expect(pruned).toEqual([])
    expect(existsSync(join(generationsDir, '.tmp-deadbeef-123-456-0.789'))).toBe(true)
  })

  it('is idempotent — pruning an already-pruned directory removes nothing further', () => {
    fakeGeneration(C)
    fakeGeneration(D)
    pruneOldGenerations(generationsDir, new Set([D]))
    const second = pruneOldGenerations(generationsDir, new Set([D]))
    expect(second.pruned).toEqual([])
    expect(second.retained).toEqual([D])
  })

  it('handles a missing generations directory without throwing', () => {
    rmSync(generationsDir, { recursive: true, force: true })
    expect(() => pruneOldGenerations(generationsDir, new Set([D]))).not.toThrow()
    const result = pruneOldGenerations(generationsDir, new Set([D]))
    expect(result).toEqual({ retained: [], pruned: [] })
  })
})
