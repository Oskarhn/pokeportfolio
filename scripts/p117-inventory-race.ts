/**
 * P117 standalone stress harness — concurrent inventory depletion races.
 *
 * NOT part of `pnpm test:db` or CI. Run with:
 *   tsx scripts/p117-inventory-race.ts
 * against a running local Supabase stack (SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY
 * exported, matching tests/db/setup.ts's own contract).
 */
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type TestClient,
} from '../tests/db/setup'

const today = new Date().toISOString().slice(0, 10)

async function makeLot(clientA: TestClient, quantity: number) {
  const { data, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity,
          unit_price_minor: 1000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(`makeLot purchase failed: ${error.message}`)
  const { data: line, error: lineError } = await createServiceClient()
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', data!.id)
    .single<{ id: string }>()
  if (lineError) throw new Error(lineError.message)
  const { data: lot, error: lotError } = await createServiceClient()
    .from('acquisition_lots')
    .select('id, quantity, quantity_remaining')
    .eq('purchase_line_id', line!.id)
    .single<{ id: string; quantity: number; quantity_remaining: number }>()
  if (lotError) throw new Error(lotError.message)
  return lot
}

async function sellRace(clientA: TestClient, service: TestClient, lotQuantity: number, concurrency: number) {
  const lot = await makeLot(clientA, lotQuantity)
  const attempts = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      clientA
        .rpc('create_sale', {
          p_sold_on: today,
          p_currency: 'NOK',
          p_idempotency_key: crypto.randomUUID(),
          p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 1500 }],
        })
        .single<{ id: string }>(),
    ),
  )
  let ok = 0
  let insufficientErrors = 0
  let otherErrors = 0
  for (const a of attempts) {
    if (a.status === 'rejected') {
      otherErrors++
      continue
    }
    if (a.value.error) {
      if (/quantity|insufficient|available/i.test(a.value.error.message)) insufficientErrors++
      else otherErrors++
    } else {
      ok++
    }
  }
  const { data: after } = await service
    .from('acquisition_lots')
    .select('quantity_remaining')
    .eq('id', lot.id)
    .single<{ quantity_remaining: number }>()
  const { count: disposalCount } = await service
    .from('lot_disposals')
    .select('id', { count: 'exact', head: true })
    .eq('lot_id', lot.id)
    .is('voided_at', null)
  console.log(
    `lotQty=${lotQuantity} concurrency=${concurrency} succeeded=${ok} insufficient=${insufficientErrors} ` +
      `other_errors=${otherErrors} quantity_remaining_after=${after?.quantity_remaining} live_disposals=${disposalCount}`,
  )
  if (ok !== lotQuantity) console.log(`  !! ANOMALY: expected exactly ${lotQuantity} successful sales, got ${ok}`)
  if (after?.quantity_remaining !== 0) console.log(`  !! ANOMALY: expected quantity_remaining=0, got ${after?.quantity_remaining}`)
  if ((after?.quantity_remaining ?? 0) < 0) console.log('  !! CRITICAL: NEGATIVE INVENTORY')
  if (disposalCount !== lotQuantity) console.log(`  !! ANOMALY: expected ${lotQuantity} live disposal rows, got ${disposalCount}`)
}

async function openingRace(clientA: TestClient, service: TestClient, sealedQuantity: number, concurrency: number) {
  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: sealedQuantity,
          unit_price_minor: 5000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(`opening race purchase failed: ${error.message}`)
  const { data: line } = await service.from('purchase_lines').select('id').eq('purchase_id', purchase!.id).single<{ id: string }>()
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', line!.id)
    .single<{ id: string }>()

  const attempts = await Promise.allSettled(
    Array.from({ length: concurrency }, () =>
      clientA.rpc('create_opening', {
        p_source_lot_id: lot!.id,
        p_quantity: 1,
        p_opened_on: today,
        p_tracking_completeness: 'unknown',
        p_pulls: [],
        p_idempotency_key: crypto.randomUUID(),
      }),
    ),
  )
  let ok = 0
  let insufficient = 0
  let other = 0
  for (const a of attempts) {
    if (a.status === 'rejected') other++
    else if (a.value.error) {
      if (/quantity|insufficient|available/i.test(a.value.error.message)) insufficient++
      else other++
    } else ok++
  }
  const { data: after } = await service
    .from('acquisition_lots')
    .select('quantity_remaining')
    .eq('id', lot!.id)
    .single<{ quantity_remaining: number }>()
  console.log(
    `sealedQty=${sealedQuantity} concurrency=${concurrency} succeeded=${ok} insufficient=${insufficient} ` +
      `other_errors=${other} quantity_remaining_after=${after?.quantity_remaining}`,
  )
  if (ok !== sealedQuantity) console.log(`  !! ANOMALY: expected exactly ${sealedQuantity} successful opens, got ${ok}`)
  if ((after?.quantity_remaining ?? 0) < 0) console.log('  !! CRITICAL: NEGATIVE INVENTORY')
}

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p117-race')
  const clientA = await signInAs(userA)
  try {
    console.log('=== Concurrent sale of the same lot (N workers race M available units) ===')
    for (const [qty, conc] of [[1, 2], [3, 10], [5, 50], [10, 100]] as const) {
      await sellRace(clientA, service, qty, conc)
    }
    console.log('\n=== Concurrent opening of the same sealed lot ===')
    for (const [qty, conc] of [[1, 2], [3, 10], [5, 50], [10, 100]] as const) {
      await openingRace(clientA, service, qty, conc)
    }
  } finally {
    await deleteSyntheticUser(service, userA.id)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
