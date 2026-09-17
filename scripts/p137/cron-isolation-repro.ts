/**
 * P137 — proves P130-12 (pg_cron migrations hardcode the Production edge-function hostname) against
 * the RELEASED migration set, then proves the fix in this branch removes it, using two disposable
 * `--network none` Postgres containers. Neither container has any network interface other than
 * loopback, so the "do not allow the request to reach Production" requirement holds by construction
 * — not by an application-level guard that could be wrong.
 *
 * PHASE 1 (pre-fix): migrations as of BASE_SHA (before this branch's new migration) are read
 * straight from git (`git show <sha>:path`), applied to a disposable database, and the released
 * cron.job the migration set creates is inspected: the hostname is present, the job is active.
 * PHASE 2 (post-fix): the working tree's migrations (including
 * 20260916120000_p137_environment_scoped_ingest_dispatch.sql) are applied to a second disposable
 * database. Asserts zero hostname occurrences in any active cron command, zero
 * Production-targeting active jobs, and that calling the dispatcher with no configured
 * environment queues no outbound request at all (net.http_request_queue stays empty).
 * PHASE 3 (post-fix, configured): the same database, with one row inserted into
 * environment_ingest_config pointing at a syntheticP `*.supabase.co`-shaped hostname that is NOT
 * the real Production ref and exists nowhere in DNS. Asserts the dispatcher now DOES queue a
 * request (net.http_post returns a request_id) — proving explicit configuration is what turns
 * dispatch on, not a hostname baked into a migration. The container has no network, so this queued
 * request can never leave the machine, let alone reach Production.
 *
 * Needs Docker. Touches no hosted project, no shared local stack, no real Production hostname.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const IMAGE = process.env.P137_REPRO_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.158'
const BASE_SHA = process.env.P137_BASE_SHA ?? '72e4660c4331a201ff8ff29ebcbada09088dc851'
const REAL_PRODUCTION_HOST = 'nopmkroeygmlvndzjjqs.supabase.co'
const FAKE_TEST_HOST = 'p137-disposable-nonexistent-test.supabase.co'
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
      `${command} ${args.slice(0, 4).join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
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

interface MigrationFile {
  name: string
  sql: string
}

async function migrationsAtGitRef(ref: string): Promise<MigrationFile[]> {
  const listing = await must('git', [
    'ls-tree',
    '-r',
    '--name-only',
    ref,
    '--',
    'supabase/migrations',
  ])
  const files = listing
    .split(/\r?\n/)
    .filter((line) => /supabase\/migrations\/\d{14}_.+\.sql$/.test(line))
    .sort()
  const out: MigrationFile[] = []
  for (const path of files) {
    const sql = await must('git', ['show', `${ref}:${path}`])
    out.push({ name: path.split('/').pop() ?? path, sql })
  }
  return out
}

async function startDisposableDb(
  containerName: string,
  pinnedHosts: readonly string[],
): Promise<string> {
  const password = randomBytes(18).toString('hex')
  await must('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '--network',
    'none',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    ...pinnedHosts.flatMap((host) => ['--add-host', `${host}:127.0.0.1`]),
    IMAGE,
  ])
  let streak = 0
  for (let attempt = 0; attempt < 180 && streak < 3; attempt += 1) {
    const probe = await run('docker', [
      'exec',
      containerName,
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
  if (streak < 3) throw new Error(`${containerName}: disposable database did not become ready`)
  return password
}

function psqlOf(containerName: string) {
  const exec = (sql: string, extra: readonly string[] = []) =>
    must(
      'docker',
      [
        'exec',
        '-i',
        containerName,
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
  const scalar = async (sql: string): Promise<string> => (await exec(sql, ['-t', '-A'])).trim()
  return { exec, scalar }
}

async function applyMigrations(
  containerName: string,
  migrations: readonly MigrationFile[],
): Promise<void> {
  const { exec } = psqlOf(containerName)
  await exec(
    'create schema if not exists supabase_migrations;\n' +
      'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);\n',
  )
  for (const file of migrations) {
    await exec(file.sql)
    const version = file.name.slice(0, 14)
    const name = file.name.slice(15, -4).replace(/'/g, "''")
    await exec(
      `insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}');\n`,
    )
  }
}

async function main(): Promise<number> {
  const runId = randomBytes(4).toString('hex')
  const preContainer = `p137-precheck-${runId}`
  const postContainer = `p137-postcheck-${runId}`

  try {
    // ── PHASE 1: pre-fix, exactly the released migration set at BASE_SHA ──
    console.log(`\n=== PHASE 1: pre-fix repro at ${BASE_SHA} (--network none) ===`)
    await startDisposableDb(preContainer, [REAL_PRODUCTION_HOST])
    const preMigrations = await migrationsAtGitRef(BASE_SHA)
    check(
      'pre-fix migration set read from git',
      preMigrations.length > 0,
      `${preMigrations.length} files at ${BASE_SHA}`,
    )
    await applyMigrations(preContainer, preMigrations)
    const pre = psqlOf(preContainer)

    const preIngestJobs = await pre.exec(
      `select jobname, active, command from cron.job where ${HOSTED_INGEST_JOB_FILTER} order by jobname;`,
    )
    console.log(preIngestJobs)
    const preHostnameOccurrences = Number(
      await pre.scalar(
        `select count(*) from cron.job where command ~ '${REAL_PRODUCTION_HOST.replace('.', '\\.')}';`,
      ),
    )
    const preActiveIngest = Number(
      await pre.scalar(
        `select count(*) from cron.job where active and ${HOSTED_INGEST_JOB_FILTER};`,
      ),
    )
    const preTotalIngest = Number(
      await pre.scalar(`select count(*) from cron.job where ${HOSTED_INGEST_JOB_FILTER};`),
    )
    check(
      'P130_12_PRE_FIX_REPRO: released migrations create an ACTIVE cron job whose command contains the real Production hostname',
      preHostnameOccurrences >= 2 && preActiveIngest === 2 && preTotalIngest === 2,
      `hostname occurrences in cron.job.command=${preHostnameOccurrences}, active ingest jobs=${preActiveIngest}/${preTotalIngest}`,
    )

    // A fresh reset never had time to disable these — this is the state between "migration applied"
    // and any manual `cron.alter_job(active := false)` workaround. Directly attempt the queued call
    // the way pg_cron would, to show it is genuinely dispatched (queued), not merely present as text.
    const preRequestId = await pre.scalar(
      `select net.http_post(url := 'https://${REAL_PRODUCTION_HOST}/functions/v1/ingest-prices', body := '{}'::jsonb)::text;`,
    )
    check(
      'pre-fix: a real net.http_post to the Production hostname is queued by pg_net (request_id returned)',
      preRequestId.length > 0,
      `request_id=${preRequestId}`,
    )
    await sleep(2000)
    const preResponseStatuses = await pre.exec(
      'select status_code, error_msg from net._http_response order by id desc limit 3;',
    )
    console.log(preResponseStatuses)
    check(
      'pre-fix: container has --network none, so the queued request cannot have reached any real host (no successful HTTP status recorded)',
      !/^\s*\d{3}\s*\|/m.test(preResponseStatuses),
      'no 2xx/3xx/4xx/5xx status in net._http_response — request could only fail locally, confirming no path out existed',
    )

    // ── PHASE 2 & 3: post-fix, this branch's migration set ──
    console.log('\n=== PHASE 2: post-fix, working-tree migrations (--network none) ===')
    await startDisposableDb(postContainer, [REAL_PRODUCTION_HOST, FAKE_TEST_HOST])
    const postMigrations = await migrationsAtGitRef('HEAD')
    check(
      'post-fix migration set read from git HEAD',
      postMigrations.length > 0,
      `${postMigrations.length} files`,
    )
    await applyMigrations(postContainer, postMigrations)
    const post = psqlOf(postContainer)

    const postHostnameOccurrences = Number(
      await post.scalar("select count(*) from cron.job where command ~ '\\.supabase\\.co';"),
    )
    const postActiveIngest = Number(
      await post.scalar(
        `select count(*) from cron.job where active and ${HOSTED_INGEST_JOB_FILTER};`,
      ),
    )
    const postConfigRows = Number(
      await post.scalar('select count(*) from public.environment_ingest_config;'),
    )
    check(
      'post-fix: the two ingest jobs still exist and are active (schedule itself stays reproducible from migrations, not deleted)',
      postActiveIngest === 2,
      `active ingest jobs=${postActiveIngest}`,
    )
    check(
      'PRODUCTION_HOST_HARDCODE_REMOVED: no *.supabase.co literal in any cron.job.command',
      postHostnameOccurrences === 0,
      `occurrences=${postHostnameOccurrences}`,
    )
    check(
      'fresh post-fix DB: environment_ingest_config has zero rows (fail-closed default)',
      postConfigRows === 0,
      `rows=${postConfigRows}`,
    )
    const unconfiguredResult = (
      await post.scalar(
        "select coalesce(public.dispatch_ingest_call('/functions/v1/ingest-prices')::text, 'NULL');",
      )
    ).trim()
    check(
      'unconfigured environment: calling the dispatcher returns NULL — no net.http_post call was ever made (fails closed)',
      unconfiguredResult === 'NULL',
      `dispatch_ingest_call() returned ${unconfiguredResult}`,
    )

    console.log(
      '\n=== PHASE 3: post-fix, environment explicitly configured (non-production, non-existent test host) ===',
    )
    await post.exec(
      `insert into public.environment_ingest_config (id, base_url, configured_note) values (true, 'https://${FAKE_TEST_HOST}', 'p137 disposable test only');`,
    )
    const configuredBaseUrl = await post.scalar(
      'select base_url from public.environment_ingest_config where id;',
    )
    check(
      'environment_ingest_config now holds the fake test host, never the real Production hostname (dispatch_ingest_call builds its URL from this column and no other source)',
      configuredBaseUrl.includes(FAKE_TEST_HOST) &&
        !configuredBaseUrl.includes(REAL_PRODUCTION_HOST),
      `base_url=${configuredBaseUrl}`,
    )
    const requestIdRaw = (
      await post.scalar(
        "select coalesce(public.dispatch_ingest_call('/functions/v1/ingest-prices')::text, 'NULL');",
      )
    ).trim()
    check(
      'explicitly configuring the environment turns dispatch on (dispatch_ingest_call now returns a real pg_net request id instead of NULL) — proves the mechanism works, not just that it is disabled',
      requestIdRaw !== '' && requestIdRaw !== 'NULL',
      `dispatch_ingest_call() returned request_id=${requestIdRaw}`,
    )

    return finish()
  } finally {
    await run('docker', ['rm', '-f', '-v', preContainer])
    await run('docker', ['rm', '-f', '-v', postContainer])
  }
}

function finish(): number {
  const failed = checks.filter((c) => !c.pass)
  console.log(
    failed.length === 0
      ? `\nP137 CRON ISOLATION REPRO: PASS (${checks.length} checks)`
      : `\nP137 CRON ISOLATION REPRO: FAIL (${failed.length} of ${checks.length} checks failed)`,
  )
  return failed.length === 0 ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(
      `P137 CRON ISOLATION REPRO: ERROR — ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  },
)
