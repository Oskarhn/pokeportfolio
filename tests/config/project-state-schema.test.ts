/**
 * Unit tests for scripts/lib/project-state-schema.mjs, the offline validator behind
 * scripts/check-project-state.mjs. Covers the P176 §17 requirements: schema shape, SHA syntax,
 * referenced docs exist, scanner content-id format, migration counts are integers, no candidate
 * marked both released and local-only, HANDOVER references PROJECT_STATE, fixed status vocabulary.
 */
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_STATUS_LABELS,
  CONTENT_ID_RE,
  SHA_RE,
  validateProjectState,
} from '../../scripts/lib/project-state-schema.mjs'

interface TestState {
  schema_version: number | string
  released: {
    main_sha: string | null
    production_frontend_sha: string | null
    hosted_migration_count: number | null
  }
  local_candidates: {
    native_integrated: {
      prompt: number
      sha: string | null
      status: string
    }
  }
  database: {
    released_migration_count: number | string | null
    latest_local_migration_count: number | null
  }
  scanner: { content_id: string | null }
  production: { in_real_user_use: boolean }
  canonical_docs: Record<string, string>
}

function validState(): TestState {
  return {
    schema_version: 1,
    released: {
      main_sha: 'd8682e047b757f63673a63ac8185a4806d68cb98',
      production_frontend_sha: 'd8682e047b757f63673a63ac8185a4806d68cb98',
      hosted_migration_count: 104,
    },
    local_candidates: {
      native_integrated: {
        prompt: 173,
        sha: '0600361f71ee2dd5591fbbbfb2fe260ab68ba7a2',
        status: 'LOCAL_ONLY',
      },
    },
    database: { released_migration_count: 104, latest_local_migration_count: 107 },
    scanner: { content_id: 'f25fc05d569b7cca' },
    production: { in_real_user_use: false },
    canonical_docs: { financial_semantics: 'docs/FINANCIAL_MODEL.md' },
  }
}

const okCtx = { docExists: () => true, handoverText: 'see docs/PROJECT_STATE.json for pointers' }

describe('validateProjectState — valid document', () => {
  it('accepts a well-formed state with no errors', () => {
    expect(validateProjectState(validState(), okCtx)).toEqual([])
  })
})

describe('validateProjectState — shape errors', () => {
  it('rejects a non-object root', () => {
    expect(validateProjectState(null, okCtx)).toHaveLength(1)
    expect(validateProjectState([1, 2], okCtx)).toHaveLength(1)
  })

  it('requires schema_version to be a number', () => {
    const state = validState()
    state.schema_version = '1'
    expect(validateProjectState(state, okCtx).some((e) => /schema_version/.test(e))).toBe(true)
  })
})

describe('validateProjectState — SHA syntax', () => {
  it('rejects a released.main_sha that is not lowercase hex', () => {
    const state = validState()
    state.released.main_sha = 'NOT-A-SHA'
    const errors = validateProjectState(state, okCtx)
    expect(errors.some((e) => /main_sha/.test(e))).toBe(true)
  })

  it('null SHAs are allowed (unverified values must be null, never guessed)', () => {
    const state = validState()
    state.released.main_sha = null
    expect(validateProjectState(state, okCtx)).toEqual([])
  })

  it('rejects a local candidate SHA with invalid characters', () => {
    const state = validState()
    state.local_candidates.native_integrated.sha = 'zzzzzzz'
    const errors = validateProjectState(state, okCtx)
    expect(errors.some((e) => /native_integrated\.sha/.test(e))).toBe(true)
  })

  it('SHA_RE matches 7-40 lowercase hex chars only', () => {
    expect(SHA_RE.test('0600361')).toBe(true)
    expect(SHA_RE.test('0600361f71ee2dd5591fbbbfb2fe260ab68ba7a2')).toBe(true)
    expect(SHA_RE.test('ABCDEF1')).toBe(false)
    expect(SHA_RE.test('123')).toBe(false)
  })
})

describe('validateProjectState — released vs local-only cannot be confused (P176 §8)', () => {
  it('flags a local candidate whose SHA equals the released main_sha', () => {
    const state = validState()
    state.local_candidates.native_integrated.sha = state.released.main_sha
    const errors = validateProjectState(state, okCtx)
    expect(errors.some((e) => /cannot be both released and local-only/.test(e))).toBe(true)
  })

  it('flags a local candidate explicitly labelled RELEASED', () => {
    const state = validState()
    state.local_candidates.native_integrated.status = 'RELEASED'
    const errors = validateProjectState(state, okCtx)
    expect(errors.some((e) => /must not be RELEASED/.test(e))).toBe(true)
  })

  it('rejects a status label outside the fixed vocabulary (no near-duplicate spellings)', () => {
    const state = validState()
    state.local_candidates.native_integrated.status = 'LOCAL-ONLY'
    const errors = validateProjectState(state, okCtx)
    expect(errors.some((e) => /not in the fixed vocabulary/.test(e))).toBe(true)
  })

  it('ALLOWED_STATUS_LABELS has no duplicate entries', () => {
    expect(new Set(ALLOWED_STATUS_LABELS).size).toBe(ALLOWED_STATUS_LABELS.length)
  })
})

describe('validateProjectState — migration counts', () => {
  it('rejects a non-integer migration count', () => {
    const state = validState()
    state.database.released_migration_count = '104'
    expect(validateProjectState(state, okCtx).length).toBeGreaterThan(0)
  })

  it('flags local migration count lower than released (should never regress)', () => {
    const state = validState()
    state.database.latest_local_migration_count = 100
    const errors = validateProjectState(state, okCtx)
    expect(errors.some((e) => /lower than released_migration_count/.test(e))).toBe(true)
  })

  it('null migration counts are allowed when unverified', () => {
    const state = validState()
    state.database.released_migration_count = null
    state.database.latest_local_migration_count = null
    expect(validateProjectState(state, okCtx)).toEqual([])
  })
})

describe('validateProjectState — scanner content id format', () => {
  it('CONTENT_ID_RE matches the known scanner content id', () => {
    expect(CONTENT_ID_RE.test('f25fc05d569b7cca')).toBe(true)
  })

  it('rejects a malformed content id', () => {
    const state = validState()
    state.scanner.content_id = 'not-hex!!'
    expect(validateProjectState(state, okCtx).length).toBeGreaterThan(0)
  })

  it('allows a null content id when unverified', () => {
    const state = validState()
    state.scanner.content_id = null
    expect(validateProjectState(state, okCtx)).toEqual([])
  })
})

describe('validateProjectState — canonical_docs references must exist', () => {
  it('fails when a referenced doc does not exist on disk', () => {
    const state = validState()
    const ctx = { docExists: () => false, handoverText: 'docs/PROJECT_STATE.json' }
    const errors = validateProjectState(state, ctx)
    expect(errors.some((e) => /financial_semantics/.test(e))).toBe(true)
  })
})

describe('validateProjectState — HANDOVER must reference PROJECT_STATE.json back', () => {
  it('fails when HANDOVER.md text does not mention PROJECT_STATE.json', () => {
    const errors = validateProjectState(validState(), {
      docExists: () => true,
      handoverText: 'no pointer here',
    })
    expect(errors.some((e) => /does not reference docs\/PROJECT_STATE\.json/.test(e))).toBe(true)
  })

  it('fails closed when handoverText was not supplied at all', () => {
    const errors = validateProjectState(validState(), { docExists: () => true, handoverText: null })
    expect(errors.some((e) => /not supplied to the validator/.test(e))).toBe(true)
  })
})
