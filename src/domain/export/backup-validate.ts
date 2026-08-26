/**
 * Pure structural validator / type guard for a parsed M13 JSON backup envelope.
 *
 * Scope: proves the ENVELOPE and the shape of every section (the ROADMAP M13 gate — "a JSON
 * backup round-trips; amounts parse; the version envelope is present"). It validates the FILE,
 * not an import — M13 ships no restore. Deeper semantic validation (row-level field types)
 * happens at build time in build-backup.ts; this guard requires objects for rows and REFUSES
 * unknown data keys outright — the strict v1 policy in backup-format.ts (D-076).
 */
import {
  BACKUP_DATA_KEYS,
  BACKUP_FORMAT_ID,
  BACKUP_SCHEMA_VERSION,
  type BackupEnvelope,
} from './backup-format'
import { MANIFEST_COUNT_KEY_PREFIX } from './backup-format'

/** Identity-manifest section names, in canonical order. */
const MANIFEST_SECTIONS = ['card_variants', 'curated_sealed_products', 'card_sets'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((row) => isPlainObject(row))
}

export interface EnvelopeValidationFailure {
  /** Dotted path of the first structural problem found. */
  readonly path: string
  readonly problem: string
}

export interface EnvelopeValidationResult {
  readonly valid: boolean
  readonly failure: EnvelopeValidationFailure | null
}

function fail(path: string, problem: string): EnvelopeValidationResult {
  return { valid: false, failure: { path, problem } }
}

/**
 * Validates envelope structure without throwing. Returns the first structural failure, or
 * `{ valid: true, failure: null }`. Checks:
 *
 * - `format` equals the stable format identifier
 * - `schema_version` is exactly the version this module understands
 * - `exported_at` parses as an ISO instant ending in Z (UTC)
 * - `app.version` is a string
 * - `counts` holds non-negative integers for every expected section AND each equals the actual
 *   length of the array it names (counts are integrity metadata, not decoration)
 * - every section, profiles included (0 or 1 rows), is an array of objects
 * - `identity_manifest` carries its three arrays of objects and nothing else
 * - no unexpected top-level `data` keys (a v1 reader refuses what it cannot name)
 */
export function validateBackupEnvelope(input: unknown): EnvelopeValidationResult {
  if (!isPlainObject(input)) return fail('', 'envelope must be a JSON object')
  if (input['format'] !== BACKUP_FORMAT_ID) return fail('format', `must be "${BACKUP_FORMAT_ID}"`)
  if (input['schema_version'] !== BACKUP_SCHEMA_VERSION) {
    return fail(
      'schema_version',
      `this reader understands schema_version ${BACKUP_SCHEMA_VERSION} only — a v1 file is a ` +
        'pre-Openings artifact, and a post-M16 writer must never produce one',
    )
  }

  const exportedAt = input['exported_at']
  if (
    typeof exportedAt !== 'string' ||
    !/Z$/.test(exportedAt) ||
    Number.isNaN(Date.parse(exportedAt))
  ) {
    return fail('exported_at', 'must be an RFC 3339 UTC timestamp ending in Z')
  }

  const app = input['app']
  if (!isPlainObject(app) || typeof app['version'] !== 'string') {
    return fail('app.version', 'must be a string')
  }

  const counts = input['counts']
  if (!isPlainObject(counts)) return fail('counts', 'must be an object')
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return fail(`counts.${key}`, 'must be a non-negative integer')
    }
  }

  const data = input['data']
  if (!isPlainObject(data)) return fail('data', 'must be an object')
  const presentKeys = Object.keys(data)
  for (const key of presentKeys) {
    if (!(BACKUP_DATA_KEYS as readonly string[]).includes(key)) {
      return fail(`data.${key}`, `unknown data key for schema_version ${BACKUP_SCHEMA_VERSION}`)
    }
  }
  for (const key of BACKUP_DATA_KEYS) {
    const section = data[key]
    if (!isRowArray(section)) {
      return fail(`data.${key}`, 'must be an array of objects')
    }
  }

  const manifest = input['identity_manifest']
  if (!isPlainObject(manifest)) return fail('identity_manifest', 'must be an object')
  for (const key of Object.keys(manifest)) {
    if (!(MANIFEST_SECTIONS as readonly string[]).includes(key)) {
      return fail(
        `identity_manifest.${key}`,
        `unknown manifest section for schema_version ${BACKUP_SCHEMA_VERSION}`,
      )
    }
  }
  for (const key of MANIFEST_SECTIONS) {
    if (!isRowArray(manifest[key])) {
      return fail(`identity_manifest.${key}`, 'must be an array of objects')
    }
  }

  // Counts must account for every canonical section and every manifest section.
  const expectedCountKeys = [
    ...BACKUP_DATA_KEYS.map((key) => key),
    ...MANIFEST_SECTIONS.map((key) => MANIFEST_COUNT_KEY_PREFIX + key),
  ]
  for (const key of expectedCountKeys) {
    if (typeof counts[key] !== 'number') {
      return fail(`counts.${key}`, 'missing row count for a canonical section')
    }
  }
  // Counts are integrity metadata: each must equal the actual length of the array it names.
  // A corrupted or truncated envelope (counts.tags=100 over zero rows) can no longer validate.
  for (const key of Object.keys(counts)) {
    if (!expectedCountKeys.includes(key)) {
      return fail(`counts.${key}`, 'count for a section this schema_version does not carry')
    }
  }
  for (const key of BACKUP_DATA_KEYS) {
    if (counts[key] !== (data[key] as unknown[]).length) {
      return fail(`counts.${key}`, `does not match the ${key} array length`)
    }
  }
  for (const key of MANIFEST_SECTIONS) {
    const manifestKey = MANIFEST_COUNT_KEY_PREFIX + key
    if (counts[manifestKey] !== (manifest[key] as unknown[]).length) {
      return fail(`counts.${manifestKey}`, `does not match the ${key} array length`)
    }
  }

  return { valid: true, failure: null }
}

/** Type-guard convenience over {@link validateBackupEnvelope}; throws on invalid input. */
export function assertBackupEnvelope(input: unknown): asserts input is BackupEnvelope {
  const result = validateBackupEnvelope(input)
  if (!result.valid) {
    throw new Error(
      `Invalid backup envelope at ${result.failure?.path ?? '?'}: ${result.failure?.problem ?? '?'}`,
    )
  }
}
