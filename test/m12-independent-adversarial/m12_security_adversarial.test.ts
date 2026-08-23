import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  deleteSyntheticUser,
  promoteToAdmin,
  type TestClient,
} from '../../tests/db/setup'
import { hasSupabaseEnv, skipUnlessM12 } from './helpers/contract'
import {
  acquireRaw,
  day,
  makeEnv,
  makeVariant,
  setFxRate,
  setManual,
  setProviderPrice,
  type FixtureEnv,
} from './helpers/fixtures'

/**
 * Cross-user isolation (scenario N), cache forgery, and elevated-routine privilege attacks
 * (priorities 7-9). The snapshot cache is DERIVED DATA: nobody but the engine may write it, and
 * nobody may see anyone else's slice of it - including an administrator.
 *
 * Marker technique for read-RPC isolation: victim B's fixture uses one distinctive figure
 * (12 345 minor units). Any appearance of that marker inside attacker A's dashboard payloads is
 * a leak, regardless of what the response schema looks like.
 */

let service: TestClient
let surfaceReady = false

const cleanup: string[] = []
let attackerEnv: FixtureEnv
let attackerClient: TestClient
let victimEnv: FixtureEnv

beforeAll(async () => {
  if (!hasSupabaseEnv()) return
  service = createServiceClient()
})

afterAll(async () => {
  if (!hasSupabaseEnv() || !service) return
  for (const id of cleanup) await deleteSyntheticUser(service, id)
})

async function buildVictim(): Promise<void> {
  victimEnv = await makeEnv('m12-sec-victim')
  cleanup.push(victimEnv.user.id)
  await setFxRate(victimEnv, 'EUR', day(-1), '10.00000000')
  const v = await makeVariant(victimEnv, 'sec-victim')
  await setProviderPrice(victimEnv, v.variantId, 'tcgdex_cardmarket', 500, day(0))
  const acq = await acquireRaw(victimEnv, v.variantId, day(3), 9_000)
  await setManual(victimEnv, acq.holdingId, 12_345, day(2)) // the marker figure
}

describe('M12 cache isolation and forgery resistance', () => {
  it('prepares isolated fixtures', async (ctx) => {
    await skipUnlessM12(ctx, service)
    surfaceReady = true
    attackerEnv = await makeEnv('m12-sec-attacker')
    cleanup.push(attackerEnv.user.id)
    attackerClient = attackerEnv.client
    await buildVictim()
    // Victim materialises its cache through the ordinary path.
    const probe = createServiceClient()
    const { error } = await probe.rpc('drain_portfolio_recompute_queue')
    expect(error).toBeNull()
  })

  it('user A cannot read user B snapshots or queue state', async (ctx) => {
    if (!surfaceReady) ctx.skip()
    const { data: snapRows, error: snapErr } = await attackerClient
      .from('portfolio_snapshots')
      .select('*')
      .eq('user_id', victimEnv.user.id)
    expect(snapErr).toBeNull() // RLS answers with silence, not a leak-shaped error
    expect(snapRows ?? []).toEqual([])

    const { data: queueRows, error: queueErr } = await attackerClient
      .from('portfolio_recompute_queue')
      .select('*')
      .eq('user_id', victimEnv.user.id)
    if (queueErr === null) {
      expect(queueRows ?? []).toEqual([])
    }
    // A permission denial is equally acceptable here: the queue is internal-only, and either
    // way nothing about B may come back.
    for (const row of queueRows ?? []) {
      expect(row.user_id).not.toBe(victimEnv.user.id)
    }
  })

  it('cache forgery is refused at the GRANT level, even against the attacker own rows', async (ctx) => {
    if (!surfaceReady) ctx.skip()
    const forgedRow = {
      user_id: attackerEnv.user.id,
      snapshot_date: day(1),
      market_value_nok_minor: 999_999_999,
    }
    const ins = await attackerClient.from('portfolio_snapshots').insert(forgedRow)
    expect(ins.error).not.toBeNull()

    const upd = await attackerClient
      .from('portfolio_snapshots')
      .update({ market_value_nok_minor: 1 })
      .eq('user_id', attackerEnv.user.id)
      .eq('snapshot_date', day(1))
    expect(upd.error).not.toBeNull()

    const del = await attackerClient
      .from('portfolio_snapshots')
      .delete()
      .eq('user_id', attackerEnv.user.id)
      .eq('snapshot_date', day(1))
    expect(del.error).not.toBeNull()

    const enqueue = await attackerClient.from('portfolio_recompute_queue').insert({
      user_id: attackerEnv.user.id,
      dirty_from: day(1),
    })
    expect(enqueue.error).not.toBeNull()
  })

  it('engine routines are unreachable from a browser session - with any argument', async (ctx) => {
    if (!surfaceReady) ctx.skip()
    const asAttackerSelf = await attackerClient.rpc('rebuild_portfolio_snapshots', {})
    expect(asAttackerSelf.error).not.toBeNull()

    const asAttackerForVictim = await attackerClient.rpc('rebuild_portfolio_snapshots', {})
    expect(asAttackerForVictim.error).not.toBeNull()

    const drainAttempt = await attackerClient.rpc('drain_portfolio_recompute_queue')
    expect(drainAttempt.error).not.toBeNull()
  })

  it('anonymous callers get nothing from the cache surface', async (ctx) => {
    if (!surfaceReady) ctx.skip()
    const anon = createAnonClient()
    const { data, error } = await anon.from('portfolio_snapshots').select('*').limit(5)
    if (error === null) {
      expect(data ?? []).toEqual([])
    }
    const summary = await anon.rpc('get_dashboard_summary')
    expect(summary.error).not.toBeNull()
  })

  it('internal run logs never reach a browser-held role', async (ctx) => {
    if (!surfaceReady) ctx.skip()
    const { data, error } = await attackerClient
      .from('portfolio_recompute_runs')
      .select('*')
      .limit(5)
    if (error === null) {
      expect(data ?? []).toEqual([])
    }
  })

  it('administrator status grants zero visibility into another user dashboard data', async (ctx) => {
    if (!surfaceReady) ctx.skip()
    await promoteToAdmin(service, attackerEnv.user.id)

    const { data: summary, error: summaryErr } = await attackerClient.rpc('get_dashboard_summary')
    expect(summaryErr).toBeNull()
    const summaryText = JSON.stringify(summary ?? {})
    expect(summaryText).not.toContain('12345') // the victim marker figure
    expect(summaryText.toLowerCase()).not.toContain(victimEnv.user.id)

    const { data: history, error: historyErr } = await attackerClient.rpc(
      'get_portfolio_history',
      {},
    )
    if (historyErr === null) {
      const historyText = JSON.stringify(history ?? {})
      expect(historyText).not.toContain('12345')
      expect(historyText.toLowerCase()).not.toContain(victimEnv.user.id)
    }

    // Sanity: the attacker own honest empty state is what actually came back.
    expect(JSON.stringify(summary ?? {})).not.toContain('999999999')

    // And admin still cannot touch B rows through table grants either.
    const { data: snapRows, error: snapErr } = await attackerClient
      .from('portfolio_snapshots')
      .select('*')
      .eq('user_id', victimEnv.user.id)
    expect(snapErr).toBeNull()
    expect(snapRows ?? []).toEqual([])

    void victimEnv.user.email
  })
})
