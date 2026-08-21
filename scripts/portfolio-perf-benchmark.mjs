#!/usr/bin/env node
/**
 * M7's 10,000-lot performance benchmark (TESTING.md §7/§7a-style measurement, M7 prompt §53-57/
 * §104). Seeds a synthetic user with a large, varied, synthetic collection — duplicates, multiple
 * conditions, raw and graded holdings, tags, storage locations, custom collection membership —
 * then times the real `list_portfolio`/`portfolio_counts` RPCs the Portfolio page calls, across
 * every sort mode and a couple of representative filters. Reports numbers; it does not assert a
 * pass/fail threshold, because a fixed millisecond budget on a shared CI runner is exactly the
 * "microbenchmark theatre" the prompt says not to build. The milestone gate this backs is
 * behavioural — a real browser stays interactive — verified separately (HANDOVER.md/output_11).
 *
 * SAFETY. This inserts real rows — deliberately many of them — so it must run against either an
 * ephemeral/local Supabase stack or a throwaway synthetic account, never the owner's real account
 * (M7 prompt §101/§53). It creates exactly one synthetic user (RFC 2606 `.invalid` address, the
 * same invite→claim→create→finalize route every fixture in this repo uses) and deletes it — which
 * cascades every row this script created — before exiting, success or failure, unless
 * --keep is passed for manual inspection.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/portfolio-perf-benchmark.mjs
 *   [--lots=10000] [--keep]
 *
 * Against the local stack: export from `pnpm exec supabase status -o env` first, same as
 * tests/db/setup.ts. Against a real project: use a throwaway project or accept the seeded rows
 * land on a real synthetic account you will delete immediately after — never the owner's account.
 */

import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'

const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — see this file's header.",
  )
}

const args = new Set(process.argv.slice(2))
const lotArg = [...args].find((a) => a.startsWith('--lots='))
const LOT_COUNT = lotArg ? Number(lotArg.split('=')[1]) : 10_000
const KEEP = args.has('--keep')

const service = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function createSyntheticUser(label) {
  const email = `perf-${label}-${Date.now()}@example.invalid`
  const password = `Perf-${randomUUID()}`
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
    .toString('base64url')
    .replace(/=+$/, '')

  const { data: invitation, error: invError } = await service
    .from('invitations')
    .insert({
      token_hash: sha256Hex(token),
      email,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      max_uses: 1,
    })
    .select('id')
    .single()
  if (invError) throw invError

  const claim = await service.rpc('claim_invitation', { p_token: token }).maybeSingle()
  if (claim.error || !claim.data) throw claim.error ?? new Error('no claim returned')

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) throw createError

  const finalized = await service.rpc('finalize_invitation_redemption', {
    p_claim_id: claim.data.claim_id,
    p_user_id: created.user.id,
  })
  if (finalized.error) throw finalized.error

  return { id: created.user.id, email, password }
}

async function fetchCatalogVariantIds(limit) {
  const { data, error } = await service.from('card_variants').select('id').limit(limit)
  if (error) throw error
  if (data.length === 0) {
    throw new Error(
      'No card_variants found — run the catalog sync (or apply supabase/seed/) before this benchmark.',
    )
  }
  return data.map((r) => r.id)
}

const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO']

async function seed(userId, variantIds) {
  console.log(`Seeding ${LOT_COUNT} lots for ${userId}...`)
  const t0 = performance.now()

  const storageLocations = []
  for (let i = 0; i < 5; i += 1) {
    const { data } = await service
      .from('storage_locations')
      .insert({ user_id: userId, name: `Perf binder ${i}`, kind: 'binder', sort_order: i })
      .select('id')
      .single()
    storageLocations.push(data.id)
  }

  const tags = []
  for (let i = 0; i < 8; i += 1) {
    const { data } = await service
      .from('tags')
      .insert({ user_id: userId, name: `perf-tag-${i}` })
      .select('id')
      .single()
    tags.push(data.id)
  }

  const { data: collection } = await service
    .from('custom_collections')
    .insert({ user_id: userId, name: 'Perf collection' })
    .select('id')
    .single()

  // Realistic duplication: ~30% of lots reuse an existing (variant, condition) holding identity
  // this script already created, producing quantity > 1 on one holding rather than a fresh one
  // every time (D-017's "80 identical energies are one holding" shape). Tracked in memory rather
  // than round-tripped through holdings_identity's own coalesce()-expression unique index, which
  // is not a plain column list and so cannot be an upsert onConflict target (the same limitation
  // add_card_acquisition's find-or-create works around with a caught unique_violation).
  const knownHoldingIds = []
  const BATCH = 200
  let created = 0

  while (created < LOT_COUNT) {
    const batchSize = Math.min(BATCH, LOT_COUNT - created)
    const newHoldingRows = []
    const lotTargets = [] // resolved after new holdings are inserted, in the same order

    for (let i = 0; i < batchSize; i += 1) {
      const reuse = knownHoldingIds.length > 0 && Math.random() < 0.3
      if (reuse) {
        lotTargets.push(knownHoldingIds[Math.floor(Math.random() * knownHoldingIds.length)])
      } else {
        newHoldingRows.push({
          user_id: userId,
          holding_kind: 'raw_card',
          card_variant_id: variantIds[Math.floor(Math.random() * variantIds.length)],
          condition: CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)],
          is_favorite: Math.random() < 0.05,
        })
        lotTargets.push(null) // filled in once the batch insert returns ids, below
      }
    }

    let newIds = []
    if (newHoldingRows.length > 0) {
      const { data: inserted, error: insertError } = await service
        .from('holdings')
        .insert(newHoldingRows)
        .select('id')
      if (insertError) throw insertError
      newIds = inserted.map((r) => r.id)
      knownHoldingIds.push(...newIds)
    }

    let nextNewIndex = 0
    const lotRows = lotTargets.map((existingId) => {
      const holdingId = existingId ?? newIds[nextNewIndex++]
      return {
        holding_id: holdingId,
        user_id: userId,
        origin: 'pre_tracking',
        cost_basis_state: 'unknown',
        acquired_on: new Date(Date.now() - Math.random() * 5e10).toISOString().slice(0, 10),
        quantity: 1,
        quantity_remaining: 1,
        storage_location_id: storageLocations[Math.floor(Math.random() * storageLocations.length)],
      }
    })
    const { error: lotError } = await service.from('acquisition_lots').insert(lotRows)
    if (lotError) throw lotError

    if (newIds.length > 0 && Math.random() < 0.5) {
      const taggedId = newIds[Math.floor(Math.random() * newIds.length)]
      await service.from('holding_tags').insert({
        holding_id: taggedId,
        tag_id: tags[Math.floor(Math.random() * tags.length)],
        user_id: userId,
      })
    }
    if (newIds.length > 0 && Math.random() < 0.3) {
      const memberId = newIds[Math.floor(Math.random() * newIds.length)]
      await service
        .from('custom_collection_members')
        .insert({ collection_id: collection.id, holding_id: memberId, user_id: userId })
    }

    created += batchSize
    if (created % 2000 === 0) console.log(`  ...${created}/${LOT_COUNT}`)
  }

  console.log(`Seed complete in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
}

async function timeRpc(client, name, args) {
  const t0 = performance.now()
  const { data, error, count } = await client.rpc(name, args)
  const ms = performance.now() - t0
  if (error) throw error
  const payloadBytes = Buffer.byteLength(JSON.stringify(data ?? []))
  return { ms, rows: Array.isArray(data) ? data.length : 1, payloadBytes, count }
}

async function main() {
  const user = await createSyntheticUser('portfolio-benchmark')

  // list_portfolio/portfolio_counts are SECURITY INVOKER and read auth.uid() — calling them under
  // the service-role key (which has no signed-in user) would just raise "not authenticated". The
  // benchmark has to impersonate the synthetic user exactly as the app does: a real password
  // sign-in against the publishable/anon key, not the service role.
  const publishableKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY
  if (!publishableKey) {
    throw new Error(
      'SUPABASE_ANON_KEY (local) or SUPABASE_PUBLISHABLE_KEY (remote) must be set too.',
    )
  }
  const userClient = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const variantIds = await fetchCatalogVariantIds(2000)
    await seed(user.id, variantIds)

    const { error: signInError } = await userClient.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    })
    if (signInError) throw signInError

    console.log('\nBenchmark: list_portfolio (limit 30, first page) by sort mode')
    const sorts = [
      'value_desc',
      'name_asc',
      'set_asc',
      'quantity_desc',
      'acquired_newest',
      'added_newest',
    ]
    for (const sort of sorts) {
      const result = await timeRpc(userClient, 'list_portfolio', {
        p_sort: sort,
        p_limit: 30,
      })
      console.log(
        `  ${sort.padEnd(16)} ${result.ms.toFixed(1).padStart(7)} ms  ${String(result.rows).padStart(3)} rows  ${result.payloadBytes.toLocaleString()} bytes`,
      )
    }

    console.log('\nBenchmark: list_portfolio filtered (condition=NM)')
    const filtered = await timeRpc(userClient, 'list_portfolio', {
      p_sort: 'name_asc',
      p_limit: 30,
      p_condition: 'NM',
    })
    console.log(`  ${filtered.ms.toFixed(1)} ms, ${filtered.rows} rows`)

    console.log('\nBenchmark: keyset second page (name_asc)')
    const first = await userClient.rpc('list_portfolio', { p_sort: 'name_asc', p_limit: 30 })
    if (first.error) throw first.error
    const lastRow = first.data.at(-1)
    const second = await timeRpc(userClient, 'list_portfolio', {
      p_sort: 'name_asc',
      p_limit: 30,
      p_cursor_holding_id: lastRow.holding_id,
      p_cursor_name: lastRow.card_name ?? '',
    })
    console.log(`  ${second.ms.toFixed(1)} ms, ${second.rows} rows`)

    console.log('\nBenchmark: portfolio_counts()')
    const counts = await timeRpc(userClient, 'portfolio_counts', {})
    console.log(`  ${counts.ms.toFixed(1)} ms`)

    console.log(`\nSeeded holdings: ~${LOT_COUNT} lots (with ~30% identity reuse).`)
  } finally {
    if (KEEP) {
      console.log(`\n--keep set: leaving synthetic account ${user.email} (${user.id}) in place.`)
    } else {
      console.log(`\nDeleting synthetic account ${user.email}...`)
      await service.auth.admin.deleteUser(user.id)
      console.log('Deleted — cascade removed every row this script created.')
    }
  }
}

await main()
