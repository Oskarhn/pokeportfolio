/**
 * P131 / P130-06: the full-backup tool fails closed. Exercised against REAL temp directories with
 * an injected dump runner standing in for the Supabase CLI, so every failure path (CLI exit,
 * zero-byte file, schema-only data, missing history, hash tamper, unsafe location, secret leak)
 * is deterministic and needs no Docker. The same core is proven against the real CLI output by
 * `pnpm db:backup:regression`.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ARTIFACTS,
  type ArtifactKind,
  COMPLETE_MARKER,
  DEFAULT_REQUIRED_TABLES,
  type DumpRunner,
  type LocationPolicy,
  MANIFEST_FILE,
  parseCopyBlocks,
  redactSecrets,
  runBackup,
  type RunBackupOptions,
  validateArtifactContent,
  verifyBackupDirectory,
} from '../../scripts/db-backup/backup-core'
import { gitLocationProbe, REPO_ROOT } from '../../scripts/db-backup/supabase-cli'

const SCHEMA_SQL = [
  '-- PostgreSQL database dump',
  'SET statement_timeout = 0;',
  ...DEFAULT_REQUIRED_TABLES.map((qualified) => {
    const [schema, table] = qualified.split('.')
    return `CREATE TABLE IF NOT EXISTS "${schema ?? ''}"."${table ?? ''}" (\n    "id" "uuid" NOT NULL\n);`
  }),
  '',
].join('\n')

function copyBlock(qualified: string, rows: readonly string[]): string {
  const [schema, table] = qualified.split('.')
  return [`COPY "${schema ?? ''}"."${table ?? ''}" ("id") FROM stdin;`, ...rows, '\\.', ''].join(
    '\n',
  )
}

const DATA_SQL = [
  'SET session_replication_role = replica;',
  ...DEFAULT_REQUIRED_TABLES.map((table) =>
    copyBlock(
      table,
      table === 'public.acquisition_lots'
        ? ['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']
        : [],
    ),
  ),
  'RESET ALL;',
  '',
].join('\n')

const HISTORY_SCHEMA_SQL =
  'CREATE SCHEMA IF NOT EXISTS "supabase_migrations";\n' +
  'CREATE TABLE IF NOT EXISTS "supabase_migrations"."schema_migrations" (\n    "version" "text" NOT NULL\n);\n'

const HISTORY_DATA_SQL = copyBlock('supabase_migrations.schema_migrations', [
  '20260817120000',
  '20260817120010',
  '20260817120020',
])

const ROLES_SQL = '-- roles\nSET default_transaction_read_only = off;\n'

const GOOD: Record<ArtifactKind, string> = {
  roles: ROLES_SQL,
  schema: SCHEMA_SQL,
  data: DATA_SQL,
  migration_history_schema: HISTORY_SCHEMA_SQL,
  migration_history_data: HISTORY_DATA_SQL,
}

interface FakeRunnerOptions {
  content?: Partial<Record<ArtifactKind, string>>
  exitCode?: Partial<Record<ArtifactKind, number>>
  stderr?: string
  skipWrite?: ArtifactKind
}

function kindForPath(path: string): ArtifactKind {
  const spec = ARTIFACTS.find((a) => a.file === basename(path))
  if (!spec) throw new Error(`unexpected dump path ${path}`)
  return spec.kind
}

function fakeRunner(options: FakeRunnerOptions = {}): DumpRunner & { calls: string[][] } {
  const calls: string[][] = []
  const runner = (args: readonly string[]) => {
    calls.push([...args])
    const path = args[args.indexOf('-f') + 1] ?? ''
    const kind = kindForPath(path)
    if (options.skipWrite !== kind) {
      writeFileSync(path, options.content?.[kind] ?? GOOD[kind])
    }
    return Promise.resolve({
      exitCode: options.exitCode?.[kind] ?? 0,
      stderr: options.stderr ?? '',
    })
  }
  return Object.assign(runner, { calls })
}

// Built at runtime (see the redaction test) so no credential-shaped literal lives in source.
const FAKE_PASSWORD_A = ['hunter2', 'secret'].join('-')
const FAKE_PASSWORD_B = ['sUp3r', 's3cret'].join('-')

const outsideGit: LocationPolicy = { probe: () => Promise.resolve('outside') }

let root: string
let tick = 0

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pp backup test '))
  tick = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function options(overrides: Partial<RunBackupOptions> = {}): RunBackupOptions {
  return {
    outRoot: join(root, 'Pokemonapp prosjekt backups'),
    target: { kind: 'linked', projectRef: 'abcdefghijklmnopqrst' },
    runDump: fakeRunner(),
    supabaseCliVersion: '2.114.0',
    location: outsideGit,
    now: () => new Date(Date.UTC(2026, 8, 14, 10, 0, tick++)),
    ...overrides,
  }
}

function listRoot(outcomeRoot: string): string[] {
  return existsSync(outcomeRoot) ? readdirSync(outcomeRoot) : []
}

describe('full backup — success path', () => {
  it('writes all five artifacts, a complete manifest and a marker, in a path with spaces', async () => {
    const runner = fakeRunner()
    const opts = options({ runDump: runner, localMigrationFiles: 3, expectMigrationHistoryRows: 3 })
    const outcome = await runBackup(opts)

    expect(outcome.error).toBeNull()
    expect(outcome.ok).toBe(true)
    expect(outcome.directory).toBe(join(opts.outRoot, '20260914T100000Z'))
    expect(listRoot(opts.outRoot)).toEqual(['20260914T100000Z'])

    const dir = outcome.directory ?? ''
    for (const spec of ARTIFACTS) expect(existsSync(join(dir, spec.file))).toBe(true)
    expect(existsSync(join(dir, COMPLETE_MARKER))).toBe(true)
    expect(existsSync(join(dir, 'README.txt'))).toBe(true)

    const manifest = await verifyBackupDirectory(dir)
    expect(manifest.status).toBe('complete')
    expect(manifest.migrationHistoryRows).toBe(3)
    const data = manifest.artifacts.find((a) => a.kind === 'data')
    expect(data?.requiredTableRows?.['public.acquisition_lots']).toBe(2)

    // Each dump is one argv entry per path — the space-containing path is never split.
    const dataCall = runner.calls.find(
      (call) => call.includes('--data-only') && !call.includes('--schema'),
    )
    expect(dataCall).toEqual(
      expect.arrayContaining([
        'db',
        'dump',
        '--linked',
        '--use-copy',
        join(dir.replace(/Z$/, 'Z.incomplete'), 'data.sql'),
      ]),
    )
    expect(runner.calls).toHaveLength(5)
  })
})

describe('full backup — fails closed', () => {
  async function expectFailure(opts: RunBackupOptions, message: RegExp): Promise<void> {
    const outcome = await runBackup(opts)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(message)
    const entries = listRoot(opts.outRoot)
    // Never a directory that looks complete.
    expect(entries.filter((name) => /^\d{8}T\d{6}Z$/.test(name))).toEqual([])
    for (const entry of entries) {
      const marker = join(opts.outRoot, entry, COMPLETE_MARKER)
      if (existsSync(marker)) expect(readFileSync(marker, 'utf8')).toBe('INVALIDATED\n')
      const manifestPath = join(opts.outRoot, entry, MANIFEST_FILE)
      if (existsSync(manifestPath)) {
        expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ status: 'failed' })
      }
    }
  }

  it('THE P130-06 REGRESSION: a schema-only dump written as data.sql is refused', async () => {
    await expectFailure(
      options({ runDump: fakeRunner({ content: { data: SCHEMA_SQL } }) }),
      /schema-only dump/,
    )
  })

  it('refuses data.sql that lacks a COPY block for a required table', async () => {
    const withoutLots = DATA_SQL.replace(/COPY "public"\."acquisition_lots"[\s\S]*?\\\.\n/, '')
    await expectFailure(
      options({ runDump: fakeRunner({ content: { data: withoutLots } }) }),
      /no COPY block for required table public\.acquisition_lots/,
    )
  })

  it('fails when the data dump exits non-zero even though schema succeeded, and redacts credentials', async () => {
    const opts = options({
      runDump: fakeRunner({
        exitCode: { data: 1 },
        stderr: `error: connection to postgresql://postgres:${FAKE_PASSWORD_A}@db.example:5432/postgres failed`,
      }),
    })
    const outcome = await runBackup(opts)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/data dump failed \(supabase CLI exit 1\)/)
    expect(outcome.error).not.toContain(FAKE_PASSWORD_A)
    const failed = outcome.directory ?? ''
    expect(basename(failed)).toMatch(/\.FAILED$/)
    expect(readFileSync(join(failed, MANIFEST_FILE), 'utf8')).not.toContain(FAKE_PASSWORD_A)
  })

  it('fails on a zero-byte required file', async () => {
    await expectFailure(
      options({ runDump: fakeRunner({ content: { roles: '' } }) }),
      /roles\.sql is zero bytes/,
    )
  })

  it('fails when the CLI exits 0 but never wrote the file', async () => {
    await expectFailure(
      options({ runDump: fakeRunner({ skipWrite: 'schema' }) }),
      /schema\.sql was not written/,
    )
  })

  it('fails when migration history is missing or empty', async () => {
    await expectFailure(
      options({ runDump: fakeRunner({ content: { migration_history_data: '-- nothing\n' } }) }),
      /no COPY block for supabase_migrations\.schema_migrations/,
    )
    await expectFailure(
      options({
        runDump: fakeRunner({
          content: {
            migration_history_data: copyBlock('supabase_migrations.schema_migrations', []),
          },
        }),
      }),
      /migration history is empty/,
    )
    await expectFailure(
      options({ runDump: fakeRunner({ content: { migration_history_schema: '-- nothing\n' } }) }),
      /no CREATE TABLE supabase_migrations\.schema_migrations/,
    )
  })

  it('fails when the migration history row count differs from the expectation', async () => {
    await expectFailure(options({ expectMigrationHistoryRows: 97 }), /3 rows, expected 97/)
  })

  it('fails on a truncated (unterminated) COPY block', async () => {
    await expectFailure(
      options({
        runDump: fakeRunner({ content: { data: DATA_SQL.slice(0, DATA_SQL.lastIndexOf('\\.')) } }),
      }),
      /unterminated COPY block/,
    )
  })

  it('fails before dumping anything when project identity cannot be established', async () => {
    const runner = fakeRunner()
    const opts = options({ runDump: runner, target: { kind: 'linked', projectRef: '' } })
    const outcome = await runBackup(opts)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/cannot establish project identity/)
    expect(runner.calls).toHaveLength(0)
    expect(listRoot(opts.outRoot)).toEqual([])
  })

  it('refuses an output root inside a git work tree before dumping anything', async () => {
    const runner = fakeRunner()
    const outcome = await runBackup(
      options({ runDump: runner, location: { probe: () => Promise.resolve('inside') } }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/refusing output root inside a git work tree/)
    expect(runner.calls).toHaveLength(0)
  })

  it('allows an inside-git location only with the explicit override AND a git-ignored path', async () => {
    const inside: LocationPolicy = {
      probe: () => Promise.resolve('inside'),
      allowIgnoredInsideGit: true,
      isGitIgnored: () => Promise.resolve(false),
    }
    expect((await runBackup(options({ location: inside }))).error).toMatch(/does not ignore/)
    const ignored = await runBackup(
      options({ location: { ...inside, isGitIgnored: () => Promise.resolve(true) } }),
    )
    expect(ignored.ok).toBe(true)
  })

  it('refuses to reuse an existing backup directory name', async () => {
    const opts = options({ now: () => new Date(Date.UTC(2026, 8, 14, 10, 0, 0)) })
    await mkdir(join(opts.outRoot, '20260914T100000Z'), { recursive: true })
    const outcome = await runBackup(opts)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toMatch(/already exists/)
  })
})

describe('verifying an existing backup detects tampering', () => {
  async function completeBackup(): Promise<string> {
    const outcome = await runBackup(options())
    expect(outcome.ok).toBe(true)
    return outcome.directory ?? ''
  }

  it('a changed byte in data.sql fails the SHA-256 check', async () => {
    const dir = await completeBackup()
    const path = join(dir, 'data.sql')
    const bytes = readFileSync(path)
    bytes[bytes.length - 2] = 'X'.charCodeAt(0)
    writeFileSync(path, bytes)
    await expect(verifyBackupDirectory(dir)).rejects.toThrow(/data\.sql SHA-256 does not match/)
  })

  it('an edited manifest no longer matches the completion marker', async () => {
    const dir = await completeBackup()
    const path = join(dir, MANIFEST_FILE)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"complete"', '"complete" '))
    await expect(verifyBackupDirectory(dir)).rejects.toThrow(/does not match manifest\.json/)
  })

  it('a missing artifact or marker fails verification', async () => {
    const dir = await completeBackup()
    rmSync(join(dir, 'migration_history_data.sql'))
    await expect(verifyBackupDirectory(dir)).rejects.toThrow(
      /migration_history_data\.sql is missing/,
    )
    const dir2 = await completeBackup()
    rmSync(join(dir2, COMPLETE_MARKER))
    await expect(verifyBackupDirectory(dir2)).rejects.toThrow(/marker is missing/)
  })
})

describe('secret hygiene', () => {
  it('never writes the db-url password into the manifest or README', async () => {
    const outcome = await runBackup(
      options({
        target: {
          kind: 'db-url',
          dbUrl: `postgresql://postgres:${FAKE_PASSWORD_B}@127.0.0.1:55432/postgres`,
        },
      }),
    )
    expect(outcome.ok).toBe(true)
    const dir = outcome.directory ?? ''
    for (const file of [MANIFEST_FILE, 'README.txt']) {
      const text = readFileSync(join(dir, file), 'utf8')
      expect(text).not.toContain(FAKE_PASSWORD_B)
      expect(text).not.toContain('postgresql://')
    }
    expect(outcome.manifest?.target.label).toBe('database on 127.0.0.1:55432/postgres')
  })

  it('redacts connection-string credentials, access tokens and JWTs', () => {
    // Secret-shaped fixtures are assembled at runtime so the repository's secret scanner never
    // sees a credential-looking literal in source.
    const fakeJwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'c2lnbmF0dXJlLXZhbHVl',
    ].join('.')
    const fakeToken = ['sbp', '0123456789abcdef'].join('_')
    const fakeUrl = ['postgres://u:', 'p4ss', '@h/db'].join('')
    const fakeAssignment = ['pass', 'word=abc'].join('')
    const text = redactSecrets(`${fakeUrl} ${fakeToken} ${fakeJwt} ${fakeAssignment}`)
    expect(text).not.toMatch(/p4ss|0123456789abcdef|eyJhbGci|=abc/)
  })
})

describe('dump flags', () => {
  it('requests data mode for both data dumps and the migrations schema for both history dumps', () => {
    const args = (kind: ArtifactKind) => ARTIFACTS.find((a) => a.kind === kind)?.dumpArgs ?? []
    expect(args('roles')).toEqual(['--role-only'])
    expect(args('schema')).not.toContain('--data-only')
    expect(args('data')).toEqual(expect.arrayContaining(['--data-only', '--use-copy']))
    expect(args('migration_history_schema')).toEqual(['--schema', 'supabase_migrations'])
    expect(args('migration_history_data')).toEqual(
      expect.arrayContaining(['--data-only', '--use-copy', '--schema', 'supabase_migrations']),
    )
  })
})

describe('artifact inspection', () => {
  it('counts COPY rows per table (CRLF tolerant) and distinguishes schema from data', () => {
    const summary = parseCopyBlocks(DATA_SQL.replace(/\n/g, '\r\n'))
    expect(summary.tables.get('public.acquisition_lots')).toBe(2)
    expect(summary.totalRows).toBe(2)
    expect(() => validateArtifactContent('data', SCHEMA_SQL, DEFAULT_REQUIRED_TABLES)).toThrow(
      /schema-only/,
    )
    expect(() => validateArtifactContent('schema', DATA_SQL, DEFAULT_REQUIRED_TABLES)).toThrow(
      /unexpectedly contains COPY data/,
    )
    expect(() => validateArtifactContent('schema', ROLES_SQL, DEFAULT_REQUIRED_TABLES)).toThrow(
      /no CREATE TABLE for required table public\.profiles/,
    )
  })
})

describe('real git location probe', () => {
  it('classifies this repository as inside git and the OS temp directory as outside', async () => {
    expect(await gitLocationProbe(REPO_ROOT)).toBe('inside')
    expect(await gitLocationProbe(root)).toBe('outside')
  })
})

describe('package script and canonical docs', () => {
  it('exposes db:backup and no longer ships the schema-only db:dump', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['db:backup']).toBe('tsx scripts/db-backup/run-backup.ts')
    expect(pkg.scripts['db:dump']).toBeUndefined()
  })

  it('no canonical document tells an operator to run the schema-only `pnpm db:dump`', () => {
    for (const doc of ['CLAUDE.md', 'docs/DEVELOPMENT.md', 'docs/ARCHITECTURE.md', 'HANDOVER.md']) {
      const text = readFileSync(join(REPO_ROOT, doc), 'utf8')
      expect(text, doc).not.toMatch(/pnpm db:dump/)
    }
  })
})
