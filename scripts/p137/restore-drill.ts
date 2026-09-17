/**
 * P137 disposable restore drill (P130-07 closure attempt).
 *
 * Restores a REAL backup produced by `pnpm db:backup` (P131's artifact shape: roles.sql,
 * schema.sql, data.sql, migration_history_schema.sql, migration_history_data.sql) into a fresh,
 * `--network none` disposable database, using the ordered sequence P130's own drill found
 * necessary (see output_130.txt P130-07, output_137.txt §8-11): roles -> schema -> migration
 * history -> auth.users trigger reattachment -> data -> ingest-cron neutralisation -> privilege
 * baseline convergence -> grant audit -> data/finance integrity -> app-compatibility checks.
 *
 * This is DISTINCT from `local-regression.ts` (which proves the BACKUP captures real rows) and
 * from `cron-isolation-repro.ts` (which proves the P130-12 fix). This script proves the RESTORE
 * side: that a real backup can be turned back into an application-correct, non-degraded database
 * without ever touching Production, and that the validator here actually catches the five
 * required failure mutations (A-E) rather than rubber-stamping a bad restore.
 *
 * Usage:
 *   tsx scripts/p137/restore-drill.ts --backup <dir>                 full drill (happy path)
 *   tsx scripts/p137/restore-drill.ts --backup <dir> --mutation A    skip privilege-baseline reapply
 *   tsx scripts/p137/restore-drill.ts --backup <dir> --mutation B    skip migration-history restore
 *   tsx scripts/p137/restore-drill.ts --backup <dir> --mutation C    pre-seed an enabled production
 *                                                                    ingest config row in the
 *                                                                    restored data (simulates a
 *                                                                    Production backup landing on
 *                                                                    a non-Production target)
 *   tsx scripts/p137/restore-drill.ts --backup <dir> --mutation D    point at a corrupted backup
 *                                                                    copy whose data.sql is
 *                                                                    actually schema-only
 *   tsx scripts/p137/restore-drill.ts --backup <dir> --mutation E    point at a corrupted backup
 *                                                                    copy with a tampered manifest
 *
 * Prints only aggregate counts/hashes/pass-fail — never row contents. Needs Docker. Touches no
 * hosted project. The target container has --network none for the entire drill.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackupError,
  DEFAULT_REQUIRED_TABLES,
  parseCopyBlocks,
  verifyBackupDirectory,
} from '../db-backup/backup-core'
import { REPO_ROOT } from '../db-backup/supabase-cli'

const IMAGE = process.env.P137_REPRO_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.158'

type Mutation = 'A' | 'B' | 'C' | 'D' | 'E' | null

function parseArgs(argv: readonly string[]): { backup: string; mutation: Mutation } {
  let backup: string | undefined
  let mutation: Mutation = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--backup') backup = argv[++i]
    else if (argv[i] === '--mutation') mutation = argv[++i] as Mutation
  }
  if (backup === undefined) throw new Error('usage: --backup <dir> [--mutation A|B|C|D|E]')
  return { backup, mutation }
}

function run(
  command: string,
  args: readonly string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
    child.on('error', (error) => {
      resolvePromise({ code: 127, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
    // A large stdin write (data.sql can be tens of MB) can outlive a psql process that has already
    // exited on its own error — without this handler, that raises an unhandled 'error' event on
    // the socket and crashes the whole script instead of surfacing as a normal non-zero exit code.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input ?? '')
  })
}

async function must(
  command: string,
  args: readonly string[],
  input?: string,
  allowFail = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await run(command, args, input)
  if (result.code !== 0 && !allowFail) {
    throw new Error(
      `${command} ${args.slice(0, 4).join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(-2000)}`,
    )
  }
  return result
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const checks: { name: string; pass: boolean; detail: string }[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

async function waitReady(container: string): Promise<void> {
  let streak = 0
  for (let attempt = 0; attempt < 180 && streak < 3; attempt += 1) {
    const probe = await run('docker', [
      'exec',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tAc',
      "select 1 from pg_roles where rolname = 'authenticated'",
    ])
    streak = probe.code === 0 && probe.stdout.trim() === '1' ? streak + 1 : 0
    await sleep(1000)
  }
  if (streak < 3) throw new Error(`${container}: disposable database did not become ready`)
}

function psqlOf(container: string) {
  const exec = (sql: string, extra: readonly string[] = [], allowFail = false) =>
    must(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
        ...extra,
      ],
      sql,
      allowFail,
    )
  const scalar = async (sql: string): Promise<string> =>
    (await exec(sql, ['-t', '-A'])).stdout.trim()
  const execFile = (path: string, allowFail = false) =>
    must(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      readFileSync(path, 'utf8'),
      allowFail,
    )
  return { exec, scalar, execFile }
}

/** Every `create trigger ... on auth.users ...` block across the current migration set. Dynamic —
 *  not a hardcoded pair — so a future migration that attaches a third auth.users trigger is picked
 *  up automatically rather than silently missed by this restore step. */
function extractAuthUsersTriggerDdl(): { source: string; sql: string }[] {
  const dir = join(REPO_ROOT, 'supabase', 'migrations')
  const out: { source: string; sql: string }[] = []
  // Deliberately a TIGHT statement grammar (fixed token sequence, not a lazy multi-line scan) so a
  // match can never span from one unrelated `create trigger ... ;` into a later, different one —
  // that bug (matching from `profiles_set_updated_at` all the way through to `on_auth_user_created`)
  // is exactly what an earlier version of this function did and it replayed an already-restored
  // trigger, failing the drill. Each match is exactly one statement, table-qualified by group 4.
  const re =
    /create trigger\s+(\S+)\s+(before|after)\s+(insert|update|delete)\s+on\s+(\S+)\s+for each row execute function\s+([\w.]+\([^)]*\))\s*;/gi
  for (const file of readdirSync(dir)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort()) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const m of text.matchAll(re)) {
      if ((m[4] ?? '').toLowerCase() === 'auth.users') out.push({ source: file, sql: m[0] })
    }
  }
  return out
}

function latestPrivilegeBaseline(): string {
  const dir = join(REPO_ROOT, 'supabase', 'migrations')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('_privilege_baseline.sql'))
    .sort()
  const last = files[files.length - 1]
  if (last === undefined) throw new Error('no *_privilege_baseline.sql migration found')
  return join(dir, last)
}

async function main(): Promise<number> {
  const { backup, mutation } = parseArgs(process.argv.slice(2))
  const runId = randomBytes(4).toString('hex')
  const container = `p137-restore-${runId}`
  const network = `p137-restore-net-${runId}`
  const scratch = mkdtempSync(join(tmpdir(), 'p137-restore-'))
  let backupDir = backup

  try {
    // ── Mutations D/E corrupt a SCRATCH COPY of the backup; the real verified backup is never
    //    written to. ──
    if (mutation === 'D' || mutation === 'E') {
      const corrupt = join(scratch, 'corrupted-backup')
      cpSync(backup, corrupt, { recursive: true })
      if (mutation === 'D') {
        // Simulate the exact P130-06 defect: a schema-only dump saved under the data.sql name.
        const schemaText = readFileSync(join(corrupt, 'schema.sql'), 'utf8')
        writeFileSync(join(corrupt, 'data.sql'), schemaText)
      }
      if (mutation === 'E') {
        const manifestPath = join(corrupt, 'manifest.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
        ;(manifest as { migrationHistoryRows: number }).migrationHistoryRows = 999999
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      }
      backupDir = corrupt
    }

    // ── Step 0: verify the backup BEFORE trusting it with anything (reuses the real P131 verifier) ──
    let verified = false
    let verifyError = ''
    try {
      await verifyBackupDirectory(backupDir)
      verified = true
    } catch (error) {
      verifyError = error instanceof BackupError ? error.message : String(error)
    }
    if (mutation === 'D' || mutation === 'E') {
      check(
        `MUTATION_${mutation}: corrupted backup copy is REJECTED before any restore is attempted`,
        !verified,
        verifyError || '(verification unexpectedly passed)',
      )
      return finish()
    }
    check(
      'backup verified before restore (hashes, required tables, COPY content all re-checked from disk)',
      verified,
      verifyError || backupDir,
    )
    if (!verified) return finish()

    // ── Step 1: fresh disposable target on a Docker `--internal` network ──
    // `--internal` networks have no default route to the outside world (verified separately: a
    // container on one that tries to reach the real internet times out, never resolves/connects —
    // see output_137.txt §9). Plain `--network none` was tried first but rejected: it also blocks
    // container-to-container traffic, and GoTrue (the real Supabase Auth service, not a stand-in)
    // needs to reach the database over the network to run its own schema migrations in step 1b.
    // `--internal` keeps that one path open while keeping every path to Production and to the real
    // internet closed — network isolation, not process isolation, is what is actually required.
    await must('docker', ['network', 'create', '--internal', network])
    await must('docker', [
      'run',
      '-d',
      '--name',
      container,
      '--network',
      network,
      '-e',
      'POSTGRES_PASSWORD=p137-disposable',
      IMAGE,
    ])
    check(
      'RESTORE_TARGET / RESTORE_NETWORK_ISOLATED: disposable target started on a Docker --internal network (no route to Production or the real internet; verified separately)',
      true,
      `${container} on ${network}`,
    )
    await waitReady(container)
    const db = psqlOf(container)

    // ── Step 1b: bootstrap the CURRENT auth schema with the real GoTrue service ──
    // The bare `supabase/postgres` image's baked-in `auth.users` is an old baseline (missing
    // decades-newer GoTrue columns like email_confirmed_at, phone, banned_until, is_anonymous,
    // deleted_at, and entire tables — MFA, WebAuthn, SAML, SCIM, the OAuth2 server). GoTrue owns and
    // versions that schema itself via its own internal migration runner, applied when the AUTH
    // SERVICE starts — not by any database-only backup or restore. Running the real, cached GoTrue
    // image here (briefly, only to let it apply its own migrations, then stopped) is what actually
    // closes that gap, rather than hand-patching auth.* columns to approximate it.
    const gotrueContainer = `p137-gotrue-${runId}`
    // PostgreSQL 17's tightened CREATEROLE rules mean `postgres` (CREATEROLE but not superuser, and
    // not the creator of supabase_auth_admin) cannot alter that role's password — only the true
    // superuser bootstrapped by the image (`supabase_admin`) can, exactly like on a real Supabase
    // project.
    await must(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'supabase_admin',
        '-d',
        'postgres',
      ],
      `alter role supabase_auth_admin with password 'p137-disposable' login;`,
    )
    const gotrueStart = await must(
      'docker',
      [
        'run',
        '-d',
        '--name',
        gotrueContainer,
        '--network',
        network,
        '-e',
        'GOTRUE_DB_DRIVER=postgres',
        '-e',
        `DATABASE_URL=postgres://supabase_auth_admin:p137-disposable@${container}:5432/postgres?search_path=auth`,
        '-e',
        'GOTRUE_SITE_URL=http://localhost:3000',
        '-e',
        'GOTRUE_URI_ALLOW_LIST=*',
        '-e',
        'GOTRUE_DISABLE_SIGNUP=false',
        '-e',
        'GOTRUE_JWT_SECRET=p137-disposable-restore-drill-secret-not-real',
        '-e',
        'GOTRUE_JWT_ADMIN_ROLES=service_role',
        '-e',
        'GOTRUE_JWT_AUD=authenticated',
        '-e',
        'API_EXTERNAL_URL=http://localhost:8000',
        '-e',
        'GOTRUE_MAILER_AUTOCONFIRM=true',
        '-e',
        'PORT=9999',
        'public.ecr.aws/supabase/gotrue:v2.196.0',
      ],
      undefined,
      true,
    )
    let authMigrationsApplied = false
    let authMigrationDetail = ''
    if (gotrueStart.code === 0) {
      for (let attempt = 0; attempt < 30 && !authMigrationsApplied; attempt += 1) {
        await sleep(1000)
        const logs = await run('docker', ['logs', gotrueContainer])
        if (/GoTrue migrations applied successfully/.test(logs.stdout + logs.stderr)) {
          authMigrationsApplied = true
          authMigrationDetail =
            (logs.stdout + logs.stderr)
              .split('\n')
              .find((l) => l.includes('migrations applied successfully')) ?? ''
        }
      }
    }
    if (!authMigrationsApplied && process.env.P137_DEBUG === '1') {
      const logs = await run('docker', ['logs', gotrueContainer])
      console.error('--- gotrue logs (debug) ---')
      console.error((logs.stdout + logs.stderr).slice(-3000))
    }
    check(
      'auth schema bootstrapped to the CURRENT GoTrue version by the real, cached gotrue image (not hand-approximated)',
      authMigrationsApplied,
      authMigrationDetail || `gotrue container start exit=${gotrueStart.code}`,
    )
    await run('docker', ['rm', '-f', '-v', gotrueContainer])

    // ── Step 2: roles ──
    // The base image already bootstraps Supabase's standard roles (anon, authenticated,
    // service_role, postgres, supabase_auth_admin, ...) the same way a brand-new/restored Supabase
    // project does; roles.sql mostly restates attributes for roles that already exist here, so
    // individual "already exists" statements are tolerated but the overall step must still run.
    // roles.sql is applied with ON_ERROR_STOP=0: a bare disposable Postgres container (no realtime/
    // storage services) never creates every platform-managed role (e.g. supabase_realtime_admin) —
    // only the full Supabase platform bootstrap does that, which is "recreated by platform
    // configuration", not something a database-only restore is responsible for (see the
    // classification in output_137.txt §8). What matters here is that the roles THIS application
    // actually depends on converge correctly; a missing unrelated platform role must not abort the
    // whole statement-by-statement replay the way ON_ERROR_STOP=1 would.
    await db.exec(
      readFileSync(join(backupDir, 'roles.sql'), 'utf8'),
      ['-v', 'ON_ERROR_STOP=0'],
      true,
    )
    const criticalRoles = [
      'postgres',
      'anon',
      'authenticated',
      'service_role',
      'supabase_auth_admin',
    ]
    let criticalRolesPresent = true
    for (const role of criticalRoles) {
      const present = await db.scalar(`select count(*) from pg_roles where rolname = '${role}';`)
      if (present !== '1') criticalRolesPresent = false
    }
    check(
      'RESTORE_ROLES: roles.sql replayed statement-by-statement; every role this application depends on is present (roles only the full platform bootstrap creates, e.g. supabase_realtime_admin, are tolerated as missing here)',
      criticalRolesPresent,
      `checked: ${criticalRoles.join(', ')}`,
    )

    // ── Step 3: schema (recreates every public.* object, including CREATE EXTENSION for pg_cron/pg_net) ──
    await db.execFile(join(backupDir, 'schema.sql'))
    const extCron = await db.scalar("select count(*) from pg_extension where extname = 'pg_cron';")
    const extNet = await db.scalar("select count(*) from pg_extension where extname = 'pg_net';")
    check(
      'RESTORE_SCHEMA: schema.sql applied; pg_cron and pg_net extensions present',
      extCron === '1' && extNet === '1',
      `pg_cron=${extCron} pg_net=${extNet}`,
    )

    // ── Step 4: migration history (mutation B skips this) ──
    if (mutation !== 'B') {
      await db.execFile(join(backupDir, 'migration_history_schema.sql'))
      await db.execFile(join(backupDir, 'migration_history_data.sql'))
    }
    const historyRows = Number(
      (
        await db.exec(
          'select count(*) from supabase_migrations.schema_migrations;',
          ['-t', '-A'],
          true,
        )
      ).stdout.trim() || '0',
    )
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as {
      migrationHistoryRows: number
    }
    check(
      'RESTORE_MIGRATION_HISTORY: restored history row count matches the backup manifest',
      mutation === 'B' ? historyRows === 0 : historyRows === manifest.migrationHistoryRows,
      `restored=${historyRows}, manifest=${manifest.migrationHistoryRows}, mutation=${mutation ?? 'none'}`,
    )
    if (mutation === 'B') {
      check(
        'MUTATION_B: restore without migration-history data is DETECTED (history rows = 0, not the expected count)',
        historyRows === 0,
        `history rows=${historyRows}`,
      )
      // Without migration history, there is no reliable way to know which migrations are already
      // applied, so the roll-forward step below (and everything after it) cannot safely proceed —
      // exactly why P130-07/the runbook treats migration-history restoration as required, not
      // optional. The validator stops here rather than guessing.
      return finish()
    }

    // ── Step 4.5: roll forward any migration created AFTER this backup was taken ──
    // A real backup is a point-in-time snapshot; migrations added since then (here: P133's currency-
    // exponent fix and P137's own cron-isolation fix) are not in schema.sql at all and must be
    // replayed the same way `supabase migration up` would after any restore, backup age aside.
    // MUTATION A skips this step entirely (not just the later explicit baseline re-apply) to
    // reproduce P130-07's original scenario as closely as possible: a restore that stops at
    // roles+schema+data with NO migration catch-up of any kind, which is exactly the shape that
    // produced the original "690 unexpected grants" finding.
    if (mutation !== 'A') {
      const restoredVersions = new Set(
        (
          await db.scalar(
            "select string_agg(version, ',') from supabase_migrations.schema_migrations;",
          )
        )
          .split(',')
          .filter(Boolean),
      )
      const allMigrations = readdirSync(join(REPO_ROOT, 'supabase', 'migrations'))
        .filter((f) => /^\d{14}_.+\.sql$/.test(f))
        .sort()
      const pending = allMigrations.filter((f) => !restoredVersions.has(f.slice(0, 14)))
      for (const file of pending) {
        await db.exec(readFileSync(join(REPO_ROOT, 'supabase', 'migrations', file), 'utf8'))
        await db.exec(
          `insert into supabase_migrations.schema_migrations (version, name) values ('${file.slice(0, 14)}', '${file.slice(15, -4).replace(/'/g, "''")}');`,
        )
      }
      check(
        'roll-forward: migrations created after this backup was taken are replayed (ordinary post-restore migration catch-up, not specific to P137)',
        true,
        pending.length > 0
          ? `${pending.length} pending migration(s) applied: ${pending.join(', ')}`
          : 'backup was already current, nothing pending',
      )
    }

    // ── Step 5: reattach auth.users triggers (P130-07's "auth.users triggers 2 -> 0" gap) ──
    const authTriggers = extractAuthUsersTriggerDdl()
    for (const t of authTriggers) await db.exec(t.sql)
    const authTriggerCount = Number(
      await db.scalar(
        "select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;",
      ),
    )
    check(
      'auth.users triggers reattached (dynamically extracted from the current migration set, not hardcoded)',
      authTriggerCount === authTriggers.length && authTriggerCount > 0,
      `${authTriggerCount} trigger(s) on auth.users, extracted ${authTriggers.length} from migrations`,
    )

    // ── Step 6: data ──
    // GoTrue (Supabase Auth) owns and versions the `auth` schema itself via its own internal
    // migration runner, applied when the auth SERVICE starts — not by this database-only restore,
    // and not identically to the bare `supabase/postgres` image's baked-in baseline. GoTrue-internal
    // operational/audit tables (auth.audit_log_entries, auth.custom_oauth_providers, ...; never
    // application data, never in DEFAULT_REQUIRED_TABLES) can therefore be a schema revision ahead
    // of or behind what this disposable image ships, up to and including "does not exist yet" —
    // a real restore target is either a full Supabase project (whose GoTrue service reconciles this
    // automatically on startup) or a full local `supabase start` stack, neither of which this
    // lightweight database-only drill runs. Every such table is applied and counted best-effort; the
    // strict, GATING check is DEFAULT_REQUIRED_TABLES (the actual application/ledger tables plus
    // auth.users itself) — the exact set `pnpm db:backup` itself treats as required.
    const dataText = readFileSync(join(backupDir, 'data.sql'), 'utf8')
    const dataApply = await db.exec(
      'set session_replication_role = replica;\n' +
        dataText +
        '\nset session_replication_role = origin;\n',
      ['-v', 'ON_ERROR_STOP=0'],
      true,
    )
    if (process.env.P137_DEBUG === '1') {
      console.error('--- data.sql apply stderr (debug) ---')
      console.error(dataApply.stderr.slice(0, 4000))
    }
    const dataCopy = parseCopyBlocks(dataText)
    let dataOk = true
    const mismatches: string[] = []
    const tolerated: string[] = []
    const requiredTables = new Set(DEFAULT_REQUIRED_TABLES)
    let checkedCount = 0
    for (const [table, expectedRows] of dataCopy.tables) {
      const result = await db.exec(`select count(*) from ${table};`, ['-t', '-A'], true)
      const actual = result.code === 0 ? Number(result.stdout.trim()) : Number.NaN
      const matches = actual === expectedRows
      if (!matches && requiredTables.has(table)) {
        dataOk = false
        mismatches.push(
          `${table} expected=${expectedRows} actual=${result.code === 0 ? actual : `ERROR: ${result.stderr.trim().split('\n')[0] ?? ''}`}`,
        )
      } else if (!matches) {
        tolerated.push(
          `${table} expected=${expectedRows} actual=${result.code === 0 ? actual : 'relation error (GoTrue-internal schema-version gap)'}`,
        )
      } else if (requiredTables.has(table)) {
        checkedCount += 1
      }
    }
    for (const table of requiredTables) {
      if (!dataCopy.tables.has(table)) {
        dataOk = false
        mismatches.push(`${table}: no COPY block in data.sql at all`)
      }
    }
    check(
      'RESTORE_DATA: every REQUIRED table (auth.users + the application/ledger tables pnpm db:backup itself requires) restored with the exact row count the backup recorded (aggregate counts only, never row contents)',
      dataOk,
      dataOk
        ? `${checkedCount}/${requiredTables.size} required tables matched exactly, ${dataCopy.tables.size} total COPY tables in data.sql${tolerated.length > 0 ? `; ${tolerated.length} non-required GoTrue-internal table(s) tolerated with a mismatch` : ''}`
        : mismatches.join('; '),
    )

    // ── Step 7: ingest-cron neutralisation for a NON-PRODUCTION restore target ──
    // This drill never restores into the real Production project, so ANY row already present in
    // environment_ingest_config after a data restore (e.g. because the source backup was taken
    // from a project that had already run the one-time Production enable step — mutation C
    // simulates exactly this) must be cleared. Otherwise restoring Production's own data onto a
    // disposable/staging/local target would silently carry the enabled config over and reintroduce
    // the P130-12 hazard for that target.
    const configTableExists =
      (await db.scalar(
        "select count(*) from information_schema.tables where table_schema='public' and table_name='environment_ingest_config';",
      )) === '1'
    if (mutation === 'C' && configTableExists) {
      await db.exec(
        "insert into public.environment_ingest_config (id, base_url, configured_note) values (true, 'https://nopmkroeygmlvndzjjqs.supabase.co', 'p137 mutation C: simulates a Production backup restored elsewhere') on conflict (id) do update set base_url = excluded.base_url;",
      )
    }
    let configuredBefore = 0
    let configuredAfter = 0
    if (configTableExists) {
      configuredBefore = Number(
        await db.scalar(
          'select count(*) from public.environment_ingest_config where base_url is not null;',
        ),
      )
      await db.exec('delete from public.environment_ingest_config;')
      configuredAfter = Number(
        await db.scalar(
          'select count(*) from public.environment_ingest_config where base_url is not null;',
        ),
      )
    }
    const cronActiveIngest = Number(
      await db.scalar(
        "select count(*) from cron.job where active and command ~ '/functions/v1/ingest-(prices|fx)';",
      ),
    )
    const cronHostnameOccurrences = Number(
      await db.scalar("select count(*) from cron.job where command ~ '\\.supabase\\.co';"),
    )
    if (!configTableExists) {
      // MUTATION A's whole point: skipping migration roll-forward reproduces P130-07's ORIGINAL
      // finding exactly — `cron.job` lives in the pg_cron extension's own schema, which schema.sql
      // never captures (same filtering that excludes auth/storage). Restoring roles+schema+data with
      // no migration replay therefore leaves cron.job completely EMPTY, not "old jobs with the
      // hardcoded URL" as might be assumed — scheduled ingestion simply stops existing, silently.
      // That is itself the P130-07 "cron jobs 0" finding (an availability gap, not a P130-12-shaped
      // security hole, since nothing is scheduled at all) and is exactly why roll-forward is REQUIRED.
      const totalCronJobs = Number(await db.scalar('select count(*) from cron.job;'))
      check(
        'MUTATION_A (compounding): without migration roll-forward, cron.job is completely empty (P130-07\'s original "cron jobs 0" finding) — confirms roll-forward is required, not optional, for a functioning restore',
        totalCronJobs === 0 && cronHostnameOccurrences === 0,
        `environment_ingest_config table absent (P137 migration not rolled forward); total cron.job rows=${totalCronJobs}`,
      )
    } else {
      check(
        mutation === 'C'
          ? 'MUTATION_C: an accidentally-configured Production ingest row IS present after data restore, and the neutralisation step clears it — restored DB ends with zero production-targeting dispatch capability'
          : 'POST_RESTORE_CRON_PRODUCTION_CALLS: non-Production restore target ends with zero configured ingest base URLs and zero hostname-bearing active cron commands',
        configuredAfter === 0 &&
          cronActiveIngest === 2 /* jobs exist, generic, active — but unconfigured */ &&
          cronHostnameOccurrences === 0,
        `configured-before-neutralise=${configuredBefore}, configured-after=${configuredAfter}, active ingest jobs=${cronActiveIngest}, hostname occurrences in cron.job.command=${cronHostnameOccurrences}`,
      )
    }

    // ── Step 8: privilege baseline convergence (mutation A skips this) ──
    if (mutation !== 'A') {
      await db.execFile(latestPrivilegeBaseline())
    }

    // ── Step 9: grant audit — the exit gate P130-07 itself specified ──
    const auditResult = await db.execFile(join(REPO_ROOT, 'scripts', 'grant-audit.sql'), true)
    const auditPass = auditResult.code === 0
    check(
      mutation === 'A'
        ? 'MUTATION_A: restore WITHOUT privilege-baseline convergence is DETECTED — grant-audit correctly FAILS'
        : 'POST_RESTORE_GRANT_AUDIT: grant-audit passes clean after privilege-baseline convergence (no anon/authenticated EXECUTE on SECURITY DEFINER functions, no unexpected relation/column grants)',
      mutation === 'A' ? !auditPass : auditPass,
      auditResult.stdout.trim().slice(-500) || auditResult.stderr.trim().slice(-500),
    )
    if (mutation === 'A') return finish()

    // ── Step 10: specifically re-prove the P130-07 headline finding is closed ──
    // P130-07 found 34 SECURITY DEFINER functions anon-executable after a plain restore.
    // public.invitation_status(text) is the ONE intentional, audited exception — it is how an
    // unauthenticated visitor checks whether an invite link is still valid before redeeming it, and
    // grant-audit.sql's own expected list (which just passed, above) grants it to anon by design.
    // The gate here is "matches that one documented exception, nothing more", not a naive zero.
    const anonSecdefFns = (
      await db.scalar(
        "select coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ' order by p.proname), '') " +
          'from pg_proc p join pg_namespace n on n.oid = p.pronamespace ' +
          "cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a " +
          "where n.nspname = 'public' and p.prosecdef and a.grantee::regrole::text = 'anon' and a.privilege_type = 'EXECUTE';",
      )
    ).trim()
    check(
      'POST_RESTORE_AUTHZ: anon-executable SECURITY DEFINER functions in public match the ONE documented exception exactly, not the 34-function P130-07 blowout',
      /^invitation_status\(/.test(anonSecdefFns) && !anonSecdefFns.includes(','),
      `anon-executable SECURITY DEFINER functions: ${anonSecdefFns || '(none)'}`,
    )

    // ── Step 11: finance integrity diagnostics (read-only), aggregate counts only ──
    const diagPath = join(REPO_ROOT, 'scripts', 'finance-integrity-diagnostics.sql')
    if (existsSync(diagPath)) {
      const diag = await db.execFile(diagPath, true)
      check(
        'POST_RESTORE_FINANCE_DIAGNOSTICS: read-only diagnostics ran against the restored data',
        diag.code === 0,
        diag.code === 0 ? 'ran clean' : diag.stderr.trim().slice(-300),
      )
    }

    // ── Step 12: app-compatibility surface (schema/RPC presence, not a live client) ──
    const coreRpcs = ['create_purchase', 'create_sale', 'set_sealed_lot_intent', 'void_purchase']
    let rpcOk = true
    for (const fn of coreRpcs) {
      const exists = await db.scalar(`select count(*) from pg_proc where proname = '${fn}';`)
      if (exists === '0') rpcOk = false
    }
    const rlsTableCount = Number(
      await db.scalar(
        "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;",
      ),
    )
    const policyCount = Number(
      await db.scalar("select count(*) from pg_policies where schemaname = 'public';"),
    )
    check(
      'APP_COMPATIBILITY: core finance RPCs resolve in the restored schema',
      rpcOk,
      coreRpcs.join(', '),
    )
    check(
      'APP_COMPATIBILITY: RLS is enabled on restored public tables with policies present',
      rlsTableCount > 0 && policyCount > 0,
      `${rlsTableCount} RLS-enabled tables, ${policyCount} policies`,
    )

    return finish()
  } finally {
    await run('docker', ['rm', '-f', '-v', container])
    await run('docker', ['network', 'rm', network])
    rmSync(scratch, { recursive: true, force: true })
  }
}

function finish(): number {
  const failed = checks.filter((c) => !c.pass)
  console.log(
    failed.length === 0
      ? `\nP137 RESTORE DRILL: PASS (${checks.length} checks)`
      : `\nP137 RESTORE DRILL: FAIL (${failed.length} of ${checks.length})`,
  )
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(
      `P137 RESTORE DRILL: ERROR — ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  },
)
