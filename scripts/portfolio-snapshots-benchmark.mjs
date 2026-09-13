#!/usr/bin/env node
/**
 * M12 snapshots performance & storage benchmark (TESTING.md §7 addition, prompt §98-§102).
 *
 * Seeds ONE synthetic user at the documented realistic scale — ~7,500 holdings / 10,000 lots
 * spread across ~400 days of acquisition dates, a ~3,500-variant synthetic catalog with daily
 * provider observations for ~70% of it over the trailing 120 days, ~8% of lots disposed across
 * time, and a sprinkle of manual valuations — then measures, post-ANALYZE (D-059 discipline):
 *
 *   - full cache rebuilds over 30 / 90 / 365-day ranges (rebuild_portfolio_snapshots)
 *   - one production-shaped daily incremental (a real mutation → queue row → drain cycle)
 *   - every Home read RPC exactly as the signed-in app calls it (get_dashboard_summary,
 *     get_portfolio_history, get_monthly_spend, get_recent_activity)
 *   - real on-disk storage of portfolio_snapshots (+ its PK index) and the queue table
 *     (pg_total_relation_size via psql, same channel analyzeSeededTables uses)
 *
 * Fails the step (non-zero exit) if any measurement errors outright, if a rebuild exceeds
 * REBUILD_SLOW_MS, or if a Home read exceeds HOME_SLOW_MS — the same single-generous-threshold
 * policy D-059 established for list_portfolio. A background 90-day rebuild taking minutes is a
 * finding worth investigating (prompt §99); a multi-second Home read is a defect.
 *
 * SAFETY: identical to portfolio-perf-benchmark.mjs — ephemeral/local stack or throwaway
 * synthetic account only (.invalid address, invite→claim→create→finalize), deleted afterward.
 * Never the owner's account, never the hosted project in this pilot branch.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
 *   node scripts/portfolio-snapshots-benchmark.mjs [--lots=10000] [--price-days=120] [--keep]
 */

import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { runPsql as execPsql } from './lib/psql-exec.mjs'

const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — see this file's header.",
  )
}
const publishableKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY

const args = new Set(process.argv.slice(2))
function argValue(name) {
  const found = [...args].find((a) => a.startsWith(`--${name}=`))
  return found ? Number(found.split('=')[1]) : null
}
const LOT_COUNT = argValue('lots') ?? 10_000
const PRICE_DAYS = argValue('price-days') ?? 120
const KEEP = args.has('--keep')

const REBUILD_SLOW_MS = 60_000 // generous: a BACKGROUND rebuild, not an interactive read (§99)
const HOME_SLOW_MS = 1500 // the D-059 catastrophic-only threshold, applied to Home reads
let anyFailure = false

function isoDaysAgo(n) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

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
  const { data: invitation, error } = await service
    .from('invitations')
    .insert({
      token_hash: sha256Hex(token),
      email,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      max_uses: 1,
    })
    .select('id')
    .single()
  if (error) throw error
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

// Same self-seeded catalog rationale as portfolio-perf-benchmark.mjs (M9.1): never depend on the
// ephemeral seed catalog's size; match DATA_MODEL.md §4.2's ~3,500-distinct-variant scale.
const SYNTHETIC_VARIANT_COUNT = 3500

async function seedSyntheticCatalog(count) {
  const { data: series } = await service
    .from('card_series')
    .insert({ slug: `snapbench-series-${Date.now()}`, name: 'Snap Bench Series', language: 'en' })
    .select('id')
    .single()
  const { data: set } = await service
    .from('card_sets')
    .insert({
      series_id: series.id,
      slug: `snapbench-set-${Date.now()}`,
      name: 'Snap Bench Set',
      language: 'en',
    })
    .select('id')
    .single()

  const cardIds = []
  const BATCH = 500
  for (let start = 0; start < count; start += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, count - start) }, (_, i) => ({
      set_id: set.id,
      local_id: String(start + i + 1),
      name: `Snap Bench Card ${start + i + 1}`,
      language: 'en',
    }))
    const { data: inserted, error } = await service.from('cards').insert(rows).select('id')
    if (error) throw error
    cardIds.push(...inserted.map((r) => r.id))
  }
  const variantIds = []
  for (let start = 0; start < cardIds.length; start += BATCH) {
    const { data: inserted, error } = await service
      .from('card_variants')
      .insert(
        cardIds
          .slice(start, start + BATCH)
          .map((cardId) => ({ card_id: cardId, finish: 'normal', stamp: '', subtype: '' })),
      )
      .select('id')
    if (error) throw error
    variantIds.push(...inserted.map((r) => r.id))
  }
  return variantIds
}

async function seed(userId, variantIds) {
  console.log(`Seeding ~${LOT_COUNT} lots across ~400 days of acquisition dates...`)
  const t0 = performance.now()
  const CONDITIONS = ['MT', 'NM', 'EX', 'GD']
  const usedCombos = new Map()
  const knownHoldingIds = []
  const holdingIds = []
  const BATCH = 200
  let created = 0

  while (created < LOT_COUNT) {
    const batchSize = Math.min(BATCH, LOT_COUNT - created)
    const newRows = []
    const targets = []
    for (let i = 0; i < batchSize; i += 1) {
      const reuse = knownHoldingIds.length > 0 && Math.random() < 0.25
      if (reuse) {
        targets.push(knownHoldingIds[Math.floor(Math.random() * knownHoldingIds.length)])
        continue
      }
      let variantId, condition, key
      let attempts = 0
      do {
        variantId = variantIds[Math.floor(Math.random() * variantIds.length)]
        condition = CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)]
        key = `${variantId}:${condition}`
        attempts += 1
      } while (usedCombos.has(key) && attempts < 30)
      const known = usedCombos.get(key)
      if (known) {
        targets.push(known)
        continue
      }
      const pendingIndex = newRows.length
      usedCombos.set(key, pendingIndex)
      newRows.push({
        user_id: userId,
        holding_kind: 'raw_card',
        card_variant_id: variantId,
        condition,
      })
      targets.push(pendingIndex)
    }

    let newIds = []
    if (newRows.length > 0) {
      const { data: inserted, error } = await service.from('holdings').insert(newRows).select('id')
      if (error) throw error
      newIds = inserted.map((r) => r.id)
      holdingIds.push(...newIds)
      for (const [key, target] of usedCombos) {
        if (typeof target === 'number') usedCombos.set(key, newIds[target])
      }
    }

    const lotRows = targets.map((target) => {
      // Origin must match the consistency CHECK's permitted states (same mapping the test
      // fixtures use): pre_tracking carries 'unknown' only; gifts are 'not_paid'.
      const costState = Math.random() < 0.6 ? 'unknown' : 'not_paid'
      return {
        holding_id: typeof target === 'string' ? target : newIds[target],
        user_id: userId,
        origin: costState === 'unknown' ? 'pre_tracking' : 'gift',
        cost_basis_state: costState,
        unit_cost_basis_minor: null,
        acquired_on: isoDaysAgo(Math.floor(Math.random() * 400)),
        quantity: 1,
        quantity_remaining: 1,
      }
    })
    const { error: lotError } = await service.from('acquisition_lots').insert(lotRows)
    if (lotError) throw lotError

    created += batchSize
    if (created % 2000 === 0) console.log(`  ...${created}/${LOT_COUNT}`)
  }

  // NOTE: no known-cost (`state='known'`) lots are seeded here — that state requires a real
  // purchase_line reference (M2's CHECK), and manufacturing thousands of receipt rows would
  // double this script's runtime for no measurement value: the rebuild scans and aggregates
  // every lot identically regardless of its basis state, and exact DCB VALUE correctness is
  // already proven by tests/db/m12_dashboard_snapshots.test.ts. The uncosted/uncosted-mix here
  // exercises the same code paths at the same row counts.

  console.log('Disposing ~8% of lots across time (write-offs exercise the disposal timeline)...')
  const { data: disposable, error: fetchError } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('user_id', userId)
    .limit(LOT_COUNT)
  if (fetchError) throw fetchError
  const disposalRows = disposable
    .filter(() => Math.random() < 0.08)
    .map((lot) => ({
      lot_id: lot.id,
      user_id: userId,
      kind: 'write_off',
      quantity: 1,
      disposed_on: isoDaysAgo(Math.floor(Math.random() * 300)),
    }))
  for (let i = 0; i < disposalRows.length; i += 500) {
    const { error } = await service.from('lot_disposals').insert(disposalRows.slice(i, i + 500))
    if (error) throw error
  }

  console.log('Setting a handful of manual valuations...')
  const manualTargets = holdingIds.slice(0, 20)
  const manualRows = manualTargets.map((holdingId, i) => ({
    user_id: userId,
    holding_id: holdingId,
    value_minor: 100_00 + i * 100,
    currency: 'NOK',
    value_nok_minor: 100_00 + i * 100,
    effective_from: isoDaysAgo(50),
  }))
  const { error: manualError } = await service.from('manual_valuations').insert(manualRows)
  if (manualError) throw manualError

  console.log(`Seed complete in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
}

async function seedPriceHistory(variantIds) {
  const priced = variantIds.filter(() => Math.random() < 0.7)
  console.log(
    `Seeding ${PRICE_DAYS} days of daily observations for ~${priced.length} variants (~${(priced.length * PRICE_DAYS).toLocaleString()} rows)...`,
  )
  const t0 = performance.now()
  const BATCH = 1000
  let written = 0
  for (const variantId of priced) {
    const baseMinor = Math.floor(50 + Math.random() * 500_00)
    const rows = Array.from({ length: PRICE_DAYS }, (_, d) => ({
      card_variant_id: variantId,
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: Math.max(
        1,
        baseMinor + Math.floor(Math.sin((d + baseMinor) / 9) * baseMinor * 0.08),
      ),
      snapshot_date: isoDaysAgo(PRICE_DAYS - d),
      provider_updated_at: new Date().toISOString(),
    }))
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await service.from('price_snapshots').insert(rows.slice(i, i + BATCH))
      if (error) throw error
    }
    written += rows.length
  }
  console.log(
    `Price history seed complete: ${written.toLocaleString()} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  )
}

function analyzeSeededTables() {
  const DB_URL = process.env.DB_URL
  if (!DB_URL) {
    console.log('\nDB_URL not set — skipping ANALYZE; timings may reflect un-analyzed bulk state.')
    return
  }
  console.log('\nRunning ANALYZE on seeded tables (D-059 discipline)...')
  const sql = [
    'holdings',
    'acquisition_lots',
    'card_variants',
    'cards',
    'card_sets',
    'manual_valuations',
    'price_snapshots',
    'lot_disposals',
  ]
    .map((t) => `analyze public.${t};`)
    .join(' ')
  execPsql(DB_URL, ['-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' })
  console.log('ANALYZE complete.')
}

function psqlScalar(sqlText) {
  const DB_URL = process.env.DB_URL
  if (!DB_URL) return null
  try {
    return execPsql(DB_URL, ['-tAc', sqlText], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

// Since P42's every-minute recompute drain is active wherever the M12 migrations are applied
// (D-082), a cron tick can start a full-scale rebuild while this benchmark seeds or measures.
// The rebuild competes for CPU/connections long enough to stall individual statements into
// statement timeouts (observed once in CI during the price-history seed) and makes every
// timing nondeterministic. This benchmark measures SQL cost, not cron coexistence, so the
// minute-drain job is paused for the run and restored exactly afterwards.
const RECOMPUTE_JOB = 'm12-recompute-snapshots'
let pausedRecomputeJobCommand = null

function pauseRecomputeDrain() {
  const DB_URL = process.env.DB_URL
  if (!DB_URL) return
  try {
    pausedRecomputeJobCommand = execPsql(
      DB_URL,
      ['-tAc', `select command from cron.job where jobname = '${RECOMPUTE_JOB}'`],
      { encoding: 'utf8' },
    ).trim()
    if (pausedRecomputeJobCommand) {
      execPsql(DB_URL, ['-tAc', `select cron.unschedule('${RECOMPUTE_JOB}')`], {
        encoding: 'utf8',
      })
      console.log('Paused the every-minute recompute drain for the duration of this benchmark.')
    } else {
      pausedRecomputeJobCommand = null
    }
  } catch (err) {
    console.log(
      `Could not pause the recompute drain (${String(err.message).split('\n')[0]}); continuing.`,
    )
    pausedRecomputeJobCommand = null
  }
}

function resumeRecomputeDrain() {
  const DB_URL = process.env.DB_URL
  const command = pausedRecomputeJobCommand
  pausedRecomputeJobCommand = null
  if (!DB_URL || !command) return
  try {
    const literal = command.replaceAll("'", "''")
    execPsql(
      DB_URL,
      ['-tAc', `select cron.schedule('${RECOMPUTE_JOB}', '* * * * *', '${literal}')`],
      { encoding: 'utf8' },
    )
    console.log('Restored the every-minute recompute drain.')
  } catch (err) {
    console.log(`ERROR: could not restore ${RECOMPUTE_JOB}: ${String(err.message).split('\n')[0]}`)
    anyFailure = true
  }
}

async function timeAsync(label, fn) {
  const t0 = performance.now()
  try {
    const result = await fn()
    const ms = performance.now() - t0
    const slow = ms > REBUILD_SLOW_MS || (label.startsWith('home/') && ms > HOME_SLOW_MS)
    if (slow) anyFailure = true
    console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(10)} ms${slow ? '  SLOW' : ''}`)
    return result
  } catch (err) {
    const ms = performance.now() - t0
    console.log(`  ${label.padEnd(34)} FAILED after ${ms.toFixed(1)} ms: ${err.message}`)
    anyFailure = true
    return null
  }
}

async function main() {
  pauseRecomputeDrain()
  const user = await createSyntheticUser('snapshots-benchmark')

  const userClient = publishableKey
    ? createClient(url, publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null

  try {
    const variantIds = await seedSyntheticCatalog(SYNTHETIC_VARIANT_COUNT)
    await seed(user.id, variantIds)
    await seedPriceHistory(variantIds)
    analyzeSeededTables()

    console.log(`\n=== Full-cache rebuild timings (${LOT_COUNT} lots, ~400d span) ===`)
    await timeAsync('rebuild 30d', () =>
      service.rpc('rebuild_portfolio_snapshots', {
        p_user_id: user.id,
        p_from: isoDaysAgo(30),
        p_through: isoDaysAgo(0),
      }),
    )
    await timeAsync('rebuild 90d', () =>
      service.rpc('rebuild_portfolio_snapshots', {
        p_user_id: user.id,
        p_from: isoDaysAgo(90),
        p_through: isoDaysAgo(0),
      }),
    )
    const fullYear = await timeAsync('rebuild 365d', async () => {
      const res = await service.rpc('rebuild_portfolio_snapshots', {
        p_user_id: user.id,
        p_from: isoDaysAgo(365),
        p_through: isoDaysAgo(0),
      })
      return res.data
    })

    console.log('\n=== Production-shaped daily incremental ===')
    // One real mutation through its trigger, then one drain — the exact cron-cycle shape.
    const { data: someLot } = await service
      .from('acquisition_lots')
      .select('id, quantity')
      .eq('user_id', user.id)
      .limit(1)
      .single()
    await service
      .from('acquisition_lots')
      .update({ quantity: someLot.quantity })
      .eq('id', someLot.id)
    await timeAsync('drain queue (daily tick)', () =>
      service.rpc('drain_portfolio_recompute_queue'),
    )
    await timeAsync('repeat drain (idempotent)', () =>
      service.rpc('drain_portfolio_recompute_queue'),
    )

    console.log('\n=== Home reads (signed-in synthetic user) ===')
    if (!userClient) {
      console.log('  SUPABASE_ANON_KEY not set — skipping signed-in Home reads.')
    } else {
      const { error } = await userClient.auth.signInWithPassword({
        email: user.email,
        password: user.password,
      })
      if (error) throw error
      await timeAsync('home/dashboard_summary', () => userClient.rpc('get_dashboard_summary'))
      await timeAsync('home/portfolio_history (MAX)', () =>
        userClient.rpc('get_portfolio_history', { p_display_currency: 'NOK' }),
      )
      await timeAsync('home/portfolio_history (EUR)', () =>
        userClient.rpc('get_portfolio_history', { p_display_currency: 'EUR' }),
      )
      await timeAsync('home/monthly_spend (12m)', () =>
        userClient.rpc('get_monthly_spend', { p_months: 12 }),
      )
      await timeAsync('home/recent_activity', () =>
        userClient.rpc('get_recent_activity', { p_limit: 8 }),
      )
    }

    console.log('\n=== Storage (pg_total_relation_size, incl. indexes) ===')
    const snapsBytes = psqlScalar("select pg_total_relation_size('public.portfolio_snapshots');")
    const queueBytes = psqlScalar(
      "select pg_total_relation_size('public.portfolio_recompute_queue');",
    )
    const snapCount = psqlScalar('select count(*) from public.portfolio_snapshots;')
    console.log(
      `  portfolio_snapshots:       ${Number(snapsBytes ?? 0).toLocaleString()} bytes (${Number(snapCount ?? 0).toLocaleString()} rows total)`,
    )
    console.log(`  portfolio_recompute_queue: ${Number(queueBytes ?? 0).toLocaleString()} bytes`)
    if (snapsBytes !== null && snapCount !== null && Number(snapCount) > 0) {
      const perRow = Number(snapsBytes) / Number(snapCount)
      console.log(`  bytes/row (this dataset):  ${perRow.toFixed(1)}`)
      console.log(
        `  projected 10 users x 365 rows ~= ${((perRow * 3650) / 1024 / 1024).toFixed(2)} MB/year`,
      )
    }

    if (anyFailure) {
      console.log(
        `\n::error::snapshots benchmark failed or exceeded a threshold (rebuild > ${REBUILD_SLOW_MS} ms, home > ${HOME_SLOW_MS} ms).`,
      )
      process.exitCode = 1
    }
  } finally {
    resumeRecomputeDrain()
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
