import type { Client as PgClient } from 'pg'
import type { TestClient } from '../../../db/setup'

/**
 * Leaves no portfolio recompute pending or in flight for `userIds`, so a baseline of every user-owned
 * table (including `portfolio_snapshots`) can be compared strictly afterwards.
 *
 * The ledger triggers enqueue a recompute that a pg_cron worker drains into `portfolio_snapshots`
 * (m12) — derived bookkeeping written by the scheduler, not by any page. Draining once is not enough
 * when another worker is draining too (P165): the drain is ONE transaction that takes
 * `FOR UPDATE SKIP LOCKED` on up to 100 users' queue rows, so a concurrent drain from another spec
 * can be holding THIS spec's rows. Our own call then skips them, returns at once, and the baseline is
 * taken before the other transaction commits and rewrites the snapshots. A queue row stays visible
 * until the transaction that processes it commits, so "no due row left for my users" is the barrier:
 * it holds only once every drain that had them has finished.
 *
 * Rows dated in the future are not due and are never drained; they are not waited for.
 */
export async function settleDerivedTables(
  service: Pick<TestClient, 'rpc'>,
  pg: Pick<PgClient, 'query'>,
  userIds: readonly string[],
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { error } = await service.rpc('drain_portfolio_recompute_queue', { p_batch_users: 100 })
    if (error) throw new Error(`drain_portfolio_recompute_queue failed: ${error.message}`)
    const due = await pg.query<{ n: number }>(
      `select count(*)::int as n
         from public.portfolio_recompute_queue
        where user_id = any($1::uuid[]) and dirty_from <= current_date`,
      [userIds],
    )
    if ((due.rows[0]?.n ?? 0) === 0) return
    if (Date.now() >= deadline) {
      throw new Error(
        `the portfolio recompute queue still holds ${String(due.rows[0]?.n)} due row(s) for these users after ${String(timeoutMs)} ms`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
