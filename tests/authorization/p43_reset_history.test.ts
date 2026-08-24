import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * P43: cross-tenant and privilege attacks against reset_my_portfolio_data() and
 * list_history_events() (SECURITY.md §3.3, TESTING.md §4-5).
 *
 * Neither RPC accepts any caller-supplied user id — ownership derives from auth.uid() alone —
 * so the attacker moves tested here are exactly the ones that exist: an anonymous session
 * reaching for either function at all, a signed-in user reading another user's events through
 * the shared read surface, and an attempt to aim reset at a victim by inventing a p_user_id
 * parameter (which must not match ANY overload in the schema cache).
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p43-authz-a')
  userB = await createSyntheticUser(service, 'p43-authz-b')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function addCard(client: TestClient, cardVariantId: string) {
  const { data, error } = await client.rpc('add_card_acquisition', {
    p_card_variant_id: cardVariantId,
    p_grading_state: 'raw',
    p_condition: 'NM',
    p_origin: 'purchase',
    p_cost_basis_state: 'known',
    p_unit_cost_basis_minor: 100,
    p_quantity: 1,
    p_acquired_on: today,
  })
  if (error) throw new Error(error.message)
  return data as { holding_id: string; lot_id: string }
}

describe('reset_my_portfolio_data: who may call it', () => {
  it('anon cannot execute the reset at all', async () => {
    const { error } = await createAnonClient().rpc('reset_my_portfolio_data')
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/permission denied for function/i)
  })

  it('no overload accepting a target-user parameter exists — A cannot aim the reset at B', async () => {
    const clientB = await signInAs(userB)
    await addCard(clientB, seedCatalog.pikachuVariantId)

    // PostgREST resolves the call against every overload of the name. If this ever stops being
    // "function not found", someone added a parameter to the reset surface — fail loudly.
    const { error } = await clientA.rpc('reset_my_portfolio_data', {
      p_user_id: userB.id,
    } as never)
    expect(error).not.toBeNull()
    expect(JSON.stringify(error)).toMatch(/Could not find the function/i)

    const { count } = await service
      .from('holdings')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userB.id)
    expect(count ?? 0).toBe(1) // B untouched
  })

  it('the authenticated owner resets only their own data; B survives intact', async () => {
    const aCard = await addCard(clientA, seedCatalog.charizardVariantId)
    const clientB = await signInAs(userB)
    const bCard = await addCard(clientB, seedCatalog.pikachuVariantId)

    const { error } = await clientA.rpc('reset_my_portfolio_data')
    expect(error).toBeNull()

    const { data: aLot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('id', aCard.lot_id)
      .maybeSingle()
    expect(aLot).toBeNull()

    const { data: bHolding } = await service
      .from('holdings')
      .select('id')
      .eq('id', bCard.holding_id)
      .maybeSingle()
    expect(bHolding).not.toBeNull()
  })
})

describe('list_history_events: owner-only reads', () => {
  it('anon cannot read history at all', async () => {
    const { error } = await createAnonClient().rpc('list_history_events')
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/permission denied for function/i)
  })

  it("a signed-in user sees only their own events — B's purchases never leak into A's feed", async () => {
    await addCard(clientA, seedCatalog.charizardVariantId)
    const clientB = await signInAs(userB)
    await addCard(clientB, seedCatalog.grassEnergyVariantId)

    const { data: aEvents, error: aError } = await clientA.rpc('list_history_events')
    expect(aError).toBeNull()
    expect((aEvents as { event_kind: string }[]).length).toBeGreaterThanOrEqual(1)

    const { data: bEvents, error: bError } = await clientB.rpc('list_history_events')
    expect(bError).toBeNull()
    const bList = bEvents as { title: string; amount_nok_minor: string | null }[]
    // B's feed contains only B's own purchase(s), never A's.
    expect(bList.length).toBe(1)
    // And neither feed is empty-by-RLS-failure: each shows its own row.
    expect(aEvents).not.toEqual(bEvents)
  })
})
