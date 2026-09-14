import { spawn, spawnSync } from 'node:child_process'

/**
 * P132-A: a raw postgres session for tests that need transaction control the supabase-js/
 * PostgREST surface cannot give them — specifically, holding a lock across an artificial delay to
 * prove which of two competing transactions gets a row lock first (P130-03's held-lock race
 * tests). Talks to the SAME database `tests/db` already runs every other suite against (`DB_URL`,
 * exported to the environment by CI's db-tests job and by `pnpm exec supabase status -o env`
 * locally) — never a second, separate database.
 *
 * Two execution paths, chosen automatically:
 *  - a native `psql` on PATH (every GitHub Actions db-tests runner has one — the job's own
 *    "Ensure a psql client is present" step already proves it before `pnpm test:db` runs);
 *  - otherwise, `docker exec` into whichever running container publishes the port named in
 *    `DB_URL` (the local Windows dev path, where a native `psql.exe` is not assumed to exist —
 *    the exact technique P130 Track A's adversarial harness used, generalised here to find the
 *    container by port instead of a hardcoded name, since a worktree may run its own isolated
 *    stack on non-default ports).
 * Never used to reach anything but the local/CI ephemeral stack this test run already owns.
 */

function commandExists(cmd: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd])
  return probe.status === 0
}

function dbUrl(): string {
  const url = process.env.DB_URL
  if (!url) {
    throw new Error(
      'DB_URL is not set. Export it the same way CI does: ' +
        '`pnpm exec supabase status -o env` and read DB_URL from the output.',
    )
  }
  return url
}

let cachedContainer: string | null | undefined

/** Finds the running docker container that publishes the DB_URL's port on 127.0.0.1. */
function dockerContainerForDbPort(): string | null {
  if (cachedContainer !== undefined) return cachedContainer
  const port = new URL(dbUrl()).port
  const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { encoding: 'utf8' })
  if (ps.status !== 0) {
    cachedContainer = null
    return null
  }
  const needle = `:${port}->5432/tcp`
  const line = ps.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes(needle))
  cachedContainer = line ? (line.split('\t')[0] ?? null) : null
  return cachedContainer
}

/** True when this environment can actually run a raw SQL session (see module header). */
export function rawSqlAvailable(): boolean {
  if (!process.env.DB_URL) return false
  if (commandExists('psql')) return true
  return dockerContainerForDbPort() !== null
}

export interface RawSqlResult {
  code: number
  output: string
}

/**
 * Runs `sql` to completion in a fresh postgres session (blocking until the process exits) and
 * returns its exit code and combined stdout+stderr. `-tA` (tuples only, unaligned) keeps output
 * parseable; `ON_ERROR_STOP=1` makes any SQL error abort the session with a non-zero exit instead
 * of silently continuing to the next statement.
 */
export function runRawSqlAsync(sql: string): Promise<RawSqlResult> {
  return new Promise((resolve, reject) => {
    const useNativePsql = commandExists('psql')
    const container = useNativePsql ? null : dockerContainerForDbPort()
    if (!useNativePsql && !container) {
      reject(
        new Error(
          'no psql on PATH and no docker container publishes the DB_URL port — cannot run a raw SQL session',
        ),
      )
      return
    }
    const cmd: string = useNativePsql ? 'psql' : 'docker'
    const args: string[] = useNativePsql
      ? [dbUrl(), '-X', '-tA', '-v', 'ON_ERROR_STOP=1']
      : [
          'exec',
          '-i',
          container as string,
          'psql',
          '-U',
          'postgres',
          '-X',
          '-tA',
          '-v',
          'ON_ERROR_STOP=1',
        ]
    const p = spawn(cmd, args)
    let out = ''
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    p.stderr.on('data', (d: Buffer) => {
      out += d.toString()
    })
    p.on('error', reject)
    p.on('close', (code) => {
      resolve({ code: code ?? 1, output: out })
    })
    p.stdin.end(sql)
  })
}

/**
 * Wraps `body` so it runs as the given authenticated user, the same technique PostgREST itself
 * uses (`request.jwt.claims` + the `authenticated` role) — the only way a raw session can exercise
 * RLS and `auth.uid()`-based RPCs as a specific real user rather than as the postgres superuser.
 */
export function asUser(userId: string, body: string): string {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' })
  return `begin;\nselect set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', true);\nset local role authenticated;\n${body}\ncommit;`
}
