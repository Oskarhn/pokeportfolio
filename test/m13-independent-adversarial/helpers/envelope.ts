/**
 * The backup ENVELOPE contract (PRODUCT_SPEC §4.12, DECISIONS D-025): a versioned JSON backup
 * carries {format, schema_version, exported_at} so it survives schema evolution; the gate is
 * "the version envelope is present". This validator is written from those documents, not from
 * any implementation, and deliberately REJECTS more than a lazy reader would:
 *
 *  - unknown format string → reject (a renamed format silently breaks forward migration)
 *  - missing/non-integer/<1 schema_version → reject
 *  - exported_at not RFC 3339 UTC (must carry Z or +00:00) → reject
 *  - counts absent or not reconciling with the data sections → reject
 *  - any MUST_EXPORT section MISSING while its count is >0 → reject
 *  - any MUST_NOT_EXPORT table present as a data section → reject (derived-cache trap,
 *    privilege internals, market/system data)
 *  - unknown EXTRA sections → reject under the v1 policy adjudicated at integration (D-075):
 *    version-1 readers refuse unknown versions AND unknown data keys; a future v2 writer
 *    produces v2 files that a future v2 reader owns. Within-v1 "tolerate what you don't know"
 *    was explicitly REJECTED because the v1 validator cannot distinguish a newer writer's key
 *    from corruption of a known one.
 */

import {
  EXPORT_INVENTORY,
  mustExportTables,
  mustNotExportTables,
  type TableSpec,
} from './inventory.ts'

export const REQUIRED_BACKUP_FORMAT = 'pokeportfolio-backup'
export const MIN_SCHEMA_VERSION = 1

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|\+00:00)$/

export interface ValidationIssue {
  readonly severity: 'violation' | 'warning'
  readonly message: string
}

export interface EnvelopeShape {
  readonly format?: unknown
  readonly schema_version?: unknown
  readonly exported_at?: unknown
  readonly app_version?: unknown
  readonly counts?: unknown
  readonly data?: unknown
}

export function validateBackupEnvelope(raw: unknown): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (typeof raw !== 'object' || raw === null) {
    return [{ severity: 'violation', message: 'backup root is not a JSON object' }]
  }
  const env = raw as EnvelopeShape

  if (env.format !== REQUIRED_BACKUP_FORMAT) {
    issues.push({
      severity: 'violation',
      message: `format must be exactly "${REQUIRED_BACKUP_FORMAT}", got ${JSON.stringify(env.format)}`,
    })
  }

  if (
    typeof env.schema_version !== 'number' ||
    !Number.isInteger(env.schema_version) ||
    env.schema_version < MIN_SCHEMA_VERSION
  ) {
    issues.push({
      severity: 'violation',
      message: `schema_version must be an integer >= ${MIN_SCHEMA_VERSION}, got ${JSON.stringify(env.schema_version)}`,
    })
  }

  if (typeof env.exported_at !== 'string' || !RFC3339_UTC.test(env.exported_at)) {
    issues.push({
      severity: 'violation',
      message:
        'exported_at must be an RFC 3339 UTC timestamp with Z or +00:00 offset, got ' +
        JSON.stringify(env.exported_at),
    })
  } else if (Number.isNaN(Date.parse(env.exported_at))) {
    issues.push({
      severity: 'violation',
      message: 'exported_at does not parse as a date: ' + env.exported_at,
    })
  }

  if (typeof env.data !== 'object' || env.data === null) {
    issues.push({ severity: 'violation', message: 'data object missing' })
    return issues
  }
  const data = env.data as Record<string, unknown>

  // Every MUST_EXPORT section PRESENT (possibly empty array). A missing section is ambiguous
  // with "user had none of these" — restore cannot take that risk (prompt §5).
  for (const spec of mustExportTables()) {
    const section = data[spec.table]
    if (!Array.isArray(section)) {
      issues.push({
        severity: 'violation',
        message: `data.${spec.table} missing or not an array — absence must be an explicit empty array`,
      })
    }
  }

  // Derived-cache trap and friends: no excluded table may appear at all.
  for (const table of mustNotExportTables()) {
    if (data[table] !== undefined) {
      issues.push({
        severity: 'violation',
        message: `data.${table} present but this table is MUST_NOT_EXPORT (${reasonOf(table)})`,
      })
    }
  }

  // Counts reconcile when provided.
  if (env.counts !== undefined) {
    if (typeof env.counts !== 'object' || env.counts === null) {
      issues.push({ severity: 'violation', message: 'counts must be an object when present' })
    } else {
      const counts = env.counts as Record<string, unknown>
      for (const spec of mustExportTables()) {
        const declared = counts[spec.table]
        const actual = Array.isArray(data[spec.table])
          ? (data[spec.table] as unknown[]).length
          : undefined
        if (declared === undefined && actual !== undefined) {
          issues.push({
            severity: 'violation',
            message: `counts.${spec.table} missing while data.${spec.table} exists`,
          })
          continue
        }
        if (typeof declared === 'number' && actual !== undefined && declared !== actual) {
          issues.push({
            severity: 'violation',
            message: `counts.${spec.table}=${String(declared)} disagrees with data length ${String(actual)}`,
          })
        }
      }
    }
  } else {
    issues.push({ severity: 'violation', message: 'counts object missing' })
  }

  // Unknown sections: VIOLATION under the adjudicated v1 policy (D-075). The v1 reader
  // refuses unknown versions and unknown data keys alike; evolution goes through a
  // schema_version bump, not through silently tolerated extra sections.
  const known = new Set(EXPORT_INVENTORY.map((s) => s.table))
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      issues.push({
        severity: 'violation',
        message:
          `unknown data section "${key}" — v1 readers refuse keys they do not know (D-075); ` +
          'a new canonical section requires a schema_version bump',
      })
    }
  }

  return issues
}

export function hasViolations(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'violation')
}

function reasonOf(table: string): string {
  const spec: TableSpec | undefined = EXPORT_INVENTORY.find((s) => s.table === table)
  return spec?.reason ?? 'unclassified'
}
