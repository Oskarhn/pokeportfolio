import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M6 schema/constraint tests (docs/TESTING.md §5): the manual-card identity XOR, the
 * origin/cost-basis-state consistency mapping, manual valuations, and the ownership triggers that
 * are new this milestone. Service-role client — bypasses RLS but never a CHECK constraint or
 * trigger, which is what is actually under test here.
 */

let service: TestClient
let user: SyntheticUser
let userB: SyntheticUser

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'm6-constraints-a')
  userB = await createSyntheticUser(service, 'm6-constraints-b')
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function createManualCard(owner: SyntheticUser, name: string) {
  const { data, error } = await service
    .from('manual_card_definitions')
    .insert({ user_id: owner.id, name })
    .select('id')
    .single()
  if (error) throw error
  return data
}

describe('holdings: three-way identity XOR (D-037)', () => {
  it('accepts a holding with only manual_card_id set', async () => {
    const manual = await createManualCard(user, 'Unlisted promo A')
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      manual_card_id: manual.id,
      condition: 'NM',
    })
    expect(error).toBeNull()
  })

  it('rejects a holding with both card_variant_id and manual_card_id set', async () => {
    const manual = await createManualCard(user, 'Unlisted promo B')
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.pikachuVariantId,
      manual_card_id: manual.id,
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })

  it('rejects a holding with all three identity columns null', async () => {
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })

  it('rejects a manual card as a sealed holding (holdings_manual_card_not_sealed)', async () => {
    const manual = await createManualCard(user, 'Unlisted promo C')
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'sealed',
      manual_card_id: manual.id,
    })
    expect(error).not.toBeNull()
  })

  it('a manual_card_id belonging to another user is rejected (S1 defence in depth)', async () => {
    const othersManual = await createManualCard(userB, 'Belongs to B')
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      manual_card_id: othersManual.id,
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })
})

describe('acquisition_lots: origin/cost-basis-state consistency', () => {
  async function createHolding(condition: string) {
    const { data, error } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.grassEnergyVariantId,
        condition,
      })
      .select('id')
      .single()
    if (error) throw error
    return data
  }

  it('accepts origin=opening with cost_basis_state=unallocated_opening (a "Pulled" card)', async () => {
    const holding = await createHolding('NM')
    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'opening',
      cost_basis_state: 'unallocated_opening',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(error).toBeNull()
  })

  it('rejects origin=opening with cost_basis_state=known (a pull can never be priced)', async () => {
    const holding = await createHolding('EX')
    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'opening',
      cost_basis_state: 'known',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      unit_cost_basis_minor: 100,
    })
    expect(error).not.toBeNull()
  })

  it('rejects origin=gift with cost_basis_state=unknown (must be not_paid)', async () => {
    const holding = await createHolding('GD')
    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(error).not.toBeNull()
  })

  it('accepts origin=trade_in with cost_basis_state=trade_in', async () => {
    const holding = await createHolding('LP')
    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'trade_in',
      cost_basis_state: 'trade_in',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(error).toBeNull()
  })

  it('rejects origin=trade_in with cost_basis_state=known', async () => {
    const holding = await createHolding('PL')
    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'trade_in',
      cost_basis_state: 'known',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      unit_cost_basis_minor: 100,
    })
    expect(error).not.toBeNull()
  })

  it('accepts origin=pre_tracking with cost_basis_state=unknown ("Existing collection")', async () => {
    const holding = await createHolding('PO')
    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'pre_tracking',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(error).toBeNull()
  })

  it('an acquisition_lots.storage_location_id belonging to another user is rejected', async () => {
    const holding = await createHolding('MT')
    const { data: othersLocation } = await service
      .from('storage_locations')
      .insert({ user_id: userB.id, name: `attack-location-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'pre_tracking',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      storage_location_id: othersLocation!.id,
    })
    expect(error).not.toBeNull()
  })
})

describe('manual_valuations', () => {
  // holdings_identity is a real unique constraint — every call site below passes a distinct grade
  // so tests sharing `user` don't collide (same convention as holdings_and_lots.test.ts).
  async function createGradedHolding(grade: number) {
    const { data, error } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'graded_card',
        card_variant_id: seedCatalog.charizardVariantId,
        grading_state: 'graded',
        grader: 'psa',
        grade,
      })
      .select('id')
      .single()
    if (error) throw error
    return data
  }

  it('rejects a non-NOK currency (no FX exists yet to freeze a conversion — M6 scope cut)', async () => {
    const holding = await createGradedHolding(9)
    const { error } = await service.from('manual_valuations').insert({
      user_id: user.id,
      holding_id: holding.id,
      value_minor: 250_000,
      currency: 'EUR',
      value_nok_minor: 250_000,
    })
    expect(error).not.toBeNull()
  })

  it('allows only one active valuation per holding at a time', async () => {
    const holding = await createGradedHolding(10)
    const first = await service.from('manual_valuations').insert({
      user_id: user.id,
      holding_id: holding.id,
      value_minor: 250_000,
      value_nok_minor: 250_000,
    })
    expect(first.error).toBeNull()

    const second = await service.from('manual_valuations').insert({
      user_id: user.id,
      holding_id: holding.id,
      value_minor: 300_000,
      value_nok_minor: 300_000,
    })
    expect(second.error).not.toBeNull()

    // Superseding the first makes room for a new active row.
    await service
      .from('manual_valuations')
      .update({ superseded_at: new Date().toISOString() })
      .eq('holding_id', holding.id)
      .is('superseded_at', null)

    const third = await service.from('manual_valuations').insert({
      user_id: user.id,
      holding_id: holding.id,
      value_minor: 300_000,
      value_nok_minor: 300_000,
    })
    expect(third.error).toBeNull()
  })

  it('a holding_id belonging to another user is rejected (S1 defence in depth)', async () => {
    const { data: othersHolding } = await service
      .from('holdings')
      .insert({
        user_id: userB.id,
        holding_kind: 'graded_card',
        card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
        grading_state: 'graded',
        grader: 'cgc',
        grade: 9.5,
      })
      .select('id')
      .single()

    const { error } = await service.from('manual_valuations').insert({
      user_id: user.id,
      holding_id: othersHolding!.id,
      value_minor: 100_000,
      value_nok_minor: 100_000,
    })
    expect(error).not.toBeNull()
  })
})

describe('holding_tags ownership (S1 defence in depth)', () => {
  it('rejects a tag belonging to another user attached to your own holding', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.japaneseVariantId,
        condition: 'NM',
      })
      .select('id')
      .single()
    const { data: othersTag } = await service
      .from('tags')
      .insert({ user_id: userB.id, name: `attack-tag-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await service.from('holding_tags').insert({
      holding_id: holding!.id,
      tag_id: othersTag!.id,
      user_id: user.id,
    })
    expect(error).not.toBeNull()
  })

  it('rejects your own tag attached to another user holding', async () => {
    const { data: othersHolding } = await service
      .from('holdings')
      .insert({
        user_id: userB.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.grassEnergyVariantId,
        condition: 'EX',
      })
      .select('id')
      .single()
    const { data: ownTag } = await service
      .from('tags')
      .insert({ user_id: user.id, name: `own-tag-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await service.from('holding_tags').insert({
      holding_id: othersHolding!.id,
      tag_id: ownTag!.id,
      user_id: user.id,
    })
    expect(error).not.toBeNull()
  })
})

describe('account deletion cascades every M6 table (SECURITY.md §8)', () => {
  // Own synthetic user, created and deleted within the test itself rather than the shared
  // beforeAll/afterAll fixture above, since deletion is exactly what is under test here.
  //
  // Regression guard for a real gap found running the real add-to-collection flow against the
  // deployed project (M6 prompt §98): holding_tags.user_id and manual_valuations.user_id
  // referenced auth.users(id) with no ON DELETE action, so deleting an account that had tagged a
  // holding or set a manual valuation failed outright — see 20260821130000_m6_user_id_cascade_fix.
  it('deleting the account cascades holdings, lots, manual cards, tags and manual valuations', async () => {
    const owner = await createSyntheticUser(service, 'm6-cascade')

    const { data: manualCard } = await service
      .from('manual_card_definitions')
      .insert({ user_id: owner.id, name: 'cascade-check-card' })
      .select('id')
      .single()

    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: owner.id,
        holding_kind: 'graded_card',
        card_variant_id: seedCatalog.charizardVariantId,
        grading_state: 'graded',
        grader: 'bgs',
        grade: 9,
      })
      .select('id')
      .single()

    const { data: tag } = await service
      .from('tags')
      .insert({ user_id: owner.id, name: 'cascade-check-tag' })
      .select('id')
      .single()

    await service
      .from('holding_tags')
      .insert({ holding_id: holding!.id, tag_id: tag!.id, user_id: owner.id })
    await service.from('manual_valuations').insert({
      user_id: owner.id,
      holding_id: holding!.id,
      value_minor: 100_000,
      value_nok_minor: 100_000,
    })

    await deleteSyntheticUser(service, owner.id)

    const [holdings, manualCards, tags, holdingTags, valuations] = await Promise.all([
      service.from('holdings').select('id').eq('user_id', owner.id),
      service.from('manual_card_definitions').select('id').eq('id', manualCard!.id),
      service.from('tags').select('id').eq('id', tag!.id),
      service.from('holding_tags').select('holding_id').eq('user_id', owner.id),
      service.from('manual_valuations').select('id').eq('user_id', owner.id),
    ])
    expect(holdings.data).toEqual([])
    expect(manualCards.data).toEqual([])
    expect(tags.data).toEqual([])
    expect(holdingTags.data).toEqual([])
    expect(valuations.data).toEqual([])
  })
})
