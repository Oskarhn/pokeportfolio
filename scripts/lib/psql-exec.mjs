/**
 * P105: a single, resilient `psql` invocation path shared by every benchmark/seed script that
 * needs raw SQL access (`portfolio-perf-benchmark.mjs`, `portfolio-snapshots-benchmark.mjs`,
 * `scanner-visual-index/seed-local-demo-catalog.mjs`) — all three previously called
 * `execFileSync('psql', ...)` directly and simply failed outright on a machine with no native
 * `psql` client on PATH (this one included). P104 worked around that with a temporary,
 * git-reverted local patch routing through a HARDCODED `docker exec <container-id> psql` — real
 * for one session, but not something a future session (or CI) could rely on.
 *
 * Resolution order, decided ONCE per process and cached:
 *   1. Native `psql` on PATH — used as-is, exactly as every call site already did.
 *   2. A running local Supabase Postgres container, discovered by NAME PATTERN (`docker ps
 *      --filter name=supabase_db_`) — never a hardcoded container id, since that changes on every
 *      `pnpm db:start`/`supabase start`. Commands run via `docker exec -i <container> psql -U
 *      postgres -d postgres`, the fixed local-stack superuser Supabase's CLI always provisions —
 *      the caller's own `DB_URL` (a host-side `postgresql://postgres:postgres@127.0.0.1:<port>/…`
 *      string, meaningless from inside the container) is used ONLY to confirm the caller believes
 *      it is talking to the local stack (refused otherwise by lib/local-target.mjs on EVERY path,
 *      native psql included), never passed through to the container's own `psql`.
 *   3. Neither available — throw a clear, actionable error naming both attempted paths, rather
 *      than letting execFileSync's own ENOENT bubble up unexplained.
 */
import { execFileSync } from 'node:child_process'
import { assertLocalUrl } from './local-target.mjs'

let resolved = null

export function nativePsqlAvailable() {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function findLocalSupabaseContainer() {
  try {
    const out = execFileSync(
      'docker',
      ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}'],
      { encoding: 'utf8' },
    ).trim()
    const names = out.split('\n').filter(Boolean)
    return names[0] ?? null
  } catch {
    return null
  }
}

function resolveMode() {
  if (resolved !== null) return resolved
  if (nativePsqlAvailable()) {
    resolved = { mode: 'native' }
    return resolved
  }
  const container = findLocalSupabaseContainer()
  if (container !== null) {
    resolved = { mode: 'docker', container }
    console.log(
      `psql-exec: no native psql on PATH — using \`docker exec ${container} psql\` instead.`,
    )
    return resolved
  }
  throw new Error(
    'psql-exec: no native `psql` on PATH, and no running `supabase_db_*` Docker container found ' +
      '(`docker ps --filter name=supabase_db_` returned nothing). Install psql, or start the ' +
      'local Supabase stack (`pnpm db:start`).',
  )
}

/**
 * Same call shape as `execFileSync('psql', [dbUrl, ...args], options)` — returns the command's
 * stdout as a string when `options.encoding` is set, matching every existing call site.
 */
export function runPsql(dbUrl, args, options = {}) {
  // P206: psql would fall back to PGHOST & co. without a URL, and the docker fallback ignores the
  // URL entirely, so a missing or non-local DB_URL is refused before either path is chosen. The
  // check is the shared fail-closed one (lib/local-target.mjs) and never echoes the URL.
  if (typeof dbUrl !== 'string' || dbUrl === '') {
    throw new Error(
      'psql-exec: a local DB_URL is required; refusing to fall back to PG* variables.',
    )
  }
  assertLocalUrl('DB_URL', dbUrl)
  const mode = resolveMode()
  if (mode.mode === 'native') {
    return execFileSync('psql', [dbUrl, ...args], options)
  }
  return execFileSync(
    'docker',
    ['exec', '-i', mode.container, 'psql', '-U', 'postgres', '-d', 'postgres', ...args],
    options,
  )
}
