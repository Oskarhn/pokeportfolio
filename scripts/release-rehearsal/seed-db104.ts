/**
 * Synthetic dataset for the Production-like DB104 -> DB114 rehearsal (P195).
 *
 *   source <stack>/env.sh && tsx scripts/release-rehearsal/seed-db104.ts <ids-output.json>
 *
 * Runs against a LOCAL/ISOLATED stack only (refuses a non-loopback SUPABASE_URL). Everything goes
 * through the official RPCs of the 104-migration schema, so the rows are exactly what the released
 * client could have written: two users, purchases (card, sealed, accessory, JPY with a manual rate),
 * a sale, a negative-proceeds sale (fees above gross), an opening, a manual valuation, a private
 * sealed product, an unredeemed invitation, FX rows, price snapshots and a user reserved for the
 * account-deletion step. No real data, no personal e-mail (`.invalid` addresses only).
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- operator rehearsal tool over an untyped service client; every result is checked explicitly */
import { writeFileSync } from 'node:fs'
import {
  createInvitationDirect,
  createServiceClient,
  createSyntheticUser,
  seedCatalog,
  signInAs,
} from '../../tests/db/setup'

const url = process.env.SUPABASE_URL ?? ''
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('refused: the seed writes synthetic data and runs only against a loopback stack')
  process.exit(64)
}
const out = process.argv[2]
if (!out) {
  console.error('usage: seed-db104.ts <ids-output.json>')
  process.exit(64)
}

const service = createServiceClient()
const today = new Date().toISOString().slice(0, 10)
const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`${what}: ${r.error?.message ?? 'no data'}`)
  return r.data
}

const userA = await createSyntheticUser(service, 'p195-a')
const userB = await createSyntheticUser(service, 'p195-b')
const userD = await createSyntheticUser(service, 'p195-delete')
const a = await signInAs(userA)
const b = await signInAs(userB)
const d = await signInAs(userD)

await service.from('fx_rates').insert([
  {
    base_currency: 'USD',
    quote_currency: 'NOK',
    rate_date: today,
    rate: 10.5,
    source: 'norges_bank',
  },
  {
    base_currency: 'EUR',
    quote_currency: 'NOK',
    rate_date: today,
    rate: 11.54,
    source: 'norges_bank',
  },
])
await service.from('price_snapshots').insert({
  card_variant_id: seedCatalog.pikachuVariantId,
  provider: 'tcgdex_cardmarket',
  price_kind: 'cm_trend',
  source_currency: 'EUR',
  value_minor: 450,
  snapshot_date: today,
  provider_updated_at: new Date().toISOString(),
})

// User A: a multi-line card purchase, then a sale of one lot (positive result).
const purchase = must(
  await a
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 2,
          unit_price_minor: 10000,
        },
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 25000,
        },
      ],
    })
    .single<{ id: string }>(),
  'create_purchase',
)
const lines = must(
  await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .order('created_at'),
  'purchase_lines',
)
const lots = must(
  await service
    .from('acquisition_lots')
    .select('id, quantity')
    .in(
      'purchase_line_id',
      lines.map((l) => l.id as string),
    ),
  'lots',
)
const pikachuLot = lots.find((l) => l.quantity === 2)!.id as string
const charizardLot = lots.find((l) => l.quantity === 1)!.id as string

const sale = must(
  await a
    .rpc('create_sale', {
      p_idempotency_key: crypto.randomUUID(),
      p_sold_on: today,
      p_currency: 'NOK',
      p_fees_minor: 2000,
      p_lines: [{ lot_id: pikachuLot, quantity: 1, unit_gross_minor: 22000 }],
    })
    .single<{ id: string }>(),
  'create_sale',
)
// Negative-proceeds boundary: fees larger than the gross (a loss-making sale the model must keep).
const negativeSale = await a
  .rpc('create_sale', {
    p_idempotency_key: crypto.randomUUID(),
    p_sold_on: today,
    p_currency: 'NOK',
    p_fees_minor: 5000,
    p_lines: [{ lot_id: pikachuLot, quantity: 1, unit_gross_minor: 3000 }],
  })
  .single<{ id: string }>()

// JPY purchase with a manual rate, an accessory purchase and a manual valuation.
const jpy = must(
  await a
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'JPY',
      p_fx_rate_to_nok: '0.06037500',
      p_fx_rate_date: today,
      p_fx_source: 'manual',
      p_lines: [
        { line_type: 'accessory', description: 'Playmat', quantity: 1, unit_price_minor: 9999 },
      ],
    })
    .single<{ id: string; total_nok_minor: number }>(),
  'jpy purchase',
)
const holding = must(
  await a
    .rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 500,
      p_quantity: 3,
      p_acquired_on: today,
    })
    .single<{ holding_id: string }>(),
  'add_card_acquisition',
)
must(
  await a.rpc('set_manual_valuation', { p_holding_id: holding.holding_id, p_value_minor: 1200 }),
  'set_manual_valuation',
)

// Sealed: a curated product kept sealed, then opened into pulls; plus a user-private sealed product.
const sealed = must(
  await a
    .rpc('add_card_acquisition', {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_grading_state: 'raw',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 129900,
      p_quantity: 2,
      p_acquired_on: today,
      p_sealed_intent: 'keep_sealed',
    })
    .single<{ holding_id: string; lot_id: string }>(),
  'sealed acquisition',
)
const opening = await a
  .rpc('create_opening', {
    p_source_lot_id: sealed.lot_id,
    p_quantity: 1,
    p_opened_on: today,
    p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
  })
  .single<{ id: string }>()
const privateSealed = must(
  await a
    .from('sealed_products')
    .insert({
      name: 'P195 private sealed product',
      language: 'en',
      product_type: 'other',
      created_by_user_id: userA.id,
    })
    .select('id')
    .single(),
  'private sealed product',
)

// User B has their own data; an unredeemed invitation exists; the deletion user owns a purchase.
const bPurchase = must(
  await b
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 7000,
        },
      ],
    })
    .single<{ id: string }>(),
  'b purchase',
)
const dPurchase = must(
  await d
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.grassEnergyVariantId,
          condition: 'NM',
          quantity: 4,
          unit_price_minor: 1500,
        },
      ],
    })
    .single<{ id: string }>(),
  'delete-user purchase',
)
const invitation = await createInvitationDirect(service, { label: 'p195-open-invitation' })

writeFileSync(
  out,
  JSON.stringify(
    {
      userA: userA.id,
      userB: userB.id,
      userDelete: userD.id,
      userDeleteEmail: userD.email,
      userDeletePassword: userD.password,
      purchaseA: purchase.id,
      saleA: sale.id,
      negativeSaleOk: negativeSale.error === null,
      jpyPurchase: jpy.id,
      sealedLot: sealed.lot_id,
      openingA: opening.data?.id ?? null,
      openingOk: opening.error === null,
      privateSealedA: (privateSealed as unknown as { id: string }).id,
      purchaseB: bPurchase.id,
      purchaseDelete: dPurchase.id,
      charizardLot,
      invitationId: invitation.id,
    },
    null,
    2,
  ),
)
console.log(
  'seeded: users A/B/D, purchases, 2 sales, JPY purchase, valuation, sealed + opening, invitation',
)
