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
 * Constraint and check tests (docs/TESTING.md §5). Uses the service-role client, which bypasses
 * RLS but never bypasses CHECK constraints or triggers — these are properties of the schema
 * itself, exercised directly rather than through a particular user's session.
 */

let service: TestClient
let user: SyntheticUser

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'constraints')
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

const today = new Date().toISOString().slice(0, 10)

describe('holdings constraints', () => {
  it('rejects a holding with both card_variant_id and sealed_product_id set', async () => {
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      card_variant_id: seedCatalog.pikachuVariantId,
      sealed_product_id: seedCatalog.sealedProductId,
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })

  it('rejects a holding with neither card_variant_id nor sealed_product_id set', async () => {
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })

  it('rejects a condition on a sealed holding', async () => {
    const { error } = await service.from('holdings').insert({
      user_id: user.id,
      holding_kind: 'sealed',
      sealed_product_id: seedCatalog.sealedProductId,
      condition: 'NM',
    })
    expect(error).not.toBeNull()
  })

  it('holdings_identity prevents a duplicate physical-state row', async () => {
    const payload = {
      user_id: user.id,
      holding_kind: 'raw_card' as const,
      card_variant_id: seedCatalog.grassEnergyVariantId,
      condition: 'NM' as const,
    }
    const first = await service.from('holdings').insert(payload)
    expect(first.error).toBeNull()

    const second = await service.from('holdings').insert(payload)
    expect(second.error).not.toBeNull()
  })
})

describe('acquisition_lots constraints (invariant M2)', () => {
  it('rejects cost_basis_state=known with no unit_cost_basis_minor', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'NM',
      })
      .select()
      .single()

    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'purchase',
      cost_basis_state: 'known',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      // unit_cost_basis_minor and purchase_line_id both omitted — violates M2.
    })
    expect(error).not.toBeNull()
  })

  it('rejects cost_basis_state=unknown with a unit_cost_basis_minor present', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'LP',
      })
      .select()
      .single()

    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'pre_tracking',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      unit_cost_basis_minor: 100,
    })
    expect(error).not.toBeNull()
  })

  it('rejects a gift-origin lot with a cost_basis_state other than not_paid', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'EX',
      })
      .select()
      .single()

    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    expect(error).not.toBeNull()
  })

  it('rejects quantity_remaining greater than quantity', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'GD',
      })
      .select()
      .single()

    const { error } = await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'found',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 2,
    })
    expect(error).not.toBeNull()
  })
})

describe('purchases and purchase_lines constraints', () => {
  it('rejects a purchase whose total does not match subtotal + shipping + customs - discount', async () => {
    const { error } = await service.from('purchases').insert({
      user_id: user.id,
      purchased_on: today,
      currency: 'NOK',
      subtotal_minor: 1_000,
      shipping_minor: 100,
      total_minor: 1_000, // should be 1100
      fx_rate_date: today,
      total_nok_minor: 1_000,
    })
    expect(error).not.toBeNull()
  })

  it('rejects a purchase_line whose line_total does not match unit_price * quantity', async () => {
    const { data: purchase } = await service
      .from('purchases')
      .insert({
        user_id: user.id,
        purchased_on: today,
        currency: 'NOK',
        subtotal_minor: 500,
        total_minor: 500,
        fx_rate_date: today,
        total_nok_minor: 500,
      })
      .select()
      .single()

    const { error } = await service.from('purchase_lines').insert({
      purchase_id: purchase!.id,
      user_id: user.id,
      line_type: 'card',
      spend_class: 'collectible',
      quantity: 2,
      unit_price_minor: 500,
      line_total_minor: 500, // should be 1000
    })
    expect(error).not.toBeNull()
  })

  it('rejects a purchase_line with both card_variant_id and sealed_product_id set', async () => {
    const { data: purchase } = await service
      .from('purchases')
      .insert({
        user_id: user.id,
        purchased_on: today,
        currency: 'NOK',
        subtotal_minor: 500,
        total_minor: 500,
        fx_rate_date: today,
        total_nok_minor: 500,
      })
      .select()
      .single()

    const { error } = await service.from('purchase_lines').insert({
      purchase_id: purchase!.id,
      user_id: user.id,
      line_type: 'card',
      spend_class: 'collectible',
      card_variant_id: seedCatalog.charizardVariantId,
      sealed_product_id: seedCatalog.sealedProductId,
      quantity: 1,
      unit_price_minor: 500,
      line_total_minor: 500,
    })
    expect(error).not.toBeNull()
  })
})
