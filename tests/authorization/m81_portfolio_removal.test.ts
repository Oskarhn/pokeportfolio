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
 * M8.1: cross-tenant attacks against remove_holdings_from_portfolio (SECURITY.md §3.3,
 * TESTING.md §4-5). The RPC derives ownership entirely from auth.uid() — there is no user_id
 * argument to forge — so what is tested here is the one thing that *is* caller-supplied: another
 * user's holding id, alone or mixed into an otherwise-valid selection of the caller's own.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm81-removal-a')
  userB = await createSyntheticUser(service, 'm81-removal-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function addCard(client: TestClient, cardVariantId: string) {
  const { data, error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: cardVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 100,
      p_quantity: 1,
      p_acquired_on: today,
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (error) throw new Error(error.message)
  return data
}

describe('remove_holdings_from_portfolio: cross-tenant isolation', () => {
  it("B cannot remove A's holding by id", async () => {
    const aHolding = await addCard(clientA, seedCatalog.charizardVariantId)

    const { error } = await clientB.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [aHolding.holding_id],
    })
    expect(error).not.toBeNull()

    const { data: stillLive } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('id', aHolding.lot_id)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })

  it("a selection mixing B's own holding with A's is rejected wholesale — no partial mutation", async () => {
    const aHolding = await addCard(clientA, seedCatalog.pikachuVariantId)
    const bHolding = await addCard(clientB, seedCatalog.grassEnergyVariantId)

    const { error } = await clientB.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [bHolding.holding_id, aHolding.holding_id],
    })
    expect(error).not.toBeNull()

    // B's own, otherwise-perfectly-removable holding must NOT have been voided either.
    const { data: bLot } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('id', bHolding.lot_id)
      .single()
    expect(bLot?.voided_at).toBeNull()

    const { data: aLot } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('id', aHolding.lot_id)
      .single()
    expect(aLot?.voided_at).toBeNull()
  })

  it('anon cannot call remove_holdings_from_portfolio at all', async () => {
    const aHolding = await addCard(clientA, seedCatalog.charizardVariantId)
    const { error } = await createAnonClient().rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [aHolding.holding_id],
    })
    expect(error).not.toBeNull()
  })
})
