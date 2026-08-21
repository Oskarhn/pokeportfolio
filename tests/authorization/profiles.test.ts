import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * profiles is a special case: one row per user, created automatically by the handle_new_user
 * trigger (never inserted by a client), and is_admin/disabled_at must never be client-writable
 * even for the owner (docs/SECURITY.md §4, prompt §50 "privilege escalation").
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'profile-a')
  userB = await createSyntheticUser(service, 'profile-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

describe('RLS isolation: profiles', () => {
  it('signup automatically created exactly one profile row per user', async () => {
    const { data, error } = await clientA.from('profiles').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data?.[0]?.id).toBe(userA.id)
  })

  it('a user can update their own display name', async () => {
    const { error } = await clientA
      .from('profiles')
      .update({ display_name: 'Ash' })
      .eq('id', userA.id)
    expect(error).toBeNull()
    const { data } = await clientA
      .from('profiles')
      .select('display_name')
      .eq('id', userA.id)
      .single()
    expect(data?.display_name).toBe('Ash')
  })

  it('a stranger cannot read another user profile (enumeration is limited to own row)', async () => {
    const { data, error } = await clientB.from('profiles').select().eq('id', userA.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('a stranger cannot update another user profile', async () => {
    const { data, error } = await clientB
      .from('profiles')
      .update({ display_name: 'attacker' })
      .eq('id', userA.id)
      .select()
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('a user cannot grant themselves admin (blocked by column privilege, not just RLS)', async () => {
    const { error } = await clientA.from('profiles').update({ is_admin: true }).eq('id', userA.id)
    expect(error).not.toBeNull()

    const { data } = await service.from('profiles').select('is_admin').eq('id', userA.id).single()
    expect(data?.is_admin).toBe(false)
  })

  it('a user cannot disable their own account via the client column grant', async () => {
    const { error } = await clientA
      .from('profiles')
      .update({ disabled_at: new Date().toISOString() })
      .eq('id', userA.id)
    expect(error).not.toBeNull()
  })

  it('a client cannot insert a profile row directly (no INSERT policy)', async () => {
    const { error } = await clientA.from('profiles').insert({ id: userA.id, display_name: 'dup' })
    expect(error).not.toBeNull()
  })

  // M7.1: value-privacy eye and the European-pricing preference (prompt §19/§56).
  it('a user can update their own hide_values and use_eu_pricing preferences', async () => {
    const { error } = await clientA
      .from('profiles')
      .update({ hide_values: true, use_eu_pricing: false })
      .eq('id', userA.id)
    expect(error).toBeNull()
    const { data } = await clientA
      .from('profiles')
      .select('hide_values, use_eu_pricing')
      .eq('id', userA.id)
      .single()
    expect(data?.hide_values).toBe(true)
    expect(data?.use_eu_pricing).toBe(false)
  })

  it('hide_values defaults false and use_eu_pricing defaults true for a new account', async () => {
    const { data } = await clientB
      .from('profiles')
      .select('hide_values, use_eu_pricing')
      .eq('id', userB.id)
      .single()
    expect(data?.hide_values).toBe(false)
    expect(data?.use_eu_pricing).toBe(true)
  })
})
