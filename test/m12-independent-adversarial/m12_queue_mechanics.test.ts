import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceClient, deleteSyntheticUser, type TestClient } from '../../tests/db/setup'
import { bindParams, hasSupabaseEnv, skipUnlessM12, type M12Surface } from './helpers/contract'
import {
  acquireRaw,
  backdateAcquisition,
  day,
  drainQueue,
  makeEnv,
  makeVariant,
  readQueueRow,
  sellLots,
  setFxRate,
  setProviderPrice,
  voidSale,
  type FixtureEnv,
} from './helpers/fixtures'

/**
 * Queue mechanics: dirty_from coalescing boundaries (scenarios D/E/F/O), worker concurrency (Q),
 * failure retention (P), and the honest pending-recompute signal the dashboard must expose.
 *
 * Every scenario gets its own user so queue reads are unambiguous.
 */

let service: TestClient
const cleanupUsers: string[] = []

beforeAll(async () => {
  if (!hasSupabaseEnv()) return
  service = createServiceClient()
})

afterAll(async () => {
  if (!hasSupabaseEnv() || !service) return
  for (const id of cleanupUsers) await deleteSyntheticUser(service, id)
})

async function freshUser(label: string, surface: M12Surface): Promise<FixtureEnv> {
  const env = await makeEnv(label)
  cleanupUsers.push(env.user.id)
  await setFxRate(env, 'EUR', day(-1), '10.00000000')
  const v = await makeVariant(env, `q-${label}`)
  await setProviderPrice(env, v.variantId, 'tcgdex_cardmarket', 1000, day(0))
  void surface
  return env
}

describe('M12 recompute queue mechanics', () => {
  it('scenario D: backdating an acquisition dirties the NEW earlier date, not the old one', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    const env = await freshUser('d', surface)
    const acq = await acquireRaw(env, (await makeVariant(env, 'qd2')).variantId, day(40), 5_000)
    await drainQueue(surface)
    expect(await readQueueRow(env)).toBeNull()

    await backdateAcquisition(env, acq, 1, 5_000, day(30))
    const row = await readQueueRow(env)
    expect(row).not.toBeNull()
    expect(row!.dirty_from).toBe(day(30))
  })

  it('scenario E+F: sale moves dirty BOTH the old and the new date; coalescing keeps the minimum', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    const env = await freshUser('ef', surface)
    const acq = await acquireRaw(env, (await makeVariant(env, 'qef')).variantId, day(60), 6_000)
    await drainQueue(surface)

    // Scenario E: move a sale EARLIER (day 70 -> day 65 via the documented void+re-enter path).
    const sale = await sellLots(env, day(70), [
      { lotId: acq.lotId, quantity: 1, unitGrossMinor: 7_000 },
    ])
    await drainQueue(surface)
    await voidSale(env, sale.saleId)
    expect(Date.parse((await readQueueRow(env))!.dirty_from)).toBeLessThanOrEqual(
      Date.parse(day(70)),
    )
    await drainQueue(surface)
    // The day(65) re-entry IS the moved sale; keep it live so scenario F can move it again.
    const saleEarly = await sellLots(env, day(65), [
      { lotId: acq.lotId, quantity: 1, unitGrossMinor: 7_000 },
    ])
    await drainQueue(surface)

    // Scenario F: move it LATER (day 65 -> day 75) via the documented void+re-enter path
    // (update_sale cannot move a sale; a lot with zero remaining quantity cannot be sold again,
    // so the day(65) sale must be voided before the day(75) re-entry). Both boundaries coalesce:
    // the void dirties day(65), the re-entry proposes day(75), LEAST keeps day(65).
    await voidSale(env, saleEarly.saleId)
    await sellLots(env, day(75), [{ lotId: acq.lotId, quantity: 1, unitGrossMinor: 7_000 }])
    const rowF = await readQueueRow(env)
    expect(rowF).not.toBeNull()
    expect(Date.parse(rowF!.dirty_from)).toBeLessThanOrEqual(Date.parse(day(65)))
    // The moved-later sale is still live work; drain so later scenarios start from a clean queue.
    await drainQueue(surface)
  })

  it('scenario O: an existing Jun-10 boundary coalesces with a new May-3 event into May-3', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    const env = await freshUser('o', surface)
    const laterAcq = await acquireRaw(
      env,
      (await makeVariant(env, 'qo1')).variantId,
      day(40),
      5_000,
    )
    await backdateAcquisition(env, laterAcq, 1, 5_000, day(30)) // queue now holds day(30)
    const beforeRow = await readQueueRow(env)
    expect(beforeRow!.dirty_from).toBe(day(30))

    // A NEW event dated even earlier must pull the boundary back, never widen forward.
    await acquireRaw(env, (await makeVariant(env, 'qo2')).variantId, day(20), 2_000)
    const afterRow = await readQueueRow(env)
    expect(afterRow!.dirty_from).toBe(day(20))
  })

  it('scenario P: a rejected rebuild call leaves queued work untouched', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    const env = await freshUser('p', surface)
    await acquireRaw(env, (await makeVariant(env, 'qp')).variantId, day(10), 5_000)
    expect(await readQueueRow(env)).not.toBeNull()

    if (!surface.rebuild) throw new Error('rebuild signature missing despite schema present')
    const args = bindParams(surface.rebuild, { user: env.user.id, from: day(20), through: day(10) })
    const { error } = await service.rpc(surface.rebuild.name, args)
    // A reversed range must be rejected by validation - silently "succeeding" with zero rows
    // would hide real work behind a malformed call.
    expect(error).not.toBeNull()

    // And the queued work must still be there for a legitimate worker.
    expect(await readQueueRow(env)).not.toBeNull()
  })

  it('scenario P (deep): a failing mid-drain rebuild retains its queue row until commit', async (ctx) => {
    ctx.skip(
      'Fault injection requires a session-level failure inside the drain transaction, which ' +
        'PostgREST-only access cannot produce (no DDL, no open transactions across requests). ' +
        'The M12 branch itself disclosed the same harness gap. When a test hook exists - e.g. a ' +
        'service-role-only fail_user(uuid) toggle the engine honours, or a psql handle in CI - ' +
        'flip this to a live test: enqueue work for two users, fail one rebuild mid-drain, and ' +
        'assert the failed user keeps its queue row while the other commits.',
    )
  })

  it('scenario Q: two concurrent workers clear all work exactly once, for every user', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    if (!surface.drain) throw new Error('drain signature missing despite schema present')

    const users: FixtureEnv[] = []
    for (const label of ['q1', 'q2']) {
      const env = await freshUser(label, surface)
      const acq = await acquireRaw(
        env,
        (await makeVariant(env, `qq-${label}`)).variantId,
        day(8),
        3_000,
      )
      await backdateAcquisition(env, acq, 1, 3_000, day(6))
      users.push(env)
    }

    // Two drains race over the same queue table.
    const [drainA, drainB] = await Promise.all([
      service.rpc(surface.drain.name, {}),
      service.rpc(surface.drain.name, {}),
    ])
    expect(drainA.error).toBeNull()
    expect(drainB.error).toBeNull()

    for (const env of users) {
      expect(await readQueueRow(env)).toBeNull()
      // head:true suppresses rows by design - the count arrives in `count`, never in `data`.
      const { count, error } = await service
        .from('portfolio_snapshots')
        .select('snapshot_date', { count: 'exact', head: true })
        .eq('user_id', env.user.id)
      expect(error).toBeNull()
      expect(count ?? 0).toBeGreaterThan(0)
    }

    // A second sequential drain is a clean no-op.
    await drainQueue(surface)
    for (const env of users) {
      expect(await readQueueRow(env)).toBeNull()
    }
  })

  it('the dashboard exposes an honest pending-recompute signal while work is queued', async (ctx) => {
    const surface = await skipUnlessM12(ctx, service)
    const env = await freshUser('pending', surface)
    await acquireRaw(env, (await makeVariant(env, 'qpend')).variantId, day(9), 4_000)

    const summaryName = 'get_dashboard_summary'
    const client = env.client
    const { data: whileQueued, error: errQueued } = await client.rpc(summaryName)
    expect(errQueued).toBeNull()
    const queuedPayload = JSON.stringify(whileQueued ?? {})
    if (!/pending/i.test(queuedPayload)) {
      throw new Error(
        '[M12 CONTRACT] get_dashboard_summary carries no pending-recompute field while the ' +
          'queue holds work for this user. HANDOVER documents an honest `pending_recompute` ' +
          'flag in ONE request; without it the headline can silently lag canonical facts.',
      )
    }
    expect(/true/i.test(extractPendingValue(queuedPayload))).toBe(true)

    await drainQueue(surface)
    const { data: afterDrain, error: errAfter } = await client.rpc(summaryName)
    expect(errAfter).toBeNull()
    expect(/true/i.test(extractPendingValue(JSON.stringify(afterDrain ?? {})))).toBe(false)
  })
})

function extractPendingValue(payload: string): string {
  const match = payload.match(/"pending[^"]*"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/i)
  return match?.[1] ?? ''
}
