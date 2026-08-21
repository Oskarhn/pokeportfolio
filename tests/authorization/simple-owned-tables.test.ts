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
 * Attack matrix for uniformly-shaped top-level user-private tables — id, user_id, name
 * (docs/SECURITY.md §3.3, docs/TESTING.md §4). Table-driven: adding a table to this list is
 * the whole cost of covering it.
 */
const TABLES = ['retailers', 'storage_locations', 'tags', 'manual_card_definitions'] as const

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'owned-a')
  userB = await createSyntheticUser(service, 'owned-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

describe.each(TABLES)('RLS isolation: %s', (table) => {
  it('owner can insert and read their own row', async () => {
    const { data, error } = await clientA
      .from(table)
      .insert({ user_id: userA.id, name: `${table}-own-${Date.now()}` })
      .select()
      .single()
    expect(error).toBeNull()
    expect(data?.user_id).toBe(userA.id)
  })

  it('a stranger cannot read the row by id (empty result, not an error leak)', async () => {
    const { data: created } = await clientA
      .from(table)
      .insert({ user_id: userA.id, name: `${table}-hidden-${Date.now()}` })
      .select()
      .single()
    expect(created).toBeTruthy()

    const { data, error } = await clientB.from(table).select().eq('id', created!.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('a stranger cannot update the row (0 rows affected)', async () => {
    const { data: created } = await clientA
      .from(table)
      .insert({ user_id: userA.id, name: `${table}-update-target-${Date.now()}` })
      .select()
      .single()

    const { data: updated, error } = await clientB
      .from(table)
      .update({ name: 'attacker-renamed' })
      .eq('id', created!.id)
      .select()
    expect(error).toBeNull()
    expect(updated).toEqual([])

    const { data: stillOriginal } = await service
      .from(table)
      .select('name')
      .eq('id', created!.id)
      .single()
    expect(stillOriginal?.name).toBe(created!.name)
  })

  it('a stranger cannot delete the row (0 rows affected)', async () => {
    const { data: created } = await clientA
      .from(table)
      .insert({ user_id: userA.id, name: `${table}-delete-target-${Date.now()}` })
      .select()
      .single()

    const { data: deleted, error } = await clientB
      .from(table)
      .delete()
      .eq('id', created!.id)
      .select()
    expect(error).toBeNull()
    expect(deleted).toEqual([])

    const { data: stillThere } = await service
      .from(table)
      .select('id')
      .eq('id', created!.id)
      .single()
    expect(stillThere?.id).toBe(created!.id)
  })

  it('cannot insert a row claiming another user as owner (rejected by WITH CHECK)', async () => {
    const { error } = await clientA
      .from(table)
      .insert({ user_id: userB.id, name: `${table}-spoofed-${Date.now()}` })
    expect(error).not.toBeNull()
  })

  it('cannot reassign an owned row to another user (no column grant, and WITH CHECK behind it)', async () => {
    const { data: created } = await clientA
      .from(table)
      .insert({ user_id: userA.id, name: `${table}-reassign-${Date.now()}` })
      .select()
      .single()

    const { error } = await clientA.from(table).update({ user_id: userB.id }).eq('id', created!.id)
    expect(error).not.toBeNull()

    const { data: stillOwnedByA } = await service
      .from(table)
      .select('user_id')
      .eq('id', created!.id)
      .single()
    expect(stillOwnedByA?.user_id).toBe(userA.id)
  })
})
