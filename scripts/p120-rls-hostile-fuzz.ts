/**
 * P120 §28/§29/§32 — a NEW randomized hostile cross-user matrix, additional to (not a
 * re-verification of) `tests/authorization/**`'s existing fixed-case coverage.
 *
 * User B is seeded with one real row in every user-owned table reachable from a normal session
 * (via service role — the standard fixture-seeding pattern already used throughout tests/db/**).
 * User A (and an anon client) then attempts direct-select / update / delete / FK-spoofing-insert
 * against every one of B's real row ids, plus a high-volume blind random-UUID-guessing sweep
 * across every table, plus cross-user RPC calls against B's real resource ids. Every attempt is
 * tallied; the property under test is zero leaked rows and zero successful mutations anywhere.
 *
 * Usage: pnpm exec tsx scripts/p120-rls-hostile-fuzz.ts
 */
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  seedCatalog,
  signInAs,
} from '../tests/db/setup'

const today = new Date().toISOString().slice(0, 10)

interface Tally {
  attempts: number
  leaks: string[]
}
const tally: Tally = { attempts: 0, leaks: [] }

function note(label: string, leaked: boolean) {
  tally.attempts++
  if (leaked) tally.leaks.push(label)
}

interface ErrorLike {
  message: string
}

/** Unwraps a Supabase `.single<T>()` result, throwing on error (never on a legitimately-typed T). */
function mustSingle<T>(context: string, result: { data: T | null; error: ErrorLike | null }): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`)
  if (result.data === null) throw new Error(`${context}: no row returned`)
  return result.data
}

async function main() {
  const service = createServiceClient()
  const anon = createAnonClient()

  const userA = await createSyntheticUser(service, 'p120-rls-a')
  const userB = await createSyntheticUser(service, 'p120-rls-b')
  const clientA = await signInAs(userA)
  const clientB = await signInAs(userB)

  // ---- Seed B's real rows in every user-owned table (service role — standard fixture pattern) ----
  const tag = mustSingle(
    'seed tag',
    await service
      .from('tags')
      .insert({ user_id: userB.id, name: 'p120-b-tag' })
      .select('id')
      .single<{
        id: string
      }>(),
  )
  const retailer = mustSingle(
    'seed retailer',
    await service
      .from('retailers')
      .insert({ user_id: userB.id, name: 'p120-b-retailer' })
      .select('id')
      .single<{ id: string }>(),
  )
  const storageLocation = mustSingle(
    'seed storage location',
    await service
      .from('storage_locations')
      .insert({ user_id: userB.id, name: 'p120-b-storage' })
      .select('id')
      .single<{ id: string }>(),
  )
  const collection = mustSingle(
    'seed custom collection',
    await service
      .from('custom_collections')
      .insert({ user_id: userB.id, name: 'p120-b-collection' })
      .select('id')
      .single<{ id: string }>(),
  )

  const purchase = mustSingle(
    'seed purchase',
    await clientB
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.charizardVariantId,
            condition: 'NM',
            quantity: 2,
            unit_price_minor: 10000,
          },
        ],
      })
      .single<{ id: string }>(),
  )
  const purchaseLine = mustSingle(
    'seed purchase line lookup',
    await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchase.id)
      .single<{ id: string }>(),
  )
  const lot = mustSingle(
    'seed lot lookup',
    await service
      .from('acquisition_lots')
      .select('id, holding_id')
      .eq('purchase_line_id', purchaseLine.id)
      .single<{ id: string; holding_id: string }>(),
  )
  const holding = mustSingle(
    'seed holding lookup',
    await service.from('holdings').select('id').eq('id', lot.holding_id).single<{ id: string }>(),
  )

  const sale = mustSingle(
    'seed sale',
    await clientB
      .rpc('create_sale', {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 15000 }],
      })
      .single<{ id: string }>(),
  )
  const saleLine = mustSingle(
    'seed sale line lookup',
    await service.from('sale_lines').select('id').eq('sale_id', sale.id).single<{ id: string }>(),
  )
  const disposal = mustSingle(
    'seed disposal lookup',
    await service.from('lot_disposals').select('id').eq('lot_id', lot.id).single<{ id: string }>(),
  )

  const sealedPurchase = mustSingle(
    'seed sealed purchase',
    await clientB
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 1,
            unit_price_minor: 70000,
          },
        ],
      })
      .single<{ id: string }>(),
  )
  const sealedLine = mustSingle(
    'seed sealed line lookup',
    await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', sealedPurchase.id)
      .single<{ id: string }>(),
  )
  const sealedLot = mustSingle(
    'seed sealed lot lookup',
    await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', sealedLine.id)
      .single<{ id: string }>(),
  )
  const opening = mustSingle(
    'seed opening',
    await clientB.rpc('create_opening', { p_source_lot_id: sealedLot.id, p_quantity: 1 }).single<{
      id: string
    }>(),
  )

  const existingValuation = await service
    .from('manual_valuations')
    .select('id')
    .eq('holding_id', holding.id)
    .maybeSingle<{ id: string }>()
  let manualValuationId = existingValuation.data?.id
  if (manualValuationId === undefined) {
    const mv = await clientB.rpc('set_manual_valuation', {
      p_holding_id: holding.id,
      p_value_minor: 99900,
    })
    if (mv.error) throw new Error(`seed manual valuation failed: ${mv.error.message}`)
    manualValuationId = mustSingle(
      'seed manual valuation refetch',
      await service
        .from('manual_valuations')
        .select('id')
        .eq('holding_id', holding.id)
        .single<{ id: string }>(),
    ).id
  }

  const holdingTagResult = await service
    .from('holding_tags')
    .insert({ user_id: userB.id, holding_id: holding.id, tag_id: tag.id })
    .select('holding_id, tag_id')
    .single()
  if (holdingTagResult.error)
    throw new Error(`seed holding_tags failed: ${holdingTagResult.error.message}`)

  const targets: { table: string; id: string; idCol: string }[] = [
    { table: 'tags', id: tag.id, idCol: 'id' },
    { table: 'retailers', id: retailer.id, idCol: 'id' },
    { table: 'storage_locations', id: storageLocation.id, idCol: 'id' },
    { table: 'custom_collections', id: collection.id, idCol: 'id' },
    { table: 'purchases', id: purchase.id, idCol: 'id' },
    { table: 'purchase_lines', id: purchaseLine.id, idCol: 'id' },
    { table: 'acquisition_lots', id: lot.id, idCol: 'id' },
    { table: 'holdings', id: holding.id, idCol: 'id' },
    { table: 'sales', id: sale.id, idCol: 'id' },
    { table: 'sale_lines', id: saleLine.id, idCol: 'id' },
    { table: 'lot_disposals', id: disposal.id, idCol: 'id' },
    { table: 'openings', id: opening.id, idCol: 'id' },
    { table: 'manual_valuations', id: manualValuationId, idCol: 'id' },
    { table: 'acquisition_lots', id: sealedLot.id, idCol: 'id' },
    { table: 'holding_tags', id: holding.id, idCol: 'holding_id' },
  ]

  console.log(
    `Seeded ${targets.length} real B-owned rows across ${new Set(targets.map((t) => t.table)).size} tables.`,
  )

  // ---- Part 1: direct select/update/delete against every real B row, as A and as anon ----
  for (const { table, id, idCol } of targets) {
    for (const client of [clientA, anon]) {
      const who = client === clientA ? 'A' : 'anon'

      const sel = await client.from(table).select('*').eq(idCol, id)
      note(`${who} SELECT ${table}#${id}`, !sel.error && sel.data.length > 0)

      const upd = await client
        .from(table)
        .update({ updated_at: new Date().toISOString() })
        .eq(idCol, id)
        .select()
      note(`${who} UPDATE ${table}#${id}`, !upd.error && upd.data.length > 0)

      const del = await client.from(table).delete().eq(idCol, id).select()
      note(`${who} DELETE ${table}#${id}`, !del.error && del.data.length > 0)
    }
  }

  // ---- Part 2: FK-spoofing inserts — A references B's real parent ids as a child row ----
  const spoofAttempts: {
    label: string
    run: () => PromiseLike<{ error: ErrorLike | null; data: unknown[] | null }>
  }[] = [
    {
      label: 'A inserts holding_tags under B holding + A tag',
      run: async () => {
        const aTag = mustSingle(
          'seed A tag for spoof',
          await service
            .from('tags')
            .insert({ user_id: userA.id, name: 'p120-a-tag' })
            .select('id')
            .single<{
              id: string
            }>(),
        )
        return clientA
          .from('holding_tags')
          .insert({ holding_id: holding.id, tag_id: aTag.id })
          .select()
      },
    },
    {
      label: 'A inserts manual_valuations under B holding',
      run: () =>
        clientA
          .from('manual_valuations')
          .insert({
            user_id: userA.id,
            holding_id: holding.id,
            value_minor: 1,
            value_nok_minor: 1,
          })
          .select(),
    },
    {
      label: 'A inserts purchase_lines under B purchase',
      run: () =>
        clientA
          .from('purchase_lines')
          .insert({
            user_id: userA.id,
            purchase_id: purchase.id,
            line_type: 'card',
            quantity: 1,
            unit_price_minor: 1,
            line_total_minor: 1,
            spend_class: 'collectible',
          })
          .select(),
    },
    {
      label: 'A inserts sale_lines under B sale referencing A own lot (cross-parent spoof)',
      run: () =>
        clientA
          .from('sale_lines')
          .insert({
            user_id: userA.id,
            sale_id: sale.id,
            lot_id: lot.id,
            quantity: 1,
            unit_gross_minor: 1,
            line_gross_minor: 1,
          })
          .select(),
    },
  ]
  for (const { label, run } of spoofAttempts) {
    const { error, data } = await run()
    note(label, !error && data !== null && data.length > 0)
  }

  // ---- Part 3: cross-user RPC calls against B's real resource ids ----
  const rpcAttempts: {
    label: string
    run: () => PromiseLike<{ error: ErrorLike | null; data: unknown }>
  }[] = [
    {
      label: 'A calls set_manual_valuation on B holding',
      run: () =>
        clientA.rpc('set_manual_valuation', { p_holding_id: holding.id, p_value_minor: 1 }),
    },
    {
      label: 'A calls void_opening on B opening',
      run: () => clientA.rpc('void_opening', { p_opening_id: opening.id }),
    },
    {
      label: 'A calls reduce_holding_quantity on B holding',
      run: () =>
        clientA.rpc('reduce_holding_quantity', {
          p_holding_id: holding.id,
          p_lot_reductions: [{ lot_id: lot.id, remove_quantity: 1 }],
        }),
    },
    {
      label: 'A calls create_sale against B lot_id',
      run: () =>
        clientA.rpc('create_sale', {
          p_idempotency_key: crypto.randomUUID(),
          p_sold_on: today,
          p_currency: 'NOK',
          p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 1 }],
        }),
    },
    {
      label: 'A calls create_opening against B sealed lot',
      run: () => clientA.rpc('create_opening', { p_source_lot_id: sealedLot.id, p_quantity: 1 }),
    },
    {
      label: 'A calls get_opening for B opening (read-side info leak check)',
      run: () => clientA.rpc('get_opening', { p_opening_id: opening.id }),
    },
    {
      label: 'A calls reconcile_opening_cost on B opening',
      run: () =>
        clientA.rpc('reconcile_opening_cost', {
          p_opening_id: opening.id,
          p_real_source_lot_id: lot.id,
        }),
    },
    {
      label: 'anon calls set_manual_valuation on B holding',
      run: () => anon.rpc('set_manual_valuation', { p_holding_id: holding.id, p_value_minor: 1 }),
    },
  ]
  const rpcResults: { label: string; error: string | null; leaked: boolean }[] = []
  for (const { label, run } of rpcAttempts) {
    const { error, data } = await run()
    const gotData =
      data !== null && data !== undefined && !(Array.isArray(data) && data.length === 0)
    rpcResults.push({ label, error: error?.message ?? null, leaked: !error && gotData })
    note(label, !error && gotData)
  }

  // ---- Part 4: high-volume blind random-UUID guessing, every table, as A ----
  const allTables = [
    'tags',
    'retailers',
    'storage_locations',
    'custom_collections',
    'purchases',
    'purchase_lines',
    'acquisition_lots',
    'holdings',
    'sales',
    'sale_lines',
    'lot_disposals',
    'openings',
    'manual_valuations',
    'holding_tags',
    'custom_collection_members',
    'lot_cost_adjustments',
  ]
  const GUESSES_PER_TABLE = 150
  for (const table of allTables) {
    for (let i = 0; i < GUESSES_PER_TABLE; i++) {
      const randomId = crypto.randomUUID()
      const { data, error } = await clientA.from(table).select('*').eq('id', randomId)
      note(`A blind-guess SELECT ${table}#${randomId}`, !error && data.length > 0)
    }
  }

  console.log(`\nTotal hostile operations attempted: ${tally.attempts}`)
  console.log(`Leaks/successful cross-user mutations: ${tally.leaks.length}`)
  if (tally.leaks.length > 0) {
    console.log('LEAKED:', tally.leaks)
  }
  console.log('\nRPC results:')
  for (const r of rpcResults) {
    console.log(`  ${r.label}: error=${r.error ?? 'NONE'} leaked=${r.leaked}`)
  }

  await service.auth.admin.deleteUser(userA.id)
  await service.auth.admin.deleteUser(userB.id)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
