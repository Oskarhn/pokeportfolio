/**
 * Lock-state driven interleavings. Nothing here sleeps to "give the other session time": a session
 * is considered settled only when it has finished its statement or when `pg_stat_activity` shows it
 * waiting on a heavyweight lock. The poll interval only bounds how often the observer looks.
 */
import type { PgSession, StatementResult } from './docker-pg'
import { classify, type Outcome } from './ledger'

export interface Settled {
  state: 'completed' | 'blocked'
  blockers: number[]
}

const POLL_MS = 15
const SETTLE_TIMEOUT_MS = Number(process.env.P132C_SETTLE_TIMEOUT_MS ?? 30_000)

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export async function waitSettled(observer: PgSession, session: PgSession): Promise<Settled> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!session.isBusy()) return { state: 'completed', blockers: [] }
    const row = await observer.json<{ wait: string | null; blockers: number[] } | null>(
      `select to_jsonb(x) from (select wait_event_type as wait, pg_blocking_pids(pid) as blockers from pg_stat_activity where pid = ${String(session.pid)}) x`,
    )
    if (!session.isBusy()) return { state: 'completed', blockers: [] }
    if (row && row.wait === 'Lock' && row.blockers.length > 0) {
      return { state: 'blocked', blockers: row.blockers }
    }
    await sleep(POLL_MS)
  }
  throw new Error(
    `${session.applicationName}: neither completed nor lock-blocked within ${String(SETTLE_TIMEOUT_MS)} ms`,
  )
}

export async function awaitAllCompleted(sessions: PgSession[]): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS * 2
  while (sessions.some((s) => s.isBusy())) {
    if (Date.now() > deadline) throw new Error('sessions did not complete')
    await sleep(POLL_MS)
  }
}

export interface HeldRaceResult {
  first: Outcome
  second: Outcome
  /** Observation only — whether the second statement had to wait for the first transaction. */
  secondWaitedForFirst: boolean
}

/**
 * `first` runs inside an explicit transaction and finishes its statement while holding every lock it
 * took. `second` is then issued (autocommit). Once `second` is observed completed or lock-blocked,
 * `first` commits, and `second` is awaited. The interleaving is fixed by lock state, so the same
 * code on the same implementation produces the same result every run.
 */
export async function heldRace(
  observer: PgSession,
  first: { session: PgSession; sql: string },
  second: { session: PgSession; sql: string },
): Promise<HeldRaceResult> {
  await first.session.value('begin')
  let firstResult: StatementResult
  try {
    firstResult = await first.session.exec(first.sql)
  } catch (error) {
    await first.session.exec('rollback')
    throw error
  }
  if (!firstResult.ok) {
    await first.session.exec('rollback')
    return {
      first: classify(firstResult),
      second: {
        kind: 'unexpected_error',
        sqlstate: null,
        message: 'not run: first failed',
        rows: [],
      },
      secondWaitedForFirst: false,
    }
  }
  const secondPromise = second.session.exec(second.sql)
  let settled: Settled
  try {
    settled = await waitSettled(observer, second.session)
  } catch (error) {
    await first.session.exec('rollback')
    await secondPromise
    throw error
  }
  const commit = await first.session.exec('commit')
  const secondResult = await secondPromise
  return {
    first: commit.ok ? classify(firstResult) : classify(commit),
    second: classify(secondResult),
    secondWaitedForFirst:
      settled.state === 'blocked' && settled.blockers.includes(first.session.pid),
  }
}

/** Rolls back anything a failed test left open; harmless when idle. */
export async function resetSessions(sessions: PgSession[]): Promise<void> {
  await awaitAllCompleted(sessions)
  for (const session of sessions) await session.exec('rollback')
}
