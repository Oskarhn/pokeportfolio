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
 * M16 openings: the authorization suite (prompt scenarios E9/E10 + the D-060 privilege posture).
 * The three write RPCs are SECURITY DEFINER, so RLS is NOT their boundary — explicit
 * `user_id = auth.uid()` filters are, and these tests attack exactly that seam: cross-tenant
 * source lots, foreign openings, forged reconciliation targets, and direct-table writes the
 * grant model must refuse. No existence oracle anywhere: a foreign id fails identically to a
 * missing one.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm16-authz-a')
  userB = await createSyntheticUser(service, 'm16-authz-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

async function buySealedLot(client: TestClient, userId: string): Promise<string> {
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: 5,
          unit_price_minor: 1000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('id')
    .eq(
      'purchase_line_id',
      (await service.from('purchase_lines').select('id').eq('purchase_id', purchase.id).single())
        .data!.id,
    )
    .single()
  if (!lot) throw new Error(`no lot for user ${userId}`)
  return lot.id
}

describe('E10 — anon is denied everything', () => {
  it('every opening RPC rejects an unauthenticated caller', async () => {
    const anon = createAnonClient()
    const someUuid = crypto.randomUUID()

    const { error: createError } = await anon.rpc('create_opening', {
      p_source_lot_id: someUuid,
      p_quantity: 1,
    })
    expect(createError).not.toBeNull()

    const { error: provError } = await anon.rpc('create_opening_from_provisional', {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_total_paid_minor: 100,
      p_purchased_on: today,
    })
    expect(provError).not.toBeNull()

    const { error: voidError } = await anon.rpc('void_opening', { p_opening_id: someUuid })
    expect(voidError).not.toBeNull()

    const { error: recError } = await anon.rpc('reconcile_opening_cost', {
      p_opening_id: someUuid,
      p_real_source_lot_id: someUuid,
    })
    expect(recError).not.toBeNull()

    const { error: readError } = await anon.rpc('get_opening', { p_opening_id: someUuid })
    expect(readError).not.toBeNull()
  })

  it('anon reads no openings rows at all', async () => {
    const anon = createAnonClient()
    const { data, error } = await anon.from('openings').select('*')
    // Either an RLS-shaped empty set or an outright refusal — never rows.
    if (error !== null) {
      expect(error).toBeTruthy()
    } else {
      expect(data.length).toBe(0)
    }
  })
})

describe('E9 — cross-user attacks fail without an existence oracle', () => {
  let lotA: string

  beforeAll(async () => {
    lotA = await buySealedLot(clientA, userA.id)
  })

  it("B cannot open A's sealed lot", async () => {
    const { error } = await clientB.rpc('create_opening', {
      p_source_lot_id: lotA,
      p_quantity: 1,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toBe('source lot is unavailable')
  })

  it("B cannot void, reconcile or read A's opening", async () => {
    const { data: aOpening, error: openError } = await clientA.rpc('create_opening', {
      p_source_lot_id: lotA,
      p_quantity: 1,
    })
    if (openError) throw new Error(openError.message)

    const { error: voidError } = await clientB.rpc('void_opening', { p_opening_id: aOpening.id })
    expect(voidError).not.toBeNull()
    expect(voidError!.message).toContain('not found')

    const { error: recError } = await clientB.rpc('reconcile_opening_cost', {
      p_opening_id: aOpening.id,
      p_real_source_lot_id: lotA,
    })
    expect(recError).not.toBeNull()
    expect(recError!.message).toContain('not found')

    // B's own view of A's opening detail is empty.
    const { data: bView } = await clientB.rpc('get_opening', { p_opening_id: aOpening.id })
    expect(bView).toHaveLength(0)

    // And B cannot even see the row through the table.
    const { data: bRows } = await clientB.from('openings').select('*').eq('id', aOpening.id)
    expect((bRows ?? []).length).toBe(0)
  })

  it('provisional path refuses a foreign sealed product and a mismatched provisional link', async () => {
    // B creates a PRIVATE product; A cannot provisionally open against it.
    const { data: privateProduct } = await service
      .from('sealed_products')
      .insert({
        product_type: 'booster_pack',
        name: `m16 authz private ${userB.id}`,
        language: 'en',
        created_by_user_id: userB.id,
      })
      .select('id')
      .single<{ id: string }>()

    const { error: foreignProduct } = await clientA.rpc('create_opening_from_provisional', {
      p_sealed_product_id: privateProduct!.id,
      p_quantity: 1,
      p_total_paid_minor: 100,
      p_purchased_on: today,
    })
    expect(foreignProduct).not.toBeNull()

    // A forged provisional_purchase_id whose lot is not the consumed one fails consistency.
    await clientA.rpc('create_opening_from_provisional', {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_total_paid_minor: 1000,
      p_purchased_on: today,
    })

    const { lotId: manualLot } = await (async () => {
      const { data: purchase } = await clientA
        .rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'sealed',
              sealed_product_id: seedCatalog.sealedProductId,
              quantity: 1,
              unit_price_minor: 500,
            },
          ],
        })
        .single<{ id: string }>()
      const { data: lotRow } = await service
        .from('acquisition_lots')
        .select('id')
        .eq(
          'purchase_line_id',
          (
            await service
              .from('purchase_lines')
              .select('id')
              .eq('purchase_id', purchase!.id)
              .single()
          ).data!.id,
        )
        .single()
      return { lotId: lotRow!.id }
    })()

    // An ordinary MANUAL purchase cited as an opening's "provisional" source: the consistency
    // check must refuse — only a live provisional_opening purchase whose line produced exactly
    // the consumed lot may stand behind an opening.
    const { data: manualPurchase } = await service
      .from('purchases')
      .select('id')
      .eq('user_id', userA.id)
      .eq('origin', 'manual')
      .order('created_at', { ascending: false })
      .limit(1)
      .single<{ id: string }>()

    const { error: mismatch } = await clientA.rpc('create_opening', {
      p_source_lot_id: manualLot,
      p_quantity: 1,
      p_provisional_purchase_id: manualPurchase!.id,
    })
    expect(mismatch).not.toBeNull()
    expect(mismatch!.message).toContain('provisional purchase does not match')
  })
})

describe('the grant model holds: no direct browser writes to opening state', () => {
  it('authenticated cannot INSERT/UPDATE openings directly', async () => {
    const { error: insertError } = await clientA.from('openings').insert({
      user_id: userA.id,
      opened_on: today,
      source_lot_id: crypto.randomUUID(),
      sealed_product_id: seedCatalog.sealedProductId,
      quantity_opened: 1,
      cost_source: 'unknown',
    })
    expect(insertError).not.toBeNull()

    const { data: anyOpening } = await service
      .from('openings')
      .select('id')
      .eq('user_id', userA.id)
      .limit(1)
      .maybeSingle<{ id: string }>()

    if (anyOpening) {
      const { error: updateError } = await clientA
        .from('openings')
        .update({ cost_nok_minor: 1 })
        .eq('id', anyOpening.id)
      expect(updateError).not.toBeNull()

      const { error: deleteError } = await clientA.from('openings').delete().eq('id', anyOpening.id)
      expect(deleteError).not.toBeNull()
    }
  })

  it('authenticated cannot write kind=opened disposal rows directly', async () => {
    const { error } = await clientA.from('lot_disposals').insert({
      lot_id: crypto.randomUUID(),
      user_id: userA.id,
      kind: 'opened',
      quantity: 1,
      disposed_on: today,
      opening_id: crypto.randomUUID(),
    })
    expect(error).not.toBeNull()
  })

  it("authenticated cannot attach another user's opening_id to a pull lot (check-owner trigger)", async () => {
    // Self-sufficient fixtures (P62): B needs a raw-card holding to attempt the attachment
    // through, and A needs an opening whose id can be forged. Neither depends on leftovers
    // from earlier cases.
    const { data: bHolding } = await service
      .from('holdings')
      .insert({
        user_id: userB.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        grading_state: 'raw',
      })
      .select('id')
      .single<{ id: string }>()
    if (!bHolding) throw new Error('user B holding fixture failed')

    let aOpeningId = (
      await service
        .from('openings')
        .select('id')
        .eq('user_id', userA.id)
        .limit(1)
        .maybeSingle<{ id: string }>()
    ).data?.id
    if (!aOpeningId) {
      const bought = await buySealedLot(clientA, userA.id)
      const { data: created, error: createError } = await clientA
        .rpc('create_opening', {
          p_source_lot_id: bought,
          p_quantity: 1,
          p_opened_on: today,
        })
        .single<{ id: string }>()
      if (createError) {
        throw new Error(`opening fixture failed: ${createError.message}`)
      }
      aOpeningId = created.id
    }

    const { error } = await clientB.from('acquisition_lots').insert({
      holding_id: bHolding.id,
      origin: 'opening',
      cost_basis_state: 'unallocated_opening',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      opening_id: aOpeningId,
    })
    expect(error).not.toBeNull()
    expect(JSON.stringify(error)).toMatch(/same owner|must belong/i)
  })

  it('defence in depth fires under the service role too: openings_check_owner rejects mismatches', async () => {
    // service_role bypasses RLS entirely — only the trigger stands between a privileged writer
    // and an inconsistent row. It must hold there as well.
    const lotId = await buySealedLot(clientB, userB.id)
    const { error } = await service.from('openings').insert({
      user_id: userA.id, // WRONG owner on purpose
      opened_on: today,
      source_lot_id: lotId, // belongs to B
      sealed_product_id: seedCatalog.sealedProductId,
      quantity_opened: 1,
      cost_source: 'unknown',
    })
    expect(error).not.toBeNull()
    expect(JSON.stringify(error)).toMatch(/same owner/i)
  })
})
