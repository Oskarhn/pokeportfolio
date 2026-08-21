import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * M6: the atomic add_card_acquisition/void_acquisition_lot RPCs, the manual-card fallback, and
 * cross-tenant attacks against all of it (docs/TESTING.md §4-5, SECURITY.md §3.3, M6 prompt §97).
 * Every RPC call here derives its owner from the caller's own session — there is no user_id
 * argument to forge — so the attacks below target the things that *are* caller-supplied: another
 * user's storage location, manual card, or holding/lot id.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm6-collection-a')
  userB = await createSyntheticUser(service, 'm6-collection-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

interface AddResult {
  holding_id: string
  lot_id: string
}

/** Thin wrapper: calls add_card_acquisition and returns {data, error} with `data` cast to the
 *  shape the RPC actually returns — the clients in this directory are deliberately untyped
 *  (see tests/db/setup.ts's own note), same convention `claim_invitation` callers use. */
async function addCard(
  client: TestClient,
  args: Record<string, unknown>,
): Promise<{ data: AddResult | null; error: { message: string } | null }> {
  const result = await client.rpc('add_card_acquisition', args).maybeSingle()
  return { data: result.data as AddResult | null, error: result.error }
}

describe('add_card_acquisition: happy paths', () => {
  it('a known-cost purchase creates a holding, a lot, and a real one-line purchase', async () => {
    const { data, error } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 500,
      p_quantity: 3,
      p_acquired_on: today,
    })
    expect(error).toBeNull()

    const { data: lot } = await service
      .from('acquisition_lots')
      .select('quantity, quantity_remaining, unit_cost_basis_minor::text, purchase_line_id')
      .eq('id', data!.lot_id)
      .single()
    expect(lot?.quantity).toBe(3)
    expect(lot?.quantity_remaining).toBe(3)
    expect(lot?.unit_cost_basis_minor).toBe('500')
    expect(lot?.purchase_line_id).not.toBeNull()

    const { data: line } = await service
      .from('purchase_lines')
      .select('purchase_id, line_total_minor')
      .eq('id', lot!.purchase_line_id as string)
      .single()
    expect(line?.line_total_minor).toBe(1500)

    const { data: purchase } = await service
      .from('purchases')
      .select('total_minor, voided_at')
      .eq('id', line!.purchase_id as string)
      .single()
    expect(purchase?.total_minor).toBe(1500)
    expect(purchase?.voided_at).toBeNull()
  })

  it('adding the same identity again reuses the holding and creates a second lot', async () => {
    const first = await addCard(clientA, {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_condition: 'EX',
      p_origin: 'gift',
      p_cost_basis_state: 'not_paid',
      p_quantity: 1,
      p_acquired_on: today,
    })
    expect(first.error).toBeNull()

    const second = await addCard(clientA, {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_condition: 'EX',
      p_origin: 'purchase',
      p_cost_basis_state: 'unknown',
      p_quantity: 2,
      p_acquired_on: today,
    })
    expect(second.error).toBeNull()
    expect(second.data?.holding_id).toBe(first.data?.holding_id)
    expect(second.data?.lot_id).not.toBe(first.data?.lot_id)

    const { data: holdingRow } = await service
      .from('holdings')
      .select('id')
      .eq('id', first.data!.holding_id)
    expect(holdingRow).toHaveLength(1)

    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('holding_id', first.data!.holding_id)
    expect(lots).toHaveLength(2)
  })

  it('a different condition produces a different holding', async () => {
    const nm = await addCard(clientA, {
      p_card_variant_id: seedCatalog.japaneseVariantId,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    const lp = await addCard(clientA, {
      p_card_variant_id: seedCatalog.japaneseVariantId,
      p_condition: 'LP',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    expect(nm.data?.holding_id).not.toBe(lp.data?.holding_id)
  })

  it('a pulled card (origin=opening) has no direct cost — never zero', async () => {
    const { data, error } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_condition: 'NM',
      p_origin: 'opening',
      p_cost_basis_state: 'unallocated_opening',
      p_quantity: 1,
      p_acquired_on: today,
    })
    expect(error).toBeNull()

    const { data: lot } = await service
      .from('acquisition_lots')
      .select('unit_cost_basis_minor, purchase_line_id')
      .eq('id', data!.lot_id)
      .single()
    expect(lot?.unit_cost_basis_minor).toBeNull()
    expect(lot?.purchase_line_id).toBeNull()
  })

  it('a graded card carries an optional manual value, separate from acquisition cost', async () => {
    const { data, error } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
      p_grading_state: 'graded',
      p_grader: 'psa',
      p_grade: 10,
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 50_000,
      p_quantity: 1,
      p_acquired_on: today,
      p_manual_value_minor: 250_000,
    })
    expect(error).toBeNull()

    const { data: holding } = await service
      .from('holdings')
      .select('holding_kind, grader, grade')
      .eq('id', data!.holding_id)
      .single()
    expect(holding?.holding_kind).toBe('graded_card')
    expect(holding?.grader).toBe('psa')

    const { data: valuation } = await service
      .from('manual_valuations')
      .select('value_minor::text')
      .eq('holding_id', data!.holding_id)
      .is('superseded_at', null)
      .single()
    expect(valuation?.value_minor).toBe('250000')
  })

  it('a manual (catalog-missing) card is ordinary Collection inventory', async () => {
    const { data: manualCard } = await clientA
      .from('manual_card_definitions')
      .insert({ name: `Unlisted test card ${Date.now()}` })
      .select('id')
      .single()

    const { data, error } = await addCard(clientA, {
      p_manual_card_id: manualCard!.id,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    expect(error).toBeNull()

    const { data: holding } = await service
      .from('holdings')
      .select('manual_card_id, card_variant_id')
      .eq('id', data!.holding_id)
      .single()
    expect(holding?.manual_card_id).toBe(manualCard!.id)
    expect(holding?.card_variant_id).toBeNull()
  })
})

describe('add_card_acquisition: cross-tenant attacks', () => {
  it('the resulting holding always belongs to the caller, never an argument the caller supplies', async () => {
    const { data } = await addCard(clientB, {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_condition: 'GD',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })

    const { data: holding } = await service
      .from('holdings')
      .select('user_id')
      .eq('id', data!.holding_id)
      .single()
    expect(holding?.user_id).toBe(userB.id)
  })

  it("rejects another user's storage_location_id", async () => {
    const { data: othersLocation } = await service
      .from('storage_locations')
      .insert({ user_id: userB.id, name: `rpc-attack-location-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_condition: 'PO',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
      p_storage_location_id: othersLocation!.id,
    })
    expect(error).not.toBeNull()
  })

  it("rejects another user's manual_card_id", async () => {
    const { data: othersCard } = await service
      .from('manual_card_definitions')
      .insert({ user_id: userB.id, name: `rpc-attack-card-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await addCard(clientA, {
      p_manual_card_id: othersCard!.id,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    expect(error).not.toBeNull()
  })
})

describe('void_acquisition_lot', () => {
  it('voiding a known-cost lot also voids the purchase it exclusively created', async () => {
    const { data } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_condition: 'PL',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 200,
      p_quantity: 1,
      p_acquired_on: today,
    })

    const { error: voidError } = await clientA.rpc('void_acquisition_lot', {
      p_lot_id: data!.lot_id,
      p_reason: 'added by mistake',
    })
    expect(voidError).toBeNull()

    const { data: lot } = await service
      .from('acquisition_lots')
      .select('voided_at, purchase_line_id')
      .eq('id', data!.lot_id)
      .single()
    expect(lot?.voided_at).not.toBeNull()

    const { data: line } = await service
      .from('purchase_lines')
      .select('purchase_id')
      .eq('id', lot!.purchase_line_id as string)
      .single()
    const { data: purchase } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', line!.purchase_id as string)
      .single()
    expect(purchase?.voided_at).not.toBeNull()
  })

  it('a stranger cannot void another user lot', async () => {
    const { data } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.japaneseVariantId,
      p_condition: 'MT',
      p_origin: 'gift',
      p_cost_basis_state: 'not_paid',
      p_quantity: 1,
      p_acquired_on: today,
    })

    const { error } = await clientB.rpc('void_acquisition_lot', { p_lot_id: data!.lot_id })
    expect(error).not.toBeNull()

    const { data: lot } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('id', data!.lot_id)
      .single()
    expect(lot?.voided_at).toBeNull()
  })

  it('voiding an already-voided lot is rejected', async () => {
    const { data } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_condition: 'GD',
      p_origin: 'other',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })

    await clientA.rpc('void_acquisition_lot', { p_lot_id: data!.lot_id })
    const { error } = await clientA.rpc('void_acquisition_lot', { p_lot_id: data!.lot_id })
    expect(error).not.toBeNull()
  })
})

describe('holding_summaries: RLS isolation (security_invoker view)', () => {
  it('a stranger cannot see another user holding through the Collection list view', async () => {
    const { data } = await addCard(clientA, {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_condition: 'EX',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })

    const { data: ownView } = await clientA
      .from('holding_summaries')
      .select('holding_id')
      .eq('holding_id', data!.holding_id)
    expect(ownView).toHaveLength(1)

    const { data: strangerView, error } = await clientB
      .from('holding_summaries')
      .select('holding_id')
      .eq('holding_id', data!.holding_id)
    expect(error).toBeNull()
    expect(strangerView).toEqual([])
  })
})
