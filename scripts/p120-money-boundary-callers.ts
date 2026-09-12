/**
 * P120 §13 — money boundary sweep across create_sale and set_manual_valuation. P117's own output
 * explicitly disclosed this as NOT done: "each CALLER's own arithmetic (e.g. create_sale's
 * fee/shipping allocation ...) was not independently boundary-fuzzed this session." This extends
 * the same boundary-value ladder P117 used for create_purchase to these two remaining callers.
 *
 * §14 finding (extends D-125 finding 1, does not change it): set_manual_valuation's RPC RESPONSE
 * silently rounds value_minor/value_nok_minor at/above 2^53 through this JS test client's own
 * JSON.parse (e.g. submitting 9007199254740993 reads back as 9007199254740992) — confirmed via a
 * direct `docker exec psql` query that the STORED row is byte-exact for every boundary value
 * tested, including 9007199254740993 and 922337203685477580. This is the SAME PostgREST
 * bigint-as-JSON-number limitation D-125 already found and deliberately left unfixed for
 * `allocate_largest_remainder`'s array return; this session confirms it also reaches a scalar
 * money field on a different RPC's response, not just an internal allocator's array. Still
 * practically unreachable through real data entry (a manual valuation at that magnitude is ~90
 * trillion NOK), so no fix is warranted here either — recorded as evidence the affected surface is
 * broader than D-125 originally scoped, not as a new decision.
 *
 * Usage: pnpm exec tsx scripts/p120-money-boundary-callers.ts
 */
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
} from '../tests/db/setup'

const today = new Date().toISOString().slice(0, 10)
const BOUNDARY_VALUES = [
  0n,
  1n,
  99n,
  100n,
  2_147_483_647n, // 2^31-1
  2_147_483_648n, // 2^31
  9_007_199_254_740_991n, // 2^53-1
  9_007_199_254_740_992n, // 2^53
  9_007_199_254_740_993n, // 2^53+1
  3_037_000_499n, // sqrt(bigint max) floor — P117's discovered per-operand overflow threshold
  922_337_203_685_477_580n, // ~bigint max / 10
]

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p120-money-bound-callers')
  const clientA = await signInAs(userA)

  console.log('=== create_sale fee/shipping boundary sweep ===')
  for (const v of BOUNDARY_VALUES) {
    // Fresh purchase+lot each time so quantity_remaining is never exhausted across iterations.
    const { data: purchase, error: purchaseError } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.charizardVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 10000,
          },
        ],
      })
      .single<{ id: string }>()
    if (purchaseError) {
      console.log(`  [setup failed] ${purchaseError.message}`)
      continue
    }
    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .single<{ id: string }>()
    if (lineError) throw new Error(`line fetch failed: ${lineError.message}`)
    const { data: lot, error: lotError } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', line.id)
      .single<{ id: string }>()
    if (lotError) throw new Error(`lot fetch failed: ${lotError.message}`)

    const { data, error } = await clientA
      .rpc('create_sale', {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: today,
        p_currency: 'NOK',
        p_fees_minor: v.toString(),
        p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: v.toString() }],
      })
      .single<{ id: string; net_proceeds_minor: string }>()
    console.log(
      `fees=unit_gross=${v} -> error=${error?.message ?? 'none'} net_proceeds_minor=${data?.net_proceeds_minor}`,
    )
  }

  console.log('\n=== set_manual_valuation boundary sweep ===')
  const { data: purchase2, error: purchase2Error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 10000,
        },
      ],
    })
    .single<{ id: string }>()
  if (purchase2Error) throw new Error(`purchase2 setup failed: ${purchase2Error.message}`)
  const { data: line2, error: line2Error } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase2.id)
    .single<{ id: string }>()
  if (line2Error) throw new Error(`line2 fetch failed: ${line2Error.message}`)
  const { data: lot2, error: lot2Error } = await service
    .from('acquisition_lots')
    .select('holding_id')
    .eq('purchase_line_id', line2.id)
    .single<{ holding_id: string }>()
  if (lot2Error) throw new Error(`lot2 fetch failed: ${lot2Error.message}`)

  for (const v of BOUNDARY_VALUES) {
    const { data, error } = await clientA
      .rpc('set_manual_valuation', {
        p_holding_id: lot2.holding_id,
        p_value_minor: v.toString(),
      })
      .single<{ value_minor: string; value_nok_minor: string }>()
    console.log(
      `value_minor=${v} -> error=${error?.message ?? 'none'} result=${JSON.stringify(data)}`,
    )
  }

  // Negative and malformed inputs — must be rejected cleanly, not crash.
  console.log('\n=== negative / malformed inputs ===')
  const hostileValues = [
    '-1',
    '-9223372036854775808',
    'not-a-number',
    '',
    '1.5',
    '9999999999999999999999',
  ]
  for (const v of hostileValues) {
    const { error } = await clientA.rpc('set_manual_valuation', {
      p_holding_id: lot2.holding_id,
      p_value_minor: v,
    })
    console.log(
      `p_value_minor=${JSON.stringify(v)} -> error=${error?.message ?? 'NONE (unexpected)'}`,
    )
  }

  await deleteSyntheticUser(service, userA.id)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
