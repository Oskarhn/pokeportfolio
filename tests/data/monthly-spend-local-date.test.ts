import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * D-212: getMonthlySpend sends the owner's LOCAL date as p_as_of, so the newest bar is the month the
 * owner is in even in the hour after local midnight on the 1st, when the database (UTC) is still in
 * the previous month.
 */

const rpc = vi.fn()
vi.mock('../../src/data/supabase-client', () => ({ supabase: { rpc } }))

afterEach(() => {
  vi.useRealTimers()
  rpc.mockReset()
})

describe('getMonthlySpend', () => {
  it('passes the local calendar date, not the UTC date', async () => {
    // 2026-11-01 00:30 in Oslo (UTC+1) is 2026-10-31 23:30 UTC. The local clock is faked through TZ
    // independent construction: a Date built from local components.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 1, 0, 30, 0)) // local 1 Nov 00:30
    rpc.mockReturnValue({
      overrideTypes: () => Promise.resolve({ data: [], error: null }),
    })
    const { getMonthlySpend } = await import('../../src/data/dashboard')
    await getMonthlySpend(6)
    expect(rpc).toHaveBeenCalledWith('get_monthly_spend', { p_months: 6, p_as_of: '2026-11-01' })
  })
})
