/**
 * Full logical backup of a Supabase Postgres database (P131, replaces the schema-only
 * `pnpm db:dump` found in P130-06).
 *
 * `supabase db dump` without flags dumps SCHEMA only. A backup that is meant to protect real data
 * therefore needs five separate dumps — the shape Supabase documents for moving a project and the
 * shape P127 produced by hand for the M15 hosted migration:
 *
 *   roles.sql                      cluster roles (--role-only)
 *   schema.sql                     application schema (default mode)
 *   data.sql                       application + auth data (--data-only --use-copy)
 *   migration_history_schema.sql   supabase_migrations schema (excluded from the default dump)
 *   migration_history_data.sql     supabase_migrations rows (--data-only --use-copy)
 *
 * Everything here fails closed: a non-zero CLI exit, a missing or zero-byte file, a data file that
 * contains no COPY blocks (i.e. a schema-only dump written under the data name), a missing required
 * table, an empty migration history or a hash mismatch all make the whole backup FAIL. A backup
 * directory only counts as complete when it has been renamed from `<stamp>.incomplete` to
 * `<stamp>`, carries a `status: "complete"` manifest and a BACKUP_COMPLETE marker whose content is
 * the manifest's SHA-256, and re-verifies from disk after the rename.
 *
 * This module is BACKUP only. Restoring these files with a plain psql replay produces an insecure
 * database (P130-07: invite-gate triggers lost, broad default grants, cron/Vault missing). Restore
 * requires the dedicated secured restore runbook, which does not exist yet.
 *
 * The CLI invocation is injected (`DumpRunner`) so the fail-closed paths are unit-testable without
 * Docker; scripts/db-backup/run-backup.ts wires the real pinned Supabase CLI in, and
 * scripts/db-backup/local-regression.ts proves the real CLI output against a disposable database.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export const BACKUP_TOOL_VERSION = 1
export const COMPLETE_MARKER = 'BACKUP_COMPLETE'
export const MANIFEST_FILE = 'manifest.json'
export const README_FILE = 'README.txt'

export type ArtifactKind =
  'roles' | 'schema' | 'data' | 'migration_history_schema' | 'migration_history_data'

export interface ArtifactSpec {
  readonly kind: ArtifactKind
  readonly file: string
  /** Flags appended after `db dump <target flags>`; `-f <path>` is added by the orchestrator. */
  readonly dumpArgs: readonly string[]
}

// storage.buckets_vectors / storage.vector_indexes are excluded from the data dump exactly as
// Supabase's backup-restore guide does: they are platform-managed and fail to COPY on restore.
export const ARTIFACTS: readonly ArtifactSpec[] = [
  { kind: 'roles', file: 'roles.sql', dumpArgs: ['--role-only'] },
  { kind: 'schema', file: 'schema.sql', dumpArgs: [] },
  {
    kind: 'data',
    file: 'data.sql',
    dumpArgs: [
      '--data-only',
      '--use-copy',
      '-x',
      'storage.buckets_vectors',
      '-x',
      'storage.vector_indexes',
    ],
  },
  {
    kind: 'migration_history_schema',
    file: 'migration_history_schema.sql',
    dumpArgs: ['--schema', 'supabase_migrations'],
  },
  {
    kind: 'migration_history_data',
    file: 'migration_history_data.sql',
    dumpArgs: ['--data-only', '--use-copy', '--schema', 'supabase_migrations'],
  },
]

/**
 * Tables whose presence in data.sql (a COPY block, possibly with zero rows) is required; the
 * `public.*` ones must also have a CREATE TABLE in schema.sql. A COPY block is emitted for every dumped table even when it is empty, so
 * requiring the block proves the table was covered by a data dump without assuming it holds rows.
 * auth.users is included because every ledger row references it — data without users cannot be
 * restored.
 */
export const DEFAULT_REQUIRED_TABLES: readonly string[] = [
  'auth.users',
  'public.profiles',
  'public.purchases',
  'public.purchase_lines',
  'public.holdings',
  'public.acquisition_lots',
  'public.lot_disposals',
  'public.sales',
  'public.sale_lines',
  'public.openings',
]

export const MIGRATION_HISTORY_TABLE = 'supabase_migrations.schema_migrations'

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

// ── Secret hygiene ──────────────────────────────────────────────────────────────────────────────

/**
 * Removes credentials from text that may be echoed from the CLI (errors can include the
 * connection string). Applied to every CLI-derived string before it reaches a log or a manifest.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/\bsbp_[A-Za-z0-9]{10,}\b/g, 'sbp_***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***jwt***')
    .replace(/(password[=:]\s*)\S+/gi, '$1***')
}

// ── Target identity ─────────────────────────────────────────────────────────────────────────────

export type BackupTarget =
  | { readonly kind: 'linked'; readonly projectRef: string }
  | { readonly kind: 'db-url'; readonly dbUrl: string }

export interface TargetIdentity {
  readonly kind: BackupTarget['kind']
  /** First 16 hex chars of SHA-256 over the non-secret identity string. */
  readonly fingerprint: string
  /** Human-recognisable but non-secret label; never contains credentials. */
  readonly label: string
}

const PROJECT_REF_PATTERN = /^[a-z]{20}$/

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function establishTargetIdentity(target: BackupTarget): TargetIdentity {
  if (target.kind === 'linked') {
    const ref = target.projectRef.trim()
    if (!PROJECT_REF_PATTERN.test(ref)) {
      throw new BackupError(
        'cannot establish project identity: linked project ref is missing or malformed ' +
          '(expected supabase/.temp/project-ref to hold a 20-letter ref; run `supabase link`)',
      )
    }
    return {
      kind: 'linked',
      fingerprint: sha256Hex(`linked:${ref}`).slice(0, 16),
      label: `linked project ${ref.slice(0, 4)}…${ref.slice(-3)}`,
    }
  }
  let url: URL
  try {
    url = new URL(target.dbUrl)
  } catch {
    throw new BackupError('cannot establish database identity: --db-url is not a valid URL')
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || url.hostname === '') {
    throw new BackupError(
      'cannot establish database identity: --db-url must be a postgres:// URL with a host',
    )
  }
  const database = url.pathname.replace(/^\//, '') || 'postgres'
  const port = url.port || '5432'
  return {
    kind: 'db-url',
    fingerprint: sha256Hex(`db-url:${url.hostname}:${port}/${database}`).slice(0, 16),
    label: `database on ${url.hostname}:${port}/${database}`,
  }
}

export function targetDumpArgs(target: BackupTarget): string[] {
  return target.kind === 'linked'
    ? ['db', 'dump', '--linked']
    : ['db', 'dump', '--db-url', target.dbUrl]
}

// ── Output location safety ──────────────────────────────────────────────────────────────────────

export type GitLocationProbe = (existingDir: string) => Promise<'inside' | 'outside'>

export interface LocationPolicy {
  readonly probe: GitLocationProbe
  /** Explicit override: allow a location inside a git work tree ONLY when git ignores it. */
  readonly allowIgnoredInsideGit?: boolean
  readonly isGitIgnored?: (path: string) => Promise<boolean>
}

function nearestExistingAncestor(path: string): string {
  let current = resolve(path)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Refuses an output root inside any git work tree (this repository, a worktree, or any other
 * checkout) — a dump there is one `git add -A` away from being committed. The probe runs on the
 * nearest existing ancestor so a not-yet-created root is judged by where it would be created.
 */
export async function assertSafeOutputRoot(outRoot: string, policy: LocationPolicy): Promise<void> {
  const ancestor = nearestExistingAncestor(outRoot)
  const where = await policy.probe(ancestor)
  if (where === 'outside') return
  if (policy.allowIgnoredInsideGit === true && policy.isGitIgnored !== undefined) {
    if (await policy.isGitIgnored(resolve(outRoot))) return
    throw new BackupError(
      `refusing output root inside a git work tree that git does not ignore: ${outRoot}`,
    )
  }
  throw new BackupError(
    `refusing output root inside a git work tree: ${outRoot} — backups contain real data and ` +
      'must live outside every repository checkout',
  )
}

// ── SQL artifact inspection ─────────────────────────────────────────────────────────────────────

export interface CopyBlockSummary {
  /** `schema.table` → data rows between `COPY … FROM stdin;` and `\.` */
  readonly tables: ReadonlyMap<string, number>
  readonly totalRows: number
}

const COPY_START =
  /^COPY\s+"?([A-Za-z0-9_]+)"?\."?([A-Za-z0-9_]+)"?\s*(\([^)]*\))?\s+FROM\s+stdin;\s*$/

export function parseCopyBlocks(sql: string): CopyBlockSummary {
  const tables = new Map<string, number>()
  let current: string | null = null
  let rows = 0
  let totalRows = 0
  for (const line of sql.split(/\r?\n/)) {
    if (current === null) {
      const match = COPY_START.exec(line)
      if (match) {
        current = `${match[1] ?? ''}.${match[2] ?? ''}`
        rows = 0
      }
      continue
    }
    if (line === '\\.') {
      tables.set(current, (tables.get(current) ?? 0) + rows)
      totalRows += rows
      current = null
      continue
    }
    rows += 1
  }
  if (current !== null) {
    throw new BackupError(`unterminated COPY block for ${current} (truncated dump?)`)
  }
  return { tables, totalRows }
}

function createTablePattern(qualified: string): RegExp {
  const [schema, table] = qualified.split('.')
  return new RegExp(`CREATE TABLE (IF NOT EXISTS )?"?${schema ?? ''}"?\\."?${table ?? ''}"?[\\s(]`)
}

const ANY_CREATE_TABLE = /^CREATE TABLE /m

export interface ArtifactFacts {
  readonly copyTables?: number
  readonly copyRows?: number
  readonly requiredTableRows?: Readonly<Record<string, number>>
  readonly migrationHistoryRows?: number
}

/** Validates one artifact's content for its kind; throws BackupError on anything suspicious. */
export function validateArtifactContent(
  kind: ArtifactKind,
  sql: string,
  requiredTables: readonly string[],
): ArtifactFacts {
  const copies = parseCopyBlocks(sql)
  switch (kind) {
    case 'roles': {
      if (copies.tables.size > 0) throw new BackupError('roles.sql unexpectedly contains COPY data')
      return {}
    }
    case 'schema': {
      if (copies.tables.size > 0) {
        throw new BackupError('schema.sql unexpectedly contains COPY data (wrong dump mode)')
      }
      // Supabase-managed schemas (auth, storage, …) are excluded from the schema dump by design —
      // the platform recreates them — so only application tables are required here.
      for (const table of requiredTables.filter((t) => t.startsWith('public.'))) {
        if (!createTablePattern(table).test(sql)) {
          throw new BackupError(`schema.sql has no CREATE TABLE for required table ${table}`)
        }
      }
      return {}
    }
    case 'data': {
      if (copies.tables.size === 0) {
        throw new BackupError(
          'data.sql contains no COPY data blocks — this is a schema-only dump, not a data backup',
        )
      }
      if (ANY_CREATE_TABLE.test(sql)) {
        throw new BackupError('data.sql contains CREATE TABLE statements (not a data-only dump)')
      }
      const requiredTableRows: Record<string, number> = {}
      for (const table of requiredTables) {
        const rows = copies.tables.get(table)
        if (rows === undefined) {
          throw new BackupError(`data.sql has no COPY block for required table ${table}`)
        }
        requiredTableRows[table] = rows
      }
      return { copyTables: copies.tables.size, copyRows: copies.totalRows, requiredTableRows }
    }
    case 'migration_history_schema': {
      if (!createTablePattern(MIGRATION_HISTORY_TABLE).test(sql)) {
        throw new BackupError(
          'migration_history_schema.sql has no CREATE TABLE supabase_migrations.schema_migrations',
        )
      }
      return {}
    }
    case 'migration_history_data': {
      const rows = copies.tables.get(MIGRATION_HISTORY_TABLE)
      if (rows === undefined) {
        throw new BackupError(
          'migration_history_data.sql has no COPY block for supabase_migrations.schema_migrations',
        )
      }
      if (rows === 0) {
        throw new BackupError('migration history is empty — refusing to call this a full backup')
      }
      return { migrationHistoryRows: rows }
    }
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────────────────────────

export interface ManifestArtifact extends ArtifactFacts {
  readonly kind: ArtifactKind
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

export interface BackupManifest {
  readonly tool: 'pokeportfolio-db-backup'
  readonly toolVersion: number
  readonly status: 'complete' | 'failed'
  readonly startedAtUtc: string
  readonly finishedAtUtc: string
  readonly target: TargetIdentity
  readonly supabaseCliVersion: string
  readonly nodeVersion: string
  readonly requiredTables: readonly string[]
  readonly artifacts: readonly ManifestArtifact[]
  readonly migrationHistoryRows: number | null
  readonly localMigrationFiles: number | null
  readonly error: string | null
  readonly restoreNote: string
}

export const RESTORE_NOTE =
  'BACKUP ONLY. Do not restore these files with a plain psql replay: that yields an insecure ' +
  'database (invite-gate triggers lost, broad default grants, cron/Vault/auth hook missing — ' +
  'P130-07). Restore requires the dedicated secured restore runbook and its validation gates.'

export function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

function readmeText(manifest: BackupManifest): string {
  const lines = [
    'PokePortfolio private database backup',
    '=====================================',
    '',
    'PRIVATE: contains real user data. Never commit, never upload to a shared location.',
    '',
    `Status:  ${manifest.status}`,
    `Started: ${manifest.startedAtUtc}`,
    `Target:  ${manifest.target.label} (fingerprint ${manifest.target.fingerprint})`,
    '',
    'Files (sizes and SHA-256 in manifest.json):',
    ...manifest.artifacts.map((a) => `  ${a.file}`),
    '',
    'Verify integrity before relying on it:',
    '  pnpm db:backup --verify "<this directory>"',
    '',
    RESTORE_NOTE,
    '',
  ]
  return lines.join('\n')
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────────

export type DumpRunner = (args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>

export interface RunBackupOptions {
  readonly outRoot: string
  readonly target: BackupTarget
  readonly runDump: DumpRunner
  readonly supabaseCliVersion: string
  readonly location: LocationPolicy
  readonly requiredTables?: readonly string[]
  readonly localMigrationFiles?: number | null
  /** When set, the backup fails unless the dumped migration history has exactly this many rows. */
  readonly expectMigrationHistoryRows?: number
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

export interface BackupOutcome {
  readonly ok: boolean
  /** Final directory: `<stamp>` on success, `<stamp>.FAILED` on failure (null if never created). */
  readonly directory: string | null
  readonly manifest: BackupManifest | null
  readonly error: string | null
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

export async function runBackup(options: RunBackupOptions): Promise<BackupOutcome> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? (() => undefined)
  const requiredTables = options.requiredTables ?? DEFAULT_REQUIRED_TABLES
  const started = now()

  let identity: TargetIdentity
  try {
    identity = establishTargetIdentity(options.target)
    await assertSafeOutputRoot(options.outRoot, options.location)
  } catch (error) {
    return { ok: false, directory: null, manifest: null, error: messageOf(error) }
  }

  const stamp = utcStamp(started)
  const outRoot = resolve(options.outRoot)
  const staging = join(outRoot, `${stamp}.incomplete`)
  const finalDir = join(outRoot, stamp)
  const failedDir = join(outRoot, `${stamp}.FAILED`)
  for (const candidate of [staging, finalDir, failedDir]) {
    if (existsSync(candidate)) {
      return {
        ok: false,
        directory: null,
        manifest: null,
        error: `backup directory already exists: ${candidate}`,
      }
    }
  }
  await mkdir(staging, { recursive: true })

  const artifacts: ManifestArtifact[] = []
  const baseManifest = {
    tool: 'pokeportfolio-db-backup' as const,
    toolVersion: BACKUP_TOOL_VERSION,
    startedAtUtc: started.toISOString(),
    target: identity,
    supabaseCliVersion: options.supabaseCliVersion,
    nodeVersion: process.version,
    requiredTables,
    localMigrationFiles: options.localMigrationFiles ?? null,
    restoreNote: RESTORE_NOTE,
  }

  try {
    for (const spec of ARTIFACTS) {
      const path = join(staging, spec.file)
      log(`dumping ${spec.kind} → ${spec.file}`)
      const result = await options.runDump([
        ...targetDumpArgs(options.target),
        ...spec.dumpArgs,
        '-f',
        path,
      ])
      if (result.exitCode !== 0) {
        const detail = redactSecrets(result.stderr).trim().split(/\r?\n/).slice(-5).join(' | ')
        throw new BackupError(
          `${spec.kind} dump failed (supabase CLI exit ${result.exitCode})${detail ? `: ${detail}` : ''}`,
        )
      }
      const bytes = await fileBytes(path)
      if (bytes < 0) throw new BackupError(`${spec.file} was not written`)
      if (bytes === 0) throw new BackupError(`${spec.file} is zero bytes`)
      const content = await readFile(path)
      const facts = validateArtifactContent(spec.kind, content.toString('utf8'), requiredTables)
      artifacts.push({
        kind: spec.kind,
        file: spec.file,
        bytes,
        sha256: sha256Hex(content),
        ...facts,
      })
    }

    const historyRows =
      artifacts.find((a) => a.kind === 'migration_history_data')?.migrationHistoryRows ?? null
    if (
      options.expectMigrationHistoryRows !== undefined &&
      historyRows !== options.expectMigrationHistoryRows
    ) {
      throw new BackupError(
        `migration history has ${historyRows ?? 'no'} rows, expected ${options.expectMigrationHistoryRows}`,
      )
    }

    const manifest: BackupManifest = {
      ...baseManifest,
      status: 'complete',
      finishedAtUtc: now().toISOString(),
      artifacts,
      migrationHistoryRows: historyRows,
      error: null,
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(join(staging, MANIFEST_FILE), manifestText, 'utf8')
    await writeFile(join(staging, README_FILE), readmeText(manifest), 'utf8')
    // Hashes are re-read from disk before the directory is promoted, not trusted from memory.
    await verifyBackupDirectory(staging, { requiredTables, requireMarker: false })
    await writeFile(join(staging, COMPLETE_MARKER), `${sha256Hex(manifestText)}\n`, 'utf8')
    await rename(staging, finalDir)
    await verifyBackupDirectory(finalDir, { requiredTables })
    log(`backup complete: ${finalDir}`)
    return { ok: true, directory: finalDir, manifest, error: null }
  } catch (error) {
    const message = redactSecrets(messageOf(error))
    const manifest: BackupManifest = {
      ...baseManifest,
      status: 'failed',
      finishedAtUtc: now().toISOString(),
      artifacts,
      migrationHistoryRows: null,
      error: message,
    }
    let directory: string | null = null
    try {
      const source = existsSync(staging) ? staging : existsSync(finalDir) ? finalDir : null
      if (source !== null) {
        const markerPath = join(source, COMPLETE_MARKER)
        if (existsSync(markerPath)) await writeFile(markerPath, 'INVALIDATED\n', 'utf8')
        await writeFile(join(source, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
        await rename(source, failedDir)
        directory = failedDir
      }
    } catch {
      // The failure itself is what gets reported; a leftover `.incomplete` directory is never
      // mistaken for a backup because it has no complete manifest and no valid marker.
      directory = existsSync(staging) ? staging : null
    }
    log(`BACKUP FAILED: ${message}`)
    return { ok: false, directory, manifest, error: message }
  }
}

// ── Verification of an existing directory ───────────────────────────────────────────────────────

export interface VerifyOptions {
  readonly requiredTables?: readonly string[]
  /** Internal: the staging pass runs before the marker exists. */
  readonly requireMarker?: boolean
}

export async function verifyBackupDirectory(
  directory: string,
  options: VerifyOptions = {},
): Promise<BackupManifest> {
  const requireMarker = options.requireMarker ?? true
  const manifestPath = join(directory, MANIFEST_FILE)
  if (!existsSync(manifestPath)) throw new BackupError(`no ${MANIFEST_FILE} in ${directory}`)
  const manifestText = await readFile(manifestPath, 'utf8')
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(manifestText) as BackupManifest
  } catch {
    throw new BackupError(`${MANIFEST_FILE} is not valid JSON`)
  }
  if (manifest.status !== 'complete') {
    throw new BackupError(`manifest status is "${manifest.status}", not "complete"`)
  }
  if (requireMarker) {
    const markerPath = join(directory, COMPLETE_MARKER)
    if (!existsSync(markerPath)) throw new BackupError(`${COMPLETE_MARKER} marker is missing`)
    const marker = (await readFile(markerPath, 'utf8')).trim()
    if (marker !== sha256Hex(manifestText)) {
      throw new BackupError(`${COMPLETE_MARKER} does not match manifest.json (manifest edited?)`)
    }
  }
  const requiredTables = options.requiredTables ?? manifest.requiredTables
  const present = new Set(await readdir(directory))
  for (const spec of ARTIFACTS) {
    const entry = manifest.artifacts.find((a) => a.kind === spec.kind)
    if (entry?.file !== spec.file) {
      throw new BackupError(`manifest does not list required artifact ${spec.file}`)
    }
    if (!present.has(spec.file)) throw new BackupError(`required artifact ${spec.file} is missing`)
    const content = await readFile(join(directory, spec.file))
    if (content.byteLength === 0) throw new BackupError(`${spec.file} is zero bytes`)
    if (content.byteLength !== entry.bytes) {
      throw new BackupError(`${spec.file} size ${content.byteLength} != manifest ${entry.bytes}`)
    }
    if (sha256Hex(content) !== entry.sha256) {
      throw new BackupError(`${spec.file} SHA-256 does not match manifest`)
    }
    validateArtifactContent(spec.kind, content.toString('utf8'), requiredTables)
  }
  return manifest
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
