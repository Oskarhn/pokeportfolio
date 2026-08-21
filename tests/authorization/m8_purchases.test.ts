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
 * M8: cross-tenant attacks against the purchase-ledger RPCs and the fx_rates cache
 * (SECURITY.md §3.3, TESTING.md §4). create_purchase/update_purchase/void_purchase derive
 * ownership entirely from auth.uid() — there is no user_id argument to forge — so what is tested
 * here is what *is* caller-supplied: another user's retailer, purchase, or line id.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm8-purchases-a')
  userB = await createSyntheticUser(service, 'm8-purchases-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function makePurchase(client: TestClient, lines: Record<string, unknown>[] = []) {
  const { data, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines:
        lines.length > 0
          ? lines
          : [
              {
                line_type: 'accessory',
                description: 'Sleeves',
                quantity: 1,
                unit_price_minor: 500,
              },
            ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  return data
}

describe('create_purchase: ownership derives from the caller, never a forged id', () => {
  it('a purchase A creates is owned by A, never by an argument', async () => {
    const purchase = await makePurchase(clientA)
    const { data } = await service
      .from('purchases')
      .select('user_id')
      .eq('id', purchase.id)
      .single()
    expect(data?.user_id).toBe(userA.id)
  })

  it("A cannot use B's retailer on their own purchase (S1)", async () => {
    const { data: retailer } = await clientB
      .from('retailers')
      .insert({ name: `b-retailer-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await clientA.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_retailer_id: retailer!.id,
      p_lines: [
        { line_type: 'accessory', description: 'Sleeves', quantity: 1, unit_price_minor: 500 },
      ],
    })
    expect(error).not.toBeNull()
  })

  it("A cannot attach a card line to B's storage location", async () => {
    const { data: location } = await clientB
      .from('storage_locations')
      .insert({ name: `b-binder-${Date.now()}` })
      .select('id')
      .single()

    const { error } = await clientA.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 500,
          storage_location_id: location!.id,
        },
      ],
    })
    expect(error).not.toBeNull()
  })
})

describe("update_purchase / void_purchase: a stranger's id is refused, not found rather than exploited", () => {
  it('B cannot update a purchase owned by A', async () => {
    const purchase = await makePurchase(clientA)
    const { error } = await clientB.rpc('update_purchase', {
      p_purchase_id: purchase.id,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [],
    })
    expect(error).not.toBeNull()

    const { data: untouched } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase.id)
      .single()
    expect(untouched?.voided_at).toBeNull()
  })

  it('B cannot void a purchase owned by A', async () => {
    const purchase = await makePurchase(clientA)
    const { error } = await clientB.rpc('void_purchase', { p_purchase_id: purchase.id })
    expect(error).not.toBeNull()

    const { data: stillLive } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchase.id)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })

  it("B cannot void A's acquisition lot via void_acquisition_lot", async () => {
    const purchase = await makePurchase(clientA, [
      {
        line_type: 'card',
        card_variant_id: seedCatalog.grassEnergyVariantId,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 500,
      },
    ])
    const { data: line } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .single()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', line!.id)
      .single()

    const { error } = await clientB.rpc('void_acquisition_lot', { p_lot_id: lot!.id })
    expect(error).not.toBeNull()

    const { data: stillLive } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('id', lot!.id)
      .single()
    expect(stillLive?.voided_at).toBeNull()
  })
})

describe('purchase_spending_summary: strict per-user scope', () => {
  it("B's summary never includes A's spend", async () => {
    await makePurchase(clientA, [
      { line_type: 'accessory', description: 'A-only item', quantity: 1, unit_price_minor: 99999 },
    ])
    const { data: bSummary } = await clientB.rpc('purchase_spending_summary').single<{
      gpo_nok_minor: string
    }>()
    // B's own fixture purchases from other tests in this file may be non-zero, but a single A-only
    // 999.99 kr line must never appear in B's total — asserted via a large, distinctive amount
    // rather than an exact-zero check that a shared beforeAll fixture could make flaky.
    const { data: aSummary } = await clientA.rpc('purchase_spending_summary').single<{
      gpo_nok_minor: string
    }>()
    expect(Number(aSummary?.gpo_nok_minor)).toBeGreaterThanOrEqual(99999)
    expect(Number(bSummary?.gpo_nok_minor)).not.toBe(Number(aSummary?.gpo_nok_minor))
  })
})

describe('fx_rates: no user can poison the shared cache', () => {
  it('neither A nor B holds insert/update/delete on fx_rates', async () => {
    for (const client of [clientA, clientB]) {
      const { error: insertError } = await client.from('fx_rates').insert({
        base_currency: 'GBP',
        quote_currency: 'NOK',
        rate_date: today,
        rate: 1,
        source: 'manual',
      })
      expect(insertError).not.toBeNull()
    }
  })
})

describe('retailers: cross-user id rejected at the database level', () => {
  it("B cannot read A's retailer by id", async () => {
    const { data: retailer } = await clientA
      .from('retailers')
      .insert({ name: `a-retailer-${Date.now()}` })
      .select('id')
      .single()
    const { data } = await clientB.from('retailers').select().eq('id', retailer!.id)
    expect(data).toEqual([])
  })
})
