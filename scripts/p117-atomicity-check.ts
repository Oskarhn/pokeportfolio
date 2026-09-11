import { createServiceClient, createSyntheticUser, deleteSyntheticUser, seedCatalog, signInAs } from '../tests/db/setup'

const today = new Date().toISOString().slice(0, 10)

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p117-atomicity')
  const clientA = await signInAs(userA)
  try {
    async function counts() {
      const [p, pl, al] = await Promise.all([
        service.from('purchases').select('id', { count: 'exact', head: true }).eq('user_id', userA.id),
        service.from('purchase_lines').select('id', { count: 'exact', head: true }).eq('user_id', userA.id),
        service.from('acquisition_lots').select('id', { count: 'exact', head: true }).eq('user_id', userA.id),
      ])
      return { purchases: p.count, purchase_lines: pl.count, acquisition_lots: al.count }
    }

    console.log('=== create_purchase: 2 valid lines then 1 invalid (bad sealed_product_id) ===')
    const before1 = await counts()
    const { error: e1 } = await clientA.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { line_type: 'card', card_variant_id: seedCatalog.pikachuVariantId, condition: 'NM', quantity: 1, unit_price_minor: 1000 },
        { line_type: 'card', card_variant_id: seedCatalog.charizardVariantId, condition: 'NM', quantity: 1, unit_price_minor: 2000 },
        { line_type: 'sealed', sealed_product_id: '00000000-0000-0000-0000-000000000000', quantity: 1, unit_price_minor: 500 },
      ],
    })
    const after1 = await counts()
    console.log(`error=${e1?.message ?? 'NONE (unexpected)'}`)
    console.log(`before=${JSON.stringify(before1)} after=${JSON.stringify(after1)}`)
    if (JSON.stringify(before1) !== JSON.stringify(after1)) console.log('  !! ANOMALY: partial rows survived a failed create_purchase')

    console.log('\n=== create_sale: valid line then a line referencing a nonexistent lot ===')
    const { data: purchase } = await clientA.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [{ line_type: 'card', card_variant_id: seedCatalog.pikachuVariantId, condition: 'NM', quantity: 2, unit_price_minor: 1000 }],
    }).single<{ id: string }>()
    const { data: line } = await service.from('purchase_lines').select('id').eq('purchase_id', purchase!.id).single<{ id: string }>()
    const { data: lot } = await service.from('acquisition_lots').select('id, quantity_remaining').eq('purchase_line_id', line!.id).single<{ id: string; quantity_remaining: number }>()

    async function saleCounts() {
      const [s, sl, ld] = await Promise.all([
        service.from('sales').select('id', { count: 'exact', head: true }).eq('user_id', userA.id),
        service.from('sale_lines').select('id', { count: 'exact', head: true }).eq('user_id', userA.id),
        service.from('lot_disposals').select('id', { count: 'exact', head: true }).eq('user_id', userA.id),
      ])
      return { sales: s.count, sale_lines: sl.count, lot_disposals: ld.count }
    }
    const beforeSale = await saleCounts()
    const { error: e2 } = await clientA.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [
        { lot_id: lot!.id, quantity: 1, unit_gross_minor: 1500 },
        { lot_id: '00000000-0000-0000-0000-000000000000', quantity: 1, unit_gross_minor: 1500 },
      ],
    })
    const afterSale = await saleCounts()
    const { data: lotAfter } = await service.from('acquisition_lots').select('quantity_remaining').eq('id', lot!.id).single<{ quantity_remaining: number }>()
    console.log(`error=${e2?.message ?? 'NONE (unexpected)'}`)
    console.log(`before=${JSON.stringify(beforeSale)} after=${JSON.stringify(afterSale)}`)
    console.log(`lot quantity_remaining: before=${lot!.quantity_remaining} after=${lotAfter?.quantity_remaining}`)
    if (JSON.stringify(beforeSale) !== JSON.stringify(afterSale)) console.log('  !! ANOMALY: partial rows survived a failed create_sale')
    if (lot!.quantity_remaining !== lotAfter?.quantity_remaining) console.log('  !! ANOMALY: lot quantity_remaining mutated despite the sale failing')
  } finally {
    await deleteSyntheticUser(service, userA.id)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
