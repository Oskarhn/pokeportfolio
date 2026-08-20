import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { parseMinorUnits } from '../../src/data/money'

/**
 * Proves the bigint/PostgREST precision boundary documented in src/data/money.ts against the
 * actual local Supabase stack, rather than assuming it (prompt §46: "Write tests for this
 * boundary if it is introduced during M3", and it is — purchases.total_minor is a bigint).
 */

let service: TestClient
let user: SyntheticUser

// 2^53 + 1 — the smallest positive integer a JS double cannot represent exactly.
const HUGE_MINOR_UNITS = '9007199254740993'
const HUGE_MINOR_UNITS_EXACT = 9_007_199_254_740_993n

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'money-boundary')
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

describe('bigint money column boundary', () => {
  it('selecting with an explicit ::text cast preserves the exact value', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { data: purchase, error } = await service
      .from('purchases')
      .insert({
        user_id: user.id,
        purchased_on: today,
        currency: 'NOK',
        subtotal_minor: HUGE_MINOR_UNITS,
        total_minor: HUGE_MINOR_UNITS,
        fx_rate_date: today,
        total_nok_minor: HUGE_MINOR_UNITS,
      })
      .select('id')
      .single()
    expect(error).toBeNull()

    const { data: cast, error: castError } = await service
      .from('purchases')
      .select('total_minor::text')
      .eq('id', purchase!.id)
      .single()
    expect(castError).toBeNull()

    const exact = parseMinorUnits(cast!.total_minor)
    expect(exact).toBe(9_007_199_254_740_993n)
  })

  it('selecting WITHOUT the cast loses precision for this value — the reason the cast is mandatory', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { data: purchase } = await service
      .from('purchases')
      .insert({
        user_id: user.id,
        purchased_on: today,
        currency: 'NOK',
        subtotal_minor: HUGE_MINOR_UNITS,
        total_minor: HUGE_MINOR_UNITS,
        fx_rate_date: today,
        total_nok_minor: HUGE_MINOR_UNITS,
      })
      .select('id')
      .single()

    const { data: uncast } = await service
      .from('purchases')
      .select('total_minor')
      .eq('id', purchase!.id)
      .single()

    // This is the failure mode the boundary exists to prevent: the JS number PostgREST
    // returned, converted back to a bigint, is NOT the value that was stored. (Comparing against
    // a JS number literal here would be self-defeating — 9_007_199_254_740_993 as a *number*
    // literal already rounds to the same wrong value at parse time, which is exactly the bug.)
    expect(BigInt(uncast!.total_minor)).not.toBe(HUGE_MINOR_UNITS_EXACT)
  })
})
