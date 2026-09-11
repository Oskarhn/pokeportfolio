import { createServiceClient, createSyntheticUser, deleteSyntheticUser, seedCatalog, signInAs } from '../tests/db/setup'

const today = new Date().toISOString().slice(0, 10)
const BOUNDARY_VALUES = [
  0n, 1n, -1n,
  2147483647n, 2147483648n, // 2^31 boundary
  9007199254740991n, // 2^53 - 1
  9007199254740992n, // 2^53
  9007199254740993n, // 2^53 + 1
  922337203685477580n, // near bigint max / 10
]

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p117-money-bound')
  const clientA = await signInAs(userA)
  try {
    console.log('=== NOK currency (no FX conversion) ===')
    for (const v of BOUNDARY_VALUES) {
      const { data, error } = await clientA
        .rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'NOK',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity: 1,
              unit_price_minor: v.toString(),
            },
          ],
        })
        .single<{ id: string; total_minor: string; total_nok_minor: string }>()
      console.log(`unit_price_minor=${v} -> error=${error?.message ?? 'none'} total_minor=${data?.total_minor} total_nok_minor=${data?.total_nok_minor}`)
    }

    console.log('\n=== EUR currency with manual FX 11.54 (forces the v_fx_rate numeric(18,8) path) ===')
    for (const v of BOUNDARY_VALUES) {
      const { data, error } = await clientA
        .rpc('create_purchase', {
          p_purchased_on: today,
          p_currency: 'EUR',
          p_fx_rate_to_nok: '11.54000000',
          p_fx_rate_date: today,
          p_fx_source: 'manual',
          p_lines: [
            {
              line_type: 'card',
              card_variant_id: seedCatalog.pikachuVariantId,
              condition: 'NM',
              quantity: 1,
              unit_price_minor: v.toString(),
            },
          ],
        })
        .single<{ id: string; total_minor: string; total_nok_minor: string }>()
      console.log(`unit_price_minor=${v} -> error=${error?.message ?? 'none'} total_minor=${data?.total_minor} total_nok_minor=${data?.total_nok_minor}`)
    }
  } finally {
    await deleteSyntheticUser(service, userA.id)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
