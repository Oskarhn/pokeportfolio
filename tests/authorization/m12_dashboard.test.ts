import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  promoteToAdmin,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * M12 authorization (prompt Part L/§119): the snapshot cache is owner-READ-only; the queue and
 * run log are invisible to every browser-reachable role; every engine routine refuses
 * authenticated/anon callers at the privilege level (not merely via RLS); the dashboard reads
 * scope to auth.uid() with no admin bypass.
 *
 * Grant-level refusals are asserted as errors from a real client call — PostgREST surfaces
 * missing EXECUTE/SELECT privileges as errors, which is exactly what "no grant at all" should
 * look like from the attacker's side of the boundary.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let admin: SyntheticUser
let clientA: TestClient
let clientB: TestClient

const today = new Date()
function daysAgo(n: number): string {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function seedOwnedData(userId: string): Promise<void> {
  await service.from('holdings').insert({
    user_id: userId,
    holding_kind: 'raw_card',
    card_variant_id: seedCatalog.charizardVariantId,
    condition: 'NM',
    grading_state: 'raw',
  })
  const { data: holding } = await service
    .from('holdings')
    .select('id')
    .eq('user_id', userId)
    .single()
  const { error } = await service.from('acquisition_lots').insert({
    holding_id: holding!.id as string,
    user_id: userId,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: daysAgo(20),
    quantity: 2,
    quantity_remaining: 2,
  })
  if (error) throw new Error(error.message)

  const { error: rebuildError } = await service.rpc('rebuild_portfolio_snapshots', {
    p_user_id: userId,
    p_from: daysAgo(30),
    p_through: daysAgo(0),
  })
  if (rebuildError) throw new Error(rebuildError.message)
}

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm12-auth-a')
  userB = await createSyntheticUser(service, 'm12-auth-b')
  admin = await createSyntheticUser(service, 'm12-auth-admin')
  await promoteToAdmin(service, admin.id)
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)

  await seedOwnedData(userA.id)
  await seedOwnedData(userB.id)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
  await deleteSyntheticUser(service, admin.id)
})

describe('M12 snapshot cache is owner-read-only', () => {
  it('A cannot read B’s snapshots', async () => {
    const { data } = await clientA.from('portfolio_snapshots').select('*').eq('user_id', userB.id)
    expect(data).toEqual([])
  })

  it('A sees only their own rows when selecting without filters', async () => {
    const { data } = await clientA.from('portfolio_snapshots').select('user_id')
    expect(data!.length).toBeGreaterThan(0)
    expect(new Set(data!.map((r) => r.user_id))).toEqual(new Set([userA.id]))
  })

  it('no browser session can INSERT a forged snapshot — not even on its own row', async () => {
    const { error } = await clientA.from('portfolio_snapshots').insert({
      user_id: userA.id,
      snapshot_date: daysAgo(1),
      market_value_nok_minor: 999999999,
      attributed_value_nok_minor: 0,
      cost_basis_nok_minor: 0,
      collectible_spend_to_date_nok_minor: 0,
      sales_proceeds_to_date_nok_minor: 0,
      open_lot_count: 42,
      unvalued_lot_count: 0,
    })
    // A privilege refusal ("permission denied"), not an RLS row rejection — there is no INSERT
    // grant at all for any browser role (prompt §92/§96).
    expect(error?.message.toLowerCase()).toContain('permission')
  })

  it('no browser session can UPDATE or DELETE cache history', async () => {
    const { data: own } = await clientA
      .from('portfolio_snapshots')
      .select('snapshot_date')
      .limit(1)
      .single()
    const target = own!.snapshot_date

    const { error: updateError } = await clientA
      .from('portfolio_snapshots')
      .update({ market_value_nok_minor: 1 })
      .eq('user_id', userA.id)
      .eq('snapshot_date', target)
    expect(updateError?.message.toLowerCase()).toContain('permission')

    const { error: deleteError } = await clientA
      .from('portfolio_snapshots')
      .delete()
      .eq('user_id', userA.id)
      .eq('snapshot_date', target)
    expect(deleteError?.message.toLowerCase()).toContain('permission')
  })
})

describe('M12 queue and run log are service-internal (prompt §93)', () => {
  it('users can neither read nor write the recompute queue — own or anyone’s', async () => {
    // No grant at all: PostgREST answers a SELECT with a privilege ERROR, not an empty list —
    // the stronger boundary (the table does not exist as far as this session is concerned).
    const { data: read, error: readError } = await clientA
      .from('portfolio_recompute_queue')
      .select('*')
    expect(readError?.message.toLowerCase()).toContain('permission')
    expect(read).toBeNull()

    const { error: insertError } = await clientA.from('portfolio_recompute_queue').insert({
      user_id: userB.id, // enqueue work for the victim
      dirty_from: daysAgo(100),
    })
    expect(insertError?.message.toLowerCase()).toContain('permission')

    const { error: selfInsertError } = await clientA.from('portfolio_recompute_queue').insert({
      user_id: userA.id,
      dirty_from: daysAgo(1),
    })
    expect(selfInsertError?.message.toLowerCase()).toContain('permission')
  })

  it('the run log is equally unreachable', async () => {
    const { data, error } = await clientA.from('portfolio_recompute_runs').select('*')
    expect(error?.message.toLowerCase()).toContain('permission')
    expect(data).toBeNull()
  })

  it('the engine routines refuse authenticated callers at the privilege level', async () => {
    const rebuildAttempt = await clientA.rpc('rebuild_portfolio_snapshots', {
      p_user_id: userB.id, // the cross-user attack the design exists to forbid
      p_from: daysAgo(30),
      p_through: daysAgo(0),
    })
    expect(rebuildAttempt.error?.message.toLowerCase()).toMatch(/permission|not allowed/)

    const drainAttempt = await clientA.rpc('drain_portfolio_recompute_queue')
    expect(drainAttempt.error?.message.toLowerCase()).toMatch(/permission|not allowed/)

    const maintenanceAttempt = await clientA.rpc('enqueue_portfolio_daily_maintenance')
    expect(maintenanceAttempt.error?.message.toLowerCase()).toMatch(/permission|not allowed/)
  })

  it('the internal enqueue helper is not directly callable by a browser either', async () => {
    const attempt = await clientA.rpc('enqueue_portfolio_recompute', {
      p_user_id: userB.id,
      p_dirty_from: daysAgo(50),
    })
    expect(attempt.error?.message.toLowerCase()).toMatch(/permission|not allowed/)
  })

  it('anon holds nothing anywhere in the M12 surface', async () => {
    const anon = createAnonClient()
    const summary = await anon.rpc('get_dashboard_summary')
    expect(summary.error).not.toBeNull()
    const history = await anon.rpc('get_portfolio_history', { p_display_currency: 'NOK' })
    expect(history.error).not.toBeNull()
    const monthly = await anon.rpc('get_monthly_spend', { p_months: 3 })
    expect(monthly.error).not.toBeNull()
    const activity = await anon.rpc('get_recent_activity', { p_limit: 5 })
    expect(activity.error).not.toBeNull()
    // anon holds NO grant on the cache: a privilege error, not an empty list.
    const snapshots = await anon.from('portfolio_snapshots').select('*')
    expect(snapshots.error?.message.toLowerCase()).toContain('permission')
    expect(snapshots.data).toBeNull()
  })
})

describe('M12 dashboard reads are scoped and admin gains no bypass (prompt §97)', () => {
  it('each summary reflects only its own ledger', async () => {
    const a = await clientA.rpc('get_dashboard_summary').single<{
      physical_card_count: string
      gpo_nok_minor: string
      unique_holding_count: string
    }>()
    const b = await clientB.rpc('get_dashboard_summary').single<{
      physical_card_count: string
      gpo_nok_minor: string
    }>()
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect(Number(a.data!.physical_card_count)).toBe(2) // A's two units
    expect(BigInt(a.data!.gpo_nok_minor)).toBe(0n) // A recorded no purchases
    expect(Number(b.data!.physical_card_count)).toBe(2)
  })

  it('history and monthly spend return only the caller’s data', async () => {
    const history = await clientA.rpc('get_portfolio_history', { p_display_currency: 'NOK' })
    expect(history.error).toBeNull()
    // The seeded lot's acquired_on (20 days ago) is the first tracked date, so the stored series
    // covers exactly days −20…0 — the engine never fabricates rows before ownership began.
    expect((history.data as unknown[]).length).toBe(21)

    const monthly = await clientA.rpc('get_monthly_spend', { p_months: 6 })
    expect(monthly.error).toBeNull()
    expect((monthly.data as unknown[]).length).toBe(6)

    const activity = await clientA.rpc('get_recent_activity', { p_limit: 10 })
    expect(activity.error).toBeNull()
    // A's only canonical activity is the gift acquisition — no B rows can appear.
    const types = new Set(
      (activity.data as unknown as { activity_type: string }[]).map((r) => r.activity_type),
    )
    expect(types.has('purchase')).toBe(false)
  })

  it('an admin’s dashboard shows the admin’s own data only (SECURITY.md §4)', async () => {
    const adminClient = await signInAs(admin)
    const summary = await adminClient.rpc('get_dashboard_summary').single<{
      physical_card_count: string
      unique_holding_count: string
    }>()
    // The admin owns nothing — an empty account, never A's or B's figures.
    expect(summary.error).toBeNull()
    expect(Number(summary.data!.unique_holding_count)).toBe(0)
    expect(Number(summary.data!.physical_card_count)).toBe(0)

    const snapshots = await adminClient.from('portfolio_snapshots').select('user_id')
    expect(new Set((snapshots.data ?? []).map((r) => r.user_id))).toEqual(new Set([]))

    const history = await adminClient.rpc('get_portfolio_history', { p_display_currency: 'NOK' })
    expect((history.data ?? []).length).toBe(0)
  })
})
