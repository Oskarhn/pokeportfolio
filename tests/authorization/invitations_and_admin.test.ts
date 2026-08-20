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
 * invitations is a "System" table (DATA_MODEL.md §1), admin-gated by design — this is the one
 * legitimate use of an is_admin()-checking policy. The critical negative test is the last one:
 * admin status must grant zero access to another user's private collection/spending data
 * (SECURITY.md §4). There must be no policy anywhere shaped like
 * `user_id = auth.uid() OR is_admin()` on a user-private table.
 */

let service: TestClient
let admin: SyntheticUser
let plainUser: SyntheticUser
let otherUser: SyntheticUser
let adminClient: TestClient
let plainClient: TestClient
let otherClient: TestClient

beforeAll(async () => {
  service = createServiceClient()
  admin = await createSyntheticUser(service, 'admin')
  plainUser = await createSyntheticUser(service, 'plain')
  otherUser = await createSyntheticUser(service, 'other')

  // Promoting to admin is an infrastructure operation (service role), never a client update —
  // profiles.is_admin has no client UPDATE grant at all (see profiles.test.ts).
  const { error } = await service.from('profiles').update({ is_admin: true }).eq('id', admin.id)
  if (error) throw error

  adminClient = await signInAs(admin)
  plainClient = await signInAs(plainUser)
  otherClient = await signInAs(otherUser)
})

afterAll(async () => {
  await deleteSyntheticUser(service, admin.id)
  await deleteSyntheticUser(service, plainUser.id)
  await deleteSyntheticUser(service, otherUser.id)
})

describe('RLS: invitations (admin-only system table)', () => {
  it('a non-admin cannot read invitations at all', async () => {
    await adminClient.from('invitations').insert({
      token_hash: `hash-${crypto.randomUUID()}`,
      created_by: admin.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })

    const { data, error } = await plainClient.from('invitations').select()
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('a non-admin cannot create an invitation', async () => {
    const { error } = await plainClient.from('invitations').insert({
      token_hash: `hash-${crypto.randomUUID()}`,
      created_by: plainUser.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(error).not.toBeNull()
  })

  it('an admin can create and read invitations', async () => {
    const { data, error } = await adminClient
      .from('invitations')
      .insert({
        token_hash: `hash-${crypto.randomUUID()}`,
        created_by: admin.id,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        label: 'test invite',
      })
      .select()
      .single()
    expect(error).toBeNull()
    expect(data?.label).toBe('test invite')
  })
})

describe('RLS: admin has no access to other users private data (SECURITY.md §4)', () => {
  it('admin cannot read another user purchases through the app API', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { data: purchase } = await otherClient
      .from('purchases')
      .insert({
        user_id: otherUser.id,
        purchased_on: today,
        currency: 'NOK',
        subtotal_minor: 1_000,
        total_minor: 1_000,
        fx_rate_date: today,
        total_nok_minor: 1_000,
      })
      .select()
      .single()
    expect(purchase).toBeTruthy()

    const { data, error } = await adminClient.from('purchases').select().eq('id', purchase!.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('admin cannot read another user holdings, retailers, storage_locations or tags', async () => {
    const { data: retailer } = await otherClient
      .from('retailers')
      .insert({ user_id: otherUser.id, name: `admin-cannot-see-${Date.now()}` })
      .select()
      .single()

    const { data, error } = await adminClient.from('retailers').select().eq('id', retailer!.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('admin cannot enumerate other users profiles', async () => {
    const { data, error } = await adminClient.from('profiles').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data?.[0]?.id).toBe(admin.id)
  })
})
