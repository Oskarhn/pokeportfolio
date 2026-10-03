/**
 * Static, offline validation for docs/PROJECT_STATE.json (the P176 machine-readable current-state
 * pointer file). Pure functions only — `scripts/check-project-state.mjs` is the thin CLI wrapper
 * that supplies filesystem access and HANDOVER.md's text.
 *
 * This validates SHAPE and internal consistency, not live truth: it cannot confirm a SHA is
 * actually on GitHub or that a migration count matches the hosted database. That is what the
 * project's existing `scripts/deployment-check.mjs` / `remote-security-check.mjs` are for.
 */

export const SHA_RE = /^[0-9a-f]{7,40}$/
export const CONTENT_ID_RE = /^[0-9a-f]{12,20}$/

/** Fixed vocabulary for candidate/status labels (P176 §8: released/local/design/blocked/superseded
 *  must never be confused with each other, and near-duplicate spellings must not silently drift
 *  apart from this list). */
export const ALLOWED_STATUS_LABELS = [
  'RELEASED',
  'LOCAL_ONLY',
  'LOCAL_ONLY_NOT_DEVICE_VERIFIED',
  'PUSHED_DEVELOPMENT_RC',
  'DESIGN_ONLY',
  'BLOCKED',
  'SUPERSEDED',
]

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {Record<string, unknown>} state
 * @param {{ docExists: (relPath: string) => boolean, handoverText: string | null }} ctx
 * @returns {string[]} errors — empty means valid
 */
export function validateProjectState(state, ctx) {
  const errors = []
  const err = (msg) => errors.push(msg)

  if (!isPlainObject(state)) {
    return ['PROJECT_STATE.json root must be a JSON object']
  }

  if (typeof state.schema_version !== 'number') {
    err('schema_version must be a number')
  }

  // ---- released ----
  const released = state.released
  if (!isPlainObject(released)) {
    err('released must be an object')
  } else {
    for (const key of ['main_sha', 'production_frontend_sha']) {
      const v = released[key]
      if (v !== null && (typeof v !== 'string' || !SHA_RE.test(v))) {
        err(
          `released.${key} must be null or a 7-40 char lowercase hex SHA, got ${JSON.stringify(v)}`,
        )
      }
    }
    if (
      released.hosted_migration_count !== null &&
      !Number.isInteger(released.hosted_migration_count)
    ) {
      err('released.hosted_migration_count must be null or an integer')
    }
  }

  // ---- local_candidates ----
  const candidates = state.local_candidates
  const releasedSha = isPlainObject(released) ? released.main_sha : null
  if (!isPlainObject(candidates)) {
    err('local_candidates must be an object')
  } else {
    for (const [name, candidate] of Object.entries(candidates)) {
      if (!isPlainObject(candidate)) {
        err(`local_candidates.${name} must be an object`)
        continue
      }
      if (candidate.sha !== undefined && candidate.sha !== null) {
        if (typeof candidate.sha !== 'string' || !SHA_RE.test(candidate.sha)) {
          err(`local_candidates.${name}.sha must be a 7-40 char lowercase hex SHA`)
        } else if (releasedSha && candidate.sha === releasedSha) {
          err(
            `local_candidates.${name}.sha is identical to released.main_sha — a candidate cannot ` +
              `be both released and local-only`,
          )
        }
      }
      if (candidate.status !== undefined) {
        if (!ALLOWED_STATUS_LABELS.includes(candidate.status)) {
          err(
            `local_candidates.${name}.status "${String(candidate.status)}" is not in the fixed ` +
              `vocabulary [${ALLOWED_STATUS_LABELS.join(', ')}] — do not invent a near-duplicate label`,
          )
        }
        if (candidate.status === 'RELEASED') {
          err(
            `local_candidates.${name}.status must not be RELEASED — released work belongs under ` +
              `"released", not "local_candidates" (P176 §8: released vs local must be impossible to confuse)`,
          )
        }
      }
    }
  }

  // ---- database ----
  const database = state.database
  if (!isPlainObject(database)) {
    err('database must be an object')
  } else {
    for (const key of ['released_migration_count', 'latest_local_migration_count']) {
      const v = database[key]
      if (v !== null && !Number.isInteger(v)) {
        err(`database.${key} must be null or an integer`)
      }
    }
    if (
      Number.isInteger(database.released_migration_count) &&
      Number.isInteger(database.latest_local_migration_count) &&
      database.latest_local_migration_count < database.released_migration_count
    ) {
      err('database.latest_local_migration_count is lower than released_migration_count')
    }
  }

  // ---- scanner ----
  const scanner = state.scanner
  if (!isPlainObject(scanner)) {
    err('scanner must be an object')
  } else if (scanner.content_id !== null) {
    if (typeof scanner.content_id !== 'string' || !CONTENT_ID_RE.test(scanner.content_id)) {
      err('scanner.content_id must be null or a 12-20 char lowercase hex id')
    }
  }

  // ---- production ----
  if (!isPlainObject(state.production)) {
    err('production must be an object')
  } else if (typeof state.production.in_real_user_use !== 'boolean') {
    err('production.in_real_user_use must be a boolean')
  }

  // ---- canonical_docs referenced paths must exist ----
  if (state.canonical_docs !== undefined) {
    if (!isPlainObject(state.canonical_docs)) {
      err('canonical_docs must be an object mapping concept -> repo-relative doc path')
    } else {
      for (const [concept, docPath] of Object.entries(state.canonical_docs)) {
        if (typeof docPath !== 'string') {
          err(`canonical_docs.${concept} must be a string path`)
        } else if (!ctx.docExists(docPath)) {
          err(`canonical_docs.${concept} references "${docPath}", which does not exist`)
        }
      }
    }
  }

  // ---- HANDOVER.md must reference this file back ----
  if (typeof ctx.handoverText === 'string') {
    if (!ctx.handoverText.includes('PROJECT_STATE.json')) {
      err(
        'HANDOVER.md does not reference docs/PROJECT_STATE.json — the two must point at each other',
      )
    }
  } else {
    err('HANDOVER.md text was not supplied to the validator (cannot check back-reference)')
  }

  return errors
}
