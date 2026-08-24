/**
 * Pure structural validator / type guard for a parsed M13 JSON backup envelope.
 *
 * Scope: proves the ENVELOPE and the shape of every section (the ROADMAP M13 gate — "a JSON
 * backup round-trips; amounts parse; the version envelope is present"). It validates the FILE,
 * not an import — M13 ships no restore. Deeper semantic validation (row-level field types)
 * happens at build time in build-backup.ts; this guard requires objects for rows and REFUSES
 * unknown data keys outright — the strict v1 policy in backup-format.ts (D-075).
 */
import { BACKUP_DATA_KEYS, BACKUP_FORMAT_ID, type BackupEnvelope } from './backup-format'
import { MANIFEST_COUNT_KEY_PREFIX } from './backup-format'

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
 * - `counts` holds non-negative integers for every expected section
 * - every section, profiles included (0 or 1 rows), is an array of objects
 * - `identity_manifest` carries its two arrays of objects
 * - no unexpected top-level `data` keys (a v1 reader refuses what it cannot name)
 */
export function validateBackupEnvelope(input: unknown): EnvelopeValidationResult {
  if (!isPlainObject(input)) return fail('', 'envelope must be a JSON object')
  if (input['format'] !== BACKUP_FORMAT_ID) return fail('format', `must be "${BACKUP_FORMAT_ID}"`)
  if (input['schema_version'] !== 1) {
    return fail('schema_version', 'this reader understands schema_version 1 only')
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
      return fail(`data.${key}`, 'unknown data key for schema_version 1')
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
  if (!isRowArray(manifest['card_variants'])) {
    return fail('identity_manifest.card_variants', 'must be an array of objects')
  }
  if (!isRowArray(manifest['curated_sealed_products'])) {
    return fail('identity_manifest.curated_sealed_products', 'must be an array of objects')
  }

  // Counts must account for every canonical section and both manifest sections.
  const expectedCountKeys = [
    ...BACKUP_DATA_KEYS.map((key) => key),
    MANIFEST_COUNT_KEY_PREFIX + 'card_variants',
    MANIFEST_COUNT_KEY_PREFIX + 'curated_sealed_products',
  ]
  for (const key of expectedCountKeys) {
    if (typeof counts[key] !== 'number') {
      return fail(`counts.${key}`, 'missing row count for a canonical section')
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
