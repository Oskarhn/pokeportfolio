import type { TestClient } from '../setup'

/**
 * rebuild_portfolio_snapshots deletes and re-inserts a user's rows. The M9 cron drain can run the
 * same rebuild for the same user in another session while a long suite is running, and the two
 * inserts then collide on the primary key (23505). That is a race between two callers of a
 * service-only maintenance function, not a result: the loser is retried, any other error is
 * returned as is.
 */
export async function rebuildSnapshots(
  service: TestClient,
  userId: string,
  from: string,
  through: string,
) {
  let last = await service.rpc('rebuild_portfolio_snapshots', {
    p_user_id: userId,
    p_from: from,
    p_through: through,
  })
  for (let attempt = 0; attempt < 4 && last.error?.code === '23505'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    last = await service.rpc('rebuild_portfolio_snapshots', {
      p_user_id: userId,
      p_from: from,
      p_through: through,
    })
  }
  return last
}
