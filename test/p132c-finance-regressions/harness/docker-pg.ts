/**
 * Disposable Postgres for the P132-C finance regression package.
 *
 * Why Docker + psql instead of the Supabase client the other DB suites use: P130-03 is a
 * transaction-lock race. PostgREST runs every RPC in its own short transaction, so it cannot hold a
 * transaction open while a second session acts. Driving real `psql` sessions lets a test open
 * `BEGIN`, run the sale RPC, observe from a third session that the correction RPC is waiting on
 * (or has already passed) a lock, and only then commit. No new npm dependency is needed.
 *
 * Isolation (P130-12): the container runs with `--network none`, so nothing inside it can reach any
 * host, and the two cron jobs that POST to the hosted ingest functions are deactivated right after
 * the migration that schedules them and asserted inactive before any test runs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const IMAGE = process.env.P132C_PG_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.158'
export const HOSTED_INGEST_JOB_FILTER = "command ~ '/functions/v1/ingest-(prices|fx)'"

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(command: string, args: readonly string[], input?: string): Promise<RunResult> {
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
      `${command} ${args.slice(0, 4).join(' ')} failed (${result.code}): ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** One-shot psql as the bootstrap superuser. Throws on the first SQL error. */
export function psqlAdmin(container: string, sql: string): Promise<string> {
  return must(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    sql,
  )
}

export interface DisposableDb {
  container: string
  /** true when this process created the container and must remove it. */
  owned: boolean
}

/**
 * Starts (or attaches to, with P132C_PG_CONTAINER) a database holding every migration in the
 * checkout this file lives in, plus the synthetic catalog seed. Attach mode assumes migrations are
 * already applied (for example the CI stack's `supabase_db_*` container) and only enforces the cron
 * isolation.
 */
export async function startDb(log: (line: string) => void = () => {}): Promise<DisposableDb> {
  const attach = process.env.P132C_PG_CONTAINER
  if (attach) {
    await disableHostedIngestCron(attach)
    await assertCronIsolated(attach)
    return { container: attach, owned: false }
  }

  const container = `p132c-finance-${randomBytes(4).toString('hex')}`
  const password = randomBytes(18).toString('hex')
  await must('docker', [
    'run',
    '-d',
    '--name',
    container,
    '--network',
    'none',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    IMAGE,
  ])
  try {
    // The image restarts Postgres once after its init scripts; require consecutive successes.
    let streak = 0
    for (let attempt = 0; attempt < 240 && streak < 3; attempt += 1) {
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

    const migrationsDir = join(REPO_ROOT, 'supabase', 'migrations')
    const files = readdirSync(migrationsDir)
      .filter((name) => /^\d{14}_.+\.sql$/.test(name))
      .sort()
    log(`applying ${files.length} migrations into ${container}`)
    let cronDisabledAfter: string | null = null
    for (const file of files) {
      await psqlAdmin(container, readFileSync(join(migrationsDir, file), 'utf8'))
      if (cronDisabledAfter === null) {
        const disabled = await disableHostedIngestCron(container)
        if (disabled > 0) cronDisabledAfter = file
      }
    }
    await psqlAdmin(
      container,
      readFileSync(join(REPO_ROOT, 'supabase', 'seed', '0001_catalog.sql'), 'utf8'),
    )
    await assertCronIsolated(container)
    log(`hosted ingest cron jobs deactivated right after ${cronDisabledAfter ?? '(none found)'}`)
    // Determinism, not isolation: the every-minute M12 drain takes the per-user recompute queue
    // row lock that every ledger write also takes. Left running, it would add a random third lock
    // holder to the concurrency tests. Only in a container this process owns.
    await psqlAdmin(
      container,
      "select cron.alter_job(jobid, active := false) from cron.job where jobname in ('m12-recompute-snapshots', 'm12-daily-snapshot-sweep');",
    )
    return { container, owned: true }
  } catch (error) {
    await run('docker', ['rm', '-f', '-v', container])
    throw error
  }
}

async function disableHostedIngestCron(container: string): Promise<number> {
  const hasCron = (
    await psqlAdmin(container, "select count(*) from pg_namespace where nspname = 'cron';")
  ).trim()
  if (hasCron !== '1') return 0
  const active = Number(
    (
      await psqlAdmin(
        container,
        `select count(*) from cron.job where active and ${HOSTED_INGEST_JOB_FILTER};`,
      )
    ).trim(),
  )
  if (active > 0) {
    await psqlAdmin(
      container,
      `select cron.alter_job(jobid, active := false) from cron.job where ${HOSTED_INGEST_JOB_FILTER};`,
    )
  }
  return active
}

export async function assertCronIsolated(container: string): Promise<void> {
  const row = (
    await psqlAdmin(
      container,
      `select count(*) || '/' || count(*) filter (where active) from cron.job where ${HOSTED_INGEST_JOB_FILTER};`,
    )
  ).trim()
  const [total, active] = row.split('/').map(Number)
  if (active !== 0) {
    throw new Error(`P130-12 isolation failed: ${String(active)} hosted ingest cron job(s) active`)
  }
  if (total !== 2) {
    // Not fatal for isolation (nothing active), but the filter no longer matches what it was
    // written for; say so rather than silently passing.
    console.warn(`p132c: expected 2 hosted ingest cron jobs, found ${String(total)} (none active)`)
  }
}

export async function stopDb(db: DisposableDb): Promise<void> {
  if (db.owned && !process.env.P132C_KEEP_CONTAINER) {
    await run('docker', ['rm', '-f', '-v', db.container])
  }
}

export interface StatementResult {
  ok: boolean
  /** Raw unaligned output lines of the statement (psql -At). */
  rows: string[]
  sqlstate: string | null
  message: string | null
}

/**
 * A long-lived psql session. `exec` resolves only when the statement finishes, so a statement that
 * waits on a row lock simply leaves its promise pending — which is exactly what the concurrency
 * tests observe (through `pg_stat_activity` from another session, never through timing).
 *
 * Errors are read back from psql's own `ERROR` / `SQLSTATE` / `LAST_ERROR_MESSAGE` variables, so the
 * result never depends on stdout/stderr interleaving.
 */
export class PgSession {
  private readonly child: ChildProcessWithoutNullStreams
  private buffer = ''
  private counter = 0
  private pending: { marker: string; resolve: (lines: string[]) => void } | null = null
  private closed = false
  pid = 0

  private constructor(
    container: string,
    readonly applicationName: string,
    dbUser: string,
  ) {
    this.child = spawn(
      'docker',
      [
        'exec',
        '-i',
        container,
        'psql',
        '-X',
        '-q',
        '-At',
        '-v',
        'ON_ERROR_STOP=0',
        '-U',
        dbUser,
        '-d',
        'postgres',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      this.buffer += chunk
      this.drain()
    })
    // Error text is taken from psql variables; stderr is drained only so the pipe never fills.
    this.child.stderr.setEncoding('utf8').on('data', () => {})
    this.child.on('close', () => {
      this.closed = true
    })
  }

  /**
   * `dbUser` 'supabase_admin' (superuser: fixtures, snapshots, lock observation) or 'postgres'
   * (then `set role authenticated` per user, the same privilege path PostgREST uses).
   */
  static async open(
    container: string,
    applicationName: string,
    dbUser: string,
  ): Promise<PgSession> {
    const session = new PgSession(container, applicationName, dbUser)
    await session.value(`set application_name = '${applicationName}'`)
    session.pid = Number(await session.value('select pg_backend_pid()'))
    return session
  }

  private drain(): void {
    if (!this.pending) return
    const index = this.buffer.indexOf(this.pending.marker)
    if (index < 0) return
    const end = this.buffer.indexOf('\n', index)
    if (end < 0) return
    const body = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end + 1)
    const pending = this.pending
    this.pending = null
    pending.resolve(body.split(/\r?\n/))
  }

  /** Sends one SQL statement (must not contain psql meta-commands) and waits for completion. */
  exec(sql: string): Promise<StatementResult> {
    if (this.closed) return Promise.reject(new Error(`${this.applicationName}: session closed`))
    if (this.pending) {
      return Promise.reject(new Error(`${this.applicationName}: statement already in flight`))
    }
    this.counter += 1
    const marker = `__P132C_${this.applicationName}_${String(this.counter)}__`
    const statement = sql.trim().replace(/;\s*$/, '')
    const promise = new Promise<string[]>((resolveLines) => {
      this.pending = { marker, resolve: resolveLines }
    })
    this.child.stdin.write(
      `${statement};\n` +
        `\\if :ERROR\n\\echo __P132C_ERR__ :SQLSTATE :LAST_ERROR_MESSAGE\n\\endif\n` +
        `\\echo ${marker}\n`,
    )
    return promise.then((lines) => {
      const markerLine = lines.pop() ?? ''
      if (!markerLine.includes(marker)) throw new Error('p132c: protocol desync')
      const errorIndex = lines.findIndex((line) => line.startsWith('__P132C_ERR__ '))
      if (errorIndex >= 0) {
        const rest = (lines[errorIndex] ?? '').slice('__P132C_ERR__ '.length)
        const space = rest.indexOf(' ')
        return {
          ok: false,
          rows: lines.slice(0, errorIndex),
          sqlstate: space < 0 ? rest : rest.slice(0, space),
          message: space < 0 ? '' : rest.slice(space + 1),
        }
      }
      return {
        ok: true,
        rows: lines.filter((line) => line.length > 0),
        sqlstate: null,
        message: null,
      }
    })
  }

  /** exec + throw on error; returns the first output line. */
  async value(sql: string): Promise<string> {
    const result = await this.exec(sql)
    if (!result.ok) {
      throw new Error(
        `${this.applicationName}: ${result.sqlstate ?? '?'} ${result.message ?? ''}\n  in: ${sql.slice(0, 400)}`,
      )
    }
    return result.rows[0] ?? ''
  }

  async json<T>(sql: string): Promise<T> {
    return JSON.parse(await this.value(sql)) as T
  }

  /** A method, not a getter: callers re-check it after an await, which type narrowing would hide. */
  isBusy(): boolean {
    return this.pending !== null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.child.stdin.end('\\q\n')
    await new Promise<void>((resolveClose) => {
      if (this.closed) resolveClose()
      else
        this.child.on('close', () => {
          resolveClose()
        })
    })
  }
}
