/**
 * `pnpm db:backup:regression` — proves, against the REAL pinned Supabase CLI and a disposable
 * database, that `pnpm db:backup` captures actual rows (P131, the regression for P130-06).
 *
 * What it does, in order:
 *   1. Starts a throwaway `supabase/postgres` container bound to 127.0.0.1 on a random port.
 *      Every `*.supabase.co` host hardcoded in a migration (P130-12: the M9 cron jobs POST to the
 *      Production edge functions) is pinned to 127.0.0.1 inside the container, so no request from
 *      this database can reach a hosted project even before step 3.
 *   2. Applies every migration in supabase/migrations/ (recording migration history the way the
 *      CLI does) and the synthetic catalog seed.
 *   3. Immediately after the migration that schedules them, deactivates ONLY the cron jobs that
 *      call the hosted ingest-prices / ingest-fx functions, and asserts none is active.
 *   4. Seeds one synthetic `.invalid` account with purchases through the real create_purchase RPC.
 *   5. Runs the backup core with the real CLI into a temp root whose path contains spaces.
 *   6. Asserts data.sql's COPY blocks hold exactly the rows the database holds
 *      (public.acquisition_lots, public.purchases, auth.users), schema.sql holds no data,
 *      migration history row count equals the migration file count, verification re-passes, the
 *      manifest carries no password, and a real CLI failure (unreachable database) fails closed.
 *   7. Removes the container and temp files (synthetic data only).
 *
 * Exit 0 = PASS. Needs Docker. Touches no hosted project and no shared local stack.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCopyBlocks, runBackup, verifyBackupDirectory } from './backup-core'
import {
  REPO_ROOT,
  createCliDumpRunner,
  gitLocationProbe,
  supabaseCliVersion,
} from './supabase-cli'

const IMAGE =
  process.env.DB_BACKUP_REGRESSION_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.158'
const SYNTHETIC_USER_ID = 'b0000000-0000-4000-8000-000000000131'
const HOSTED_INGEST_JOB_FILTER = "command ~ '/functions/v1/ingest-(prices|fx)'"

function run(
  command: string,
  args: readonly string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => {
      resolvePromise({ code: 127, stdout, stderr: error.message })
    })
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.end(input ?? '')
  })
}

async function must(command: string, args: readonly string[], input?: string): Promise<string> {
  const result = await run(command, args, input)
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 3).join(' ')} failed (${result.code}): ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

const checks: { name: string; pass: boolean; detail: string }[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
}

async function main(): Promise<number> {
  const migrationsDir = join(REPO_ROOT, 'supabase', 'migrations')
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort()
  const hostedHosts = new Set<string>()
  for (const file of migrationFiles) {
    for (const match of readFileSync(join(migrationsDir, file), 'utf8').matchAll(
      /https?:\/\/([a-z0-9-]+\.supabase\.co)\b/gi,
    )) {
      if (match[1]) hostedHosts.add(match[1].toLowerCase())
    }
  }

  const container = `pp-backup-regression-${randomBytes(4).toString('hex')}`
  const password = randomBytes(18).toString('hex')
  const tempRoot = mkdtempSync(join(tmpdir(), 'pp backup regression '))
  const outRoot = join(tempRoot, 'Pokemonapp prosjekt private backups')

  const psql = (sql: string, extra: readonly string[] = []): Promise<string> =>
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
    )
  const scalar = async (sql: string): Promise<string> => (await psql(sql, ['-t', '-A'])).trim()

  try {
    await must('docker', [
      'run',
      '-d',
      '--name',
      container,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-p',
      '127.0.0.1::5432',
      ...[...hostedHosts].flatMap((host) => ['--add-host', `${host}:127.0.0.1`]),
      IMAGE,
    ])
    check(
      'hosted hosts from migrations pinned to 127.0.0.1 in the container',
      true,
      `${hostedHosts.size} host(s) blocked`,
    )
    const portLine =
      (await must('docker', ['port', container, '5432/tcp'])).trim().split(/\r?\n/)[0] ?? ''
    const port = portLine.split(':').pop() ?? ''

    // The image restarts Postgres once after its init scripts; require several consecutive successes.
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
    if (streak < 3) throw new Error('disposable database did not become ready')

    await psql(
      'create schema if not exists supabase_migrations;\n' +
        'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);\n',
    )
    let cronDisabledAfter: string | null = null
    for (const file of migrationFiles) {
      await psql(readFileSync(join(migrationsDir, file), 'utf8'))
      const version = file.slice(0, 14)
      const name = file.slice(15, -4)
      await psql(
        `insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}');\n`,
      )
      const hasCron = await scalar("select count(*) from pg_namespace where nspname = 'cron'")
      if (hasCron === '1') {
        const active = Number(
          await scalar(
            `select count(*) from cron.job where active and ${HOSTED_INGEST_JOB_FILTER}`,
          ),
        )
        if (active > 0) {
          await psql(
            `select cron.alter_job(jobid, active := false) from cron.job where ${HOSTED_INGEST_JOB_FILTER};\n`,
          )
          cronDisabledAfter = file
        }
      }
    }
    check('migrations applied', true, `${migrationFiles.length} files`)
    const activeIngest = Number(
      await scalar(`select count(*) from cron.job where active and ${HOSTED_INGEST_JOB_FILTER}`),
    )
    const totalIngest = Number(
      await scalar(`select count(*) from cron.job where ${HOSTED_INGEST_JOB_FILTER}`),
    )
    check(
      'LOCAL_PRODUCTION_CRON_CALLS_DISABLED',
      activeIngest === 0 && totalIngest === 2 && cronDisabledAfter !== null,
      `${totalIngest} ingest job(s) found, ${activeIngest} active, disabled right after ${cronDisabledAfter ?? '(never)'}`,
    )

    await psql(readFileSync(join(REPO_ROOT, 'supabase', 'seed', '0001_catalog.sql'), 'utf8'))
    await psql(`
      set session_replication_role = replica;
      -- The bare image ships a minimal auth.users (GoTrue adds the rest); id + email is all the
      -- ledger needs. Replica mode skips the invite-gate trigger for this synthetic account only.
      insert into auth.users (id, aud, role, email)
      values ('${SYNTHETIC_USER_ID}', 'authenticated', 'authenticated', 'p131-backup-regression@example.invalid');
      insert into public.profiles (id) values ('${SYNTHETIC_USER_ID}') on conflict (id) do nothing;
      set session_replication_role = origin;
    `)
    await psql(`
      select id as variant_a from public.card_variants order by id limit 1 offset 0 \\gset
      select id as variant_b from public.card_variants order by id limit 1 offset 1 \\gset
      begin;
      -- The image's auth.uid() stub reads the legacy per-claim setting; set both forms.
      select set_config('request.jwt.claims', '{"sub":"${SYNTHETIC_USER_ID}","role":"authenticated"}', true),
             set_config('request.jwt.claim.sub', '${SYNTHETIC_USER_ID}', true);
      set local role authenticated;
      select public.create_purchase(p_purchased_on => current_date - 5, p_currency => 'NOK',
        p_lines => jsonb_build_array(
          jsonb_build_object('line_type', 'card', 'card_variant_id', :'variant_a', 'quantity', 2, 'unit_price_minor', 12345, 'condition', 'NM'),
          jsonb_build_object('line_type', 'card', 'card_variant_id', :'variant_b', 'quantity', 1, 'unit_price_minor', 990, 'condition', 'EX')));
      select public.create_purchase(p_purchased_on => current_date - 2, p_currency => 'NOK', p_shipping_minor => 4900,
        p_lines => jsonb_build_array(
          jsonb_build_object('line_type', 'card', 'card_variant_id', :'variant_a', 'quantity', 3, 'unit_price_minor', 5000, 'condition', 'LP')));
      commit;
    `)
    const dbLots = Number(await scalar('select count(*) from public.acquisition_lots'))
    const dbPurchases = Number(await scalar('select count(*) from public.purchases'))
    const dbUsers = Number(await scalar('select count(*) from auth.users'))
    check(
      'synthetic ledger seeded through create_purchase',
      dbLots >= 3 && dbPurchases === 2,
      `${dbPurchases} purchases, ${dbLots} lots, ${dbUsers} user(s)`,
    )

    // ── The backup itself, against the real pinned CLI ──
    // The CLI runs pg_dump in its own container: on Docker Desktop (Windows/macOS) 127.0.0.1 is that
    // container itself, so the published port is reached through host.docker.internal instead.
    const dumpHost =
      process.env.DB_BACKUP_REGRESSION_DUMP_HOST ??
      (process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal')
    const dbUrl = `postgresql://postgres:${password}@${dumpHost}:${port}/postgres`
    const cliVersion = await supabaseCliVersion()
    const outcome = await runBackup({
      outRoot,
      target: { kind: 'db-url', dbUrl },
      runDump: createCliDumpRunner(),
      supabaseCliVersion: cliVersion,
      location: { probe: gitLocationProbe },
      localMigrationFiles: migrationFiles.length,
      expectMigrationHistoryRows: migrationFiles.length,
      log: (line) => {
        console.log(`  backup: ${line}`)
      },
    })
    check(
      'backup completed with the real CLI',
      outcome.ok,
      outcome.error ?? `${outcome.directory ?? ''} (CLI ${cliVersion})`,
    )
    if (!outcome.ok || outcome.directory === null) return finish()

    const dir = outcome.directory
    const data = parseCopyBlocks(readFileSync(join(dir, 'data.sql'), 'utf8'))
    const schema = readFileSync(join(dir, 'schema.sql'), 'utf8')
    const history = parseCopyBlocks(readFileSync(join(dir, 'migration_history_data.sql'), 'utf8'))
    check(
      'data.sql COPY public.acquisition_lots rows == database rows',
      data.tables.get('public.acquisition_lots') === dbLots,
      `dump ${String(data.tables.get('public.acquisition_lots'))} / db ${dbLots}`,
    )
    check(
      'data.sql COPY public.purchases rows == database rows',
      data.tables.get('public.purchases') === dbPurchases,
      `dump ${String(data.tables.get('public.purchases'))} / db ${dbPurchases}`,
    )
    check(
      'data.sql COPY auth.users rows == database rows',
      data.tables.get('auth.users') === dbUsers,
      `dump ${String(data.tables.get('auth.users'))} / db ${dbUsers}`,
    )
    check(
      'schema.sql holds no COPY data and defines acquisition_lots',
      parseCopyBlocks(schema).tables.size === 0 &&
        /CREATE TABLE (IF NOT EXISTS )?"public"\."acquisition_lots"/.test(schema),
      `${schema.length} chars`,
    )
    check(
      'migration history rows == migration files',
      history.tables.get('supabase_migrations.schema_migrations') === migrationFiles.length,
      `${String(history.tables.get('supabase_migrations.schema_migrations'))} / ${migrationFiles.length}`,
    )
    const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8')
    check(
      'manifest carries no password or connection string',
      !manifestText.includes(password) && !manifestText.includes('postgresql://'),
      'scanned manifest.json',
    )
    let reverified = false
    try {
      await verifyBackupDirectory(dir)
      reverified = true
    } catch (error) {
      console.error(error)
    }
    check('independent re-verification from disk', reverified, dir)

    // ── A real CLI failure fails closed ──
    const unreachable = await runBackup({
      outRoot: join(tempRoot, 'unreachable root'),
      target: { kind: 'db-url', dbUrl: `postgresql://postgres:${password}@127.0.0.1:1/postgres` },
      runDump: createCliDumpRunner(),
      supabaseCliVersion: cliVersion,
      location: { probe: gitLocationProbe },
    })
    const leftovers = existsSync(join(tempRoot, 'unreachable root'))
      ? readdirSync(join(tempRoot, 'unreachable root'))
      : []
    check(
      'unreachable database → backup FAILED, nothing marked complete, no password in error',
      !unreachable.ok &&
        leftovers.every((name) => name.endsWith('.FAILED')) &&
        !(unreachable.error ?? '').includes(password),
      `${unreachable.error ?? 'no error'} | leftovers: ${leftovers.join(', ') || '(none)'}`,
    )

    // No HTTP response from any remote host was ever recorded by this database.
    const responses = await scalar(
      "select count(*) filter (where status_code is not null) || '/' || count(*) from net._http_response",
    )
    check(
      'no outbound HTTP response recorded (pg_net)',
      responses.startsWith('0/'),
      `with-status/total = ${responses}`,
    )
    return finish()
  } finally {
    await run('docker', ['rm', '-f', '-v', container])
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function finish(): number {
  const failed = checks.filter((c) => !c.pass)
  console.log(
    failed.length === 0
      ? `\nBACKUP REGRESSION: PASS (${checks.length} checks)`
      : `\nBACKUP REGRESSION: FAIL (${failed.length} of ${checks.length} checks failed)`,
  )
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(
      `BACKUP REGRESSION: ERROR — ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  },
)
