import { Client } from 'pg'

/**
 * P132-B concurrency harness (P130-03). The DB/authorization suites in tests/db/** exercise the
 * REST-facing supabase-js client, where every RPC call is its own independent HTTP request and
 * therefore its own independent transaction on the server — that is enough to prove an outcome
 * ("both concurrent calls commit, exactly one purchase exists"), but it gives the test no control
 * over exactly WHEN each side's transaction commits relative to the other's. Proving a check-then-
 * act race deterministically needs the opposite: one real transaction held open across two
 * separate SQL statements, with the test itself controlling the moment it commits.
 *
 * `HeldLockSession` gives a test a raw connection to the SAME database `pnpm test:db` already
 * targets (`DB_URL`, exported by `pnpm exec supabase status -o env` locally, or by the db-tests CI
 * job — the exact variable `.github/workflows/ci.yml` already writes to `$GITHUB_ENV`, so this
 * needs no new CI wiring), speaking directly to Postgres as the `postgres` role. Every RPC in this
 * codebase derives its acting user from `auth.uid()`, which resolves the same
 * `request.jwt.claim.sub` GUC PostgREST sets on every request (`auth.uid()`'s own definition) — so
 * `beginAs(userId)` reproduces exactly what a real authenticated RPC call sees, without needing a
 * JWT at all. The `postgres` role bypasses RLS the same way SECURITY DEFINER functions already do
 * server-side; every function under test enforces `user_id = auth.uid()` itself, which is the same
 * authorization boundary a real request goes through.
 *
 * The synchronization primitive is `waitUntilLockWaiting`: it polls `pg_stat_activity` for the
 * OTHER session's backend to report `wait_event_type = 'Lock'` before either side proceeds.
 * Deliberately not a `pg_sleep`-based guess — the prompt this harness was built for (P132-B) asks
 * for "deterministic two-session held-lock orchestration" and explicitly warns against
 * "timing-only sleeps as primary proof." A test that reaches its lock-wait assertion has PROVEN
 * the two sessions are genuinely serialized on the row in question, not merely timed to look that
 * way.
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Run \`pnpm db:start\` then export it from ` +
        '`pnpm exec supabase status -o env` (the same DB_URL the db-tests CI job already exports) ' +
        'before running this suite.',
    )
  }
  return value
}

export class HeldLockSession {
  readonly client: Client
  readonly pid: number
  private ended = false

  private constructor(client: Client, pid: number) {
    this.client = client
    this.pid = pid
  }

  /** Opens a fresh connection, starts an explicit transaction, and sets auth.uid() to `userId`. */
  static async beginAs(userId: string): Promise<HeldLockSession> {
    const client = new Client({ connectionString: requireEnv('DB_URL') })
    await client.connect()
    const pidResult = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
    const pid = pidResult.rows[0]?.pid
    if (pid === undefined) throw new Error('could not read pg_backend_pid()')
    await client.query('BEGIN')
    // `true` (is_local) scopes the setting to this transaction — it never leaks to a later
    // transaction on a pooled/reused connection, matching how PostgREST scopes it per request.
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId])
    return new HeldLockSession(client, pid)
  }

  /** Sends a query and returns once Postgres responds. Statement-level, not connection-level: the
   *  caller decides whether to await it immediately (an unblocking call) or capture the promise and
   *  await it later (a call expected to block on another session's held lock). */
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> {
    return this.client.query<Row>(sql, params).then((r) => r.rows)
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT')
    await this.end()
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK')
    await this.end()
  }

  /** Best-effort cleanup for a test that throws before an explicit commit/rollback. */
  async end(): Promise<void> {
    if (this.ended) return
    this.ended = true
    try {
      await this.client.query('ROLLBACK')
    } catch {
      // Already committed/rolled back, or the connection is already broken — either way there is
      // nothing left to roll back.
    }
    await this.client.end()
  }
}

/**
 * A test captures a query's promise without awaiting it immediately (it needs to poll for the
 * OTHER session's lock wait first) and only awaits/asserts on it later, once the race has played
 * out. Node flags a promise that rejects before anything is attached to it as an "unhandled
 * rejection" even when a `.catch`/`expect(...).rejects` attaches moments later — a harmless
 * diagnostic in this pattern (the rejection IS the assertion), but noisy in CI output. Attaching a
 * no-op rejection handler immediately, and returning the SAME promise for the real assertion to
 * consume, silences the warning without changing what the test observes.
 */
export function silenceUnhandledRejection<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

export async function connectMonitor(): Promise<Client> {
  const client = new Client({ connectionString: requireEnv('DB_URL') })
  await client.connect()
  return client
}

/**
 * Polls `pg_stat_activity` until `pid` is reported waiting on a lock, or throws after `timeoutMs`.
 * Throwing here means the harness itself failed to synchronize (the two sessions were never
 * actually contending for the same row) — a DIFFERENT failure mode than the invariant assertions
 * later in each test, and deliberately labelled as such so a harness bug is never misread as a
 * passing (or failing) proof of the RPC's own locking behaviour.
 */
export async function waitUntilLockWaiting(
  monitor: Client,
  pid: number,
  timeoutMs = 5000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await monitor.query<{
      wait_event_type: string | null
      state: string | null
      query: string | null
    }>('select wait_event_type, state, query from pg_stat_activity where pid = $1', [pid])
    const row = result.rows[0]
    if (row?.wait_event_type === 'Lock') return
    if (Date.now() > deadline) {
      throw new Error(
        `HARNESS SYNCHRONIZATION FAILURE: backend ${pid} never entered a lock wait within ` +
          `${timeoutMs}ms (last seen: state=${row?.state ?? '(backend gone)'}, ` +
          `wait_event_type=${row?.wait_event_type ?? 'null'}, query=${row?.query ?? 'n/a'}). ` +
          'This means the two sessions were not actually contending for the same row -- the test ' +
          'below proves nothing about the RPC under test until this is fixed.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** Polls until `pid` is no longer present in pg_stat_activity (its connection has fully closed). */
export async function waitUntilGone(
  monitor: Client,
  pid: number,
  timeoutMs = 5000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await monitor.query<{ pid: number }>(
      'select pid from pg_stat_activity where pid = $1',
      [pid],
    )
    if (result.rows.length === 0) return
    if (Date.now() > deadline) {
      throw new Error(`backend ${pid} was still present in pg_stat_activity after ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
