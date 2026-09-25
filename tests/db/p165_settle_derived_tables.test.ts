import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { settleDerivedTables } from '../e2e/authenticated/support/settle-derived-tables'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P165 — "drain once, then take the baseline" is not a barrier when another worker is draining.
 *
 * `drain_portfolio_recompute_queue` is one transaction that locks up to 100 users' queue rows with
 * `FOR UPDATE SKIP LOCKED`. Two authenticated E2E specs build a ledger and settle the queue at the
 * same moment when they run in parallel: each drain can hold the OTHER spec's rows, so a spec's own
 * drain skips its rows, returns at once, and its baseline is taken before the other transaction
 * commits and rewrites `portfolio_snapshots`. These tests build that interleaving with two real
 * sessions: the "other worker" is a raw session that runs the drain and does not commit yet.
 */

const DB_URL = process.env['DB_URL'] ?? ''

let service: TestClient
let user: SyntheticUser
let admin: Client

/** The rows of `user` the queue still shows, as another session sees them. */
async function dueRows(): Promise<number> {
  const result = await admin.query<{ n: number }>(
    `select count(*)::int as n from public.portfolio_recompute_queue
      where user_id = $1 and dirty_from <= current_date`,
    [user.id],
  )
  return result.rows[0]?.n ?? 0
}

beforeAll(async () => {
  service = createServiceClient()
  admin = new Client({ connectionString: DB_URL })
  await admin.connect()
  user = await createSyntheticUser(service, 'p165-settle')
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
  await admin.end()
})

/** One acquisition through the real RPC: its trigger enqueues a due recompute for the user. */
async function enqueueForUser(): Promise<void> {
  const client = await signInAs(user)
  const { error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: new Date().toISOString().slice(0, 10),
      p_client_request_key: crypto.randomUUID(),
    })
    .single()
  if (error) throw new Error(`add_card_acquisition failed: ${error.message}`)
}

/** A second worker that is draining: it has processed the queue in a transaction it has not
 *  committed, so the rows stay visible and locked to everyone else. */
async function otherWorkerDrainingWithoutCommit(): Promise<{ finish(): Promise<void> }> {
  const other = new Client({ connectionString: DB_URL })
  await other.connect()
  await other.query('begin')
  const drained = await other.query<{ n: number }>(
    'select public.drain_portfolio_recompute_queue(100) as n',
  )
  expect(drained.rows[0]?.n, 'the other worker took the row').toBeGreaterThanOrEqual(1)
  return {
    async finish() {
      await other.query('commit')
      await other.end()
    },
  }
}

describe('settling the portfolio recompute queue under a concurrent drain (P165)', () => {
  it('the premise: while another worker holds the row, a plain drain returns and the row is still due', async () => {
    await enqueueForUser()
    expect(await dueRows()).toBe(1)
    const other = await otherWorkerDrainingWithoutCommit()
    try {
      const { data, error } = await service.rpc('drain_portfolio_recompute_queue', {
        p_batch_users: 100,
      })
      expect(error).toBeNull()
      // SKIP LOCKED: nothing for this call to process, and it did not wait.
      expect(data).toBe(0)
      // ...yet the user's recompute has NOT been applied: a baseline taken now is premature.
      expect(await dueRows()).toBe(1)
    } finally {
      await other.finish()
    }
    expect(await dueRows()).toBe(0)
  })

  it('settleDerivedTables does not return while the other worker still holds the row, and returns once it commits', async () => {
    await enqueueForUser()
    const other = await otherWorkerDrainingWithoutCommit()
    let attempts = 0
    const counting: Pick<TestClient, 'rpc'> = {
      rpc: ((...args: Parameters<TestClient['rpc']>) => {
        attempts += 1
        return service.rpc(...args)
      }) as TestClient['rpc'],
    }
    let settled = false
    const settling = settleDerivedTables(counting, admin, [user.id]).then(() => {
      settled = true
    })
    try {
      // Barrier: it has tried several times and is demonstrably still waiting.
      const deadline = Date.now() + 10_000
      while (attempts < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      expect(attempts).toBeGreaterThanOrEqual(4)
      expect(settled).toBe(false)
      expect(await dueRows()).toBe(1)
    } finally {
      await other.finish()
    }
    await settling
    expect(settled).toBe(true)
    expect(await dueRows()).toBe(0)
  })

  it('gives up with a clear message when the rows never become free', async () => {
    await enqueueForUser()
    const other = await otherWorkerDrainingWithoutCommit()
    try {
      await expect(settleDerivedTables(service, admin, [user.id], 300)).rejects.toThrow(
        /still holds 1 due row\(s\)/,
      )
    } finally {
      await other.finish()
    }
  })

  it('does not wait for a row dated in the future (it is never drained), and ignores other users', async () => {
    await enqueueForUser()
    await service
      .from('portfolio_recompute_queue')
      .update({ dirty_from: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) })
      .eq('user_id', user.id)
    const started = Date.now()
    await settleDerivedTables(service, admin, [user.id], 5_000)
    expect(Date.now() - started).toBeLessThan(4_000)
    // a user with no rows at all is trivially settled
    await settleDerivedTables(service, admin, ['00000000-0000-4000-8000-000000000000'])
    await admin.query('delete from public.portfolio_recompute_queue where user_id = $1', [user.id])
  })
})
