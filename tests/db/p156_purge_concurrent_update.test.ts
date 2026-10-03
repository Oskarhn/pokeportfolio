import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type TestClient,
} from './setup'
import { beginRecorded, connectDb } from './lib/account-deletion-deps'
import { connectMonitor, waitUntilLockWaiting } from './lib/held-lock-session'

/**
 * P156: the purge selects a batch by ctid and deletes those tuples. A ctid names one physical row
 * VERSION, so a row that a writer with no user identity (a maintenance job, an operator) updates
 * while a batch is running can be missed by that batch: the DELETE waits for the row lock, then
 * re-checks the new version, whose ctid is no longer in the array.
 *
 * What must hold regardless: the purge never reports `complete` while a row it is responsible for
 * still exists, so the Edge Function cannot go on to delete the login on the strength of a purge
 * that missed a row and then report the account as fully deleted from the application's side.
 */

let service: TestClient
let db: pg.Client
let monitor: pg.Client
const created: string[] = []

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
  monitor = await connectMonitor()
})
afterAll(async () => {
  for (const id of created) {
    await service.from('account_deletion_requests').delete().eq('user_id', id)
    await deleteSyntheticUser(service, id)
  }
  await monitor.end()
  await db.end()
}, 120_000)

describe('the purge does not report complete over a row a concurrent update made it skip', () => {
  it('a tuple updated by a non-user writer during a batch is still purged before `complete`', async () => {
    const a = await createSyntheticUser(service, 'p156-ctid')
    created.push(a.id)
    for (let i = 0; i < 5; i++) {
      await service.from('tags').insert({ user_id: a.id, name: `t${i}` })
    }
    expect((await beginRecorded(service, a.id)).error).toBeNull()

    // Writer X (no user identity, so the pending guard does not apply) holds a row lock.
    const writer = new pg.Client({ connectionString: process.env.DB_URL })
    await writer.connect()
    await writer.query('begin')
    await writer.query(
      "update public.tags set name = 'edited' where id = (select id from public.tags where user_id = $1 order by name limit 1)",
      [a.id],
    )

    // The purge starts and parks behind X's row lock.
    const purger = new pg.Client({ connectionString: process.env.DB_URL })
    await purger.connect()
    const purgerPid = (await purger.query<{ pid: number }>('select pg_backend_pid() as pid'))
      .rows[0]!.pid
    const first = purger
      .query<{ r: { complete: boolean } }>('select public.purge_account_data($1, 1000) as r', [
        a.id,
      ])
      .catch((e: unknown) => e as Error)
    await waitUntilLockWaiting(monitor, purgerPid)
    await writer.query('commit')
    await writer.end()
    const firstResult = await first
    await purger.end()
    expect(firstResult).not.toBeInstanceOf(Error)

    // Whatever the first call reported, `complete: true` must mean nothing is left.
    const reported = (firstResult as { rows: { r: { complete: boolean } }[] }).rows[0]!.r
    const left = await db.query<{ n: number }>(
      'select count(*)::int as n from public.tags where user_id = $1',
      [a.id],
    )
    if (reported.complete) expect(left.rows[0]!.n).toBe(0)

    // And the loop the Edge Function runs converges to nothing left.
    for (let i = 0; i < 20; i++) {
      const next = await service.rpc('purge_account_data', { p_user_id: a.id })
      expect(next.error).toBeNull()
      if ((next.data as { complete: boolean }).complete) break
    }
    const after = await db.query<{ n: number }>(
      'select count(*)::int as n from public.tags where user_id = $1',
      [a.id],
    )
    expect(after.rows[0]!.n).toBe(0)
  }, 60_000)
})
