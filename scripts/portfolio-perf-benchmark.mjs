#!/usr/bin/env node
/**
 * M7's 10,000-lot performance benchmark (TESTING.md §7/§7a-style measurement, M7 prompt §53-57/
 * §104). Seeds a synthetic user with a large, varied, synthetic collection — duplicates, multiple
 * conditions, raw and graded holdings, tags, storage locations, custom collection membership —
 * then times the real `list_portfolio`/`portfolio_counts` RPCs the Portfolio page calls, across
 * every sort mode and a couple of representative filters. Reports numbers, and (M9.2, DECISIONS.md
 * D-059) fails the step if any call exceeds one generous catastrophic threshold (1.5s) or errors
 * outright — not a tight millisecond budget (still not "microbenchmark theatre"), but this defect
 * class has now recurred three times without CI ever failing on its own benchmark, and an explicit
 * ANALYZE before timing (below) removed the measurement noise that justified never gating on this.
 * The milestone gate this backs is also behavioural — a real browser stays interactive — verified
 * separately (HANDOVER.md/output_11).
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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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

// M9.2 investigation tool (docs/TESTING.md §7, DECISIONS.md D-059): scripts/portfolio-perf-explain.sql
// captures real EXPLAIN (ANALYZE, BUFFERS, SETTINGS) evidence, run twice — pre- and post-ANALYZE —
// via psql when a direct Postgres connection string is available (CI's db-tests job exports DB_URL
// after `supabase status`). This is what found the real M9.2 root cause: right after this script's
// own bulk seed, every seeded table's pg_class.reltuples is -1 ("never analyzed" — a fresh CI
// Postgres instance has no autovacuum worker cycle in that short a window), so the planner falls
// back to its no-statistics defaults for holdings/acquisition_lots/card_variants/cards/card_sets/
// price_snapshots alike — and BOTH list_portfolio and portfolio_counts() were equally catastrophic
// (7.4-7.9s) before ANALYZE, not just list_portfolio. Not run by default (it adds ~40s per CI run
// for evidence this investigation has already banked) — pass --explain to re-run it, e.g. to
// re-verify after a future migration changes one of these tables' shape.
const RUN_EXPLAIN = args.has('--explain')
const DB_URL = process.env.DB_URL
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const EXPLAIN_SQL_PATH = path.join(SCRIPT_DIR, 'portfolio-perf-explain.sql')

// Tables list_portfolio's plan actually depends on the row counts of (holdings/acquisition_lots via
// lot_agg; card_variants/cards/card_sets via the catalog joins; manual_valuations via the mv join;
// price_snapshots via resolve_variant_market_values). profiles/fx_rates are not bulk-inserted by
// this benchmark and stay tiny, so ANALYZE-ing them would not change anything measured here —
// deliberately not included (TESTING.md §27's "do not randomly ANALYZE/index everywhere" applies
// equally to this diagnostic step).
const ANALYZE_TABLES = [
  'holdings',
  'acquisition_lots',
  'card_variants',
  'cards',
  'card_sets',
  'manual_valuations',
  'price_snapshots',
]

function runPsql(argsList) {
  return execFileSync('psql', argsList, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

// Since P42's every-minute recompute drain is active wherever the M12 migrations are applied
// (D-082), a cron tick can start a full-scale rebuild of this script's own seeded user while
// it measures, contending for CPU/connections and making timings nondeterministic. This
// benchmark measures SQL cost, not cron coexistence, so the minute-drain job is paused for
// the run and restored exactly afterwards.
const RECOMPUTE_JOB = 'm12-recompute-snapshots'
let pausedRecomputeJobCommand = null

function pauseRecomputeDrain() {
  if (!DB_URL) return
  try {
    pausedRecomputeJobCommand = runPsql([
      DB_URL,
      '-tAc',
      `select command from cron.job where jobname = '${RECOMPUTE_JOB}'`,
    ]).trim()
    if (pausedRecomputeJobCommand) {
      runPsql([DB_URL, '-tAc', `select cron.unschedule('${RECOMPUTE_JOB}')`])
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
  const command = pausedRecomputeJobCommand
  pausedRecomputeJobCommand = null
  if (!DB_URL || !command) return
  try {
    const literal = command.replaceAll("'", "''")
    runPsql([DB_URL, '-tAc', `select cron.schedule('${RECOMPUTE_JOB}', '* * * * *', '${literal}')`])
    console.log('Restored the every-minute recompute drain.')
  } catch (err) {
    console.log(`ERROR: could not restore ${RECOMPUTE_JOB}: ${String(err.message).split('\n')[0]}`)
    anyFailure = true
  }
}

function runExplainPhase(phase, userId) {
  if (!DB_URL || !RUN_EXPLAIN) return
  try {
    console.log(`\n=== EXPLAIN capture: ${phase} ===`)
    const output = runPsql([
      DB_URL,
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `user_id=${userId}`,
      '-v',
      `phase=${phase}`,
      '-f',
      EXPLAIN_SQL_PATH,
    ])
    console.log(output)
  } catch (err) {
    console.log(`  EXPLAIN capture (${phase}) failed, continuing without it: ${err.message}`)
  }
}

function analyzeSeededTables() {
  if (!DB_URL) {
    console.log(
      '\nDB_URL not set — skipping ANALYZE of seeded tables. Timed results below reflect ' +
        'whatever planner statistics happen to exist (may understate real-world performance, ' +
        'which normally benefits from autovacuum/autoanalyze running over time — see TESTING.md §7).',
    )
    return
  }
  console.log(`\nRunning ANALYZE on: ${ANALYZE_TABLES.join(', ')}...`)
  const t0 = performance.now()
  const sql = ANALYZE_TABLES.map((t) => `analyze public.${t};`).join(' ')
  runPsql([DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql])
  console.log(`ANALYZE complete in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
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

// M9.1: seeds its own synthetic catalog rather than depending on whatever card_variants happen to
// already exist (CI's ephemeral seed catalog turned out to hold only a handful — nowhere near
// enough combo space for 10,000 holdings across 5 conditions without exhausting real identity
// slots almost immediately, which surfaced as unique_violation errors on holdings_identity, not
// as a slow-but-correct result). COST_POLICY.md/DATA_MODEL.md §4.2's own real-scale estimate is
// ~3,000-4,000 distinct variants for a 10,000-card collection — this matches that, rather than an
// arbitrary round number, so the benchmark's duplication shape is representative, not an
// artificial worst case.
const SYNTHETIC_VARIANT_COUNT = 3500

async function seedSyntheticCatalog(count) {
  const { data: series, error: seriesError } = await service
    .from('card_series')
    .insert({
      slug: `perf-bench-series-${Date.now()}`,
      name: 'Perf Benchmark Series',
      language: 'en',
    })
    .select('id')
    .single()
  if (seriesError) throw seriesError

  const { data: set, error: setError } = await service
    .from('card_sets')
    .insert({
      series_id: series.id,
      slug: `perf-bench-set-${Date.now()}`,
      name: 'Perf Benchmark Set',
      language: 'en',
    })
    .select('id')
    .single()
  if (setError) throw setError

  const cardIds = []
  const CARD_BATCH = 500
  for (let start = 0; start < count; start += CARD_BATCH) {
    const batch = Array.from({ length: Math.min(CARD_BATCH, count - start) }, (_, i) => ({
      set_id: set.id,
      local_id: String(start + i + 1),
      name: `Perf Bench Card ${String(start + i + 1)}`,
      language: 'en',
    }))
    const { data: inserted, error } = await service.from('cards').insert(batch).select('id')
    if (error) throw error
    cardIds.push(...inserted.map((r) => r.id))
  }

  const variantIds = []
  for (let start = 0; start < cardIds.length; start += CARD_BATCH) {
    const batch = cardIds
      .slice(start, start + CARD_BATCH)
      .map((cardId) => ({ card_id: cardId, finish: 'normal', stamp: '', subtype: '' }))
    const { data: inserted, error } = await service.from('card_variants').insert(batch).select('id')
    if (error) throw error
    variantIds.push(...inserted.map((r) => r.id))
  }
  return variantIds
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
  //
  // usedCombos guards the OTHER direction: two "new" rows independently picking the same random
  // (variant, condition) is a real, not hypothetical, collision once LOT_COUNT approaches the
  // catalog's combo space (variantIds.length x CONDITIONS.length) — the whole bulk INSERT rejects
  // on any one row's unique_violation. Every combo this run has ever picked is tracked exactly
  // once (never just "seen recently"), mapped to the holding that owns it — already-committed
  // (`known`) or still awaiting this batch's own insert (`pending`, resolved below) — so a
  // colliding pick is routed to its real owner instead of attempted as a second, duplicate
  // holdings row, regardless of how small the combo space is relative to a single batch (M9.1 fix
  // — found via CI against an ephemeral seed catalog with only a handful of card_variants).
  const knownHoldingIds = []
  const usedCombos = new Map() // comboKey -> { kind: 'known', id } | { kind: 'pending', index }
  const BATCH = 200
  let created = 0

  while (created < LOT_COUNT) {
    const batchSize = Math.min(BATCH, LOT_COUNT - created)
    const newHoldingRows = []
    const lotTargets = [] // { kind: 'known', id } | { kind: 'pending', index }

    for (let i = 0; i < batchSize; i += 1) {
      const wantsReuse = knownHoldingIds.length > 0 && Math.random() < 0.3
      if (wantsReuse) {
        const id = knownHoldingIds[Math.floor(Math.random() * knownHoldingIds.length)]
        lotTargets.push({ kind: 'known', id })
        continue
      }

      let variantId, condition, comboKey
      let attempts = 0
      do {
        variantId = variantIds[Math.floor(Math.random() * variantIds.length)]
        condition = CONDITIONS[Math.floor(Math.random() * CONDITIONS.length)]
        comboKey = `${variantId}:${condition}`
        attempts += 1
      } while (usedCombos.has(comboKey) && attempts < 30)

      const existingTarget = usedCombos.get(comboKey)
      if (existingTarget) {
        lotTargets.push(existingTarget)
        continue
      }
      const target = { kind: 'pending', index: newHoldingRows.length }
      usedCombos.set(comboKey, target)
      newHoldingRows.push({
        user_id: userId,
        holding_kind: 'raw_card',
        card_variant_id: variantId,
        condition,
        is_favorite: Math.random() < 0.05,
      })
      lotTargets.push(target)
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
      // Promote this batch's now-committed combos so a later batch reuses by id directly.
      for (const [key, target] of usedCombos) {
        if (target.kind === 'pending')
          usedCombos.set(key, { kind: 'known', id: newIds[target.index] })
      }
    }

    const lotRows = lotTargets.map((target) => {
      const holdingId = target.kind === 'known' ? target.id : newIds[target.index]
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
  return { collectionId: collection.id }
}

// M9.1 addition (prompt §85): M7's original benchmark predates the resolver entirely, so every
// holding resolved to `missing` — realistic for M7's plain-column value, but not for M9's
// resolver-backed value_desc/low-value/missing-value paths, which need a genuine mix of priced and
// unpriced variants to measure the shape they actually run in production. ~70% of the variant pool
// gets one fresh Cardmarket snapshot; the rest stay unpriced on purpose.
async function seedPricing(variantIds) {
  console.log(`Seeding price_snapshots for ~${Math.round(variantIds.length * 0.7)} variants...`)
  const today = new Date().toISOString().slice(0, 10)
  const rows = variantIds
    .filter(() => Math.random() < 0.7)
    .map((id) => ({
      card_variant_id: id,
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: Math.floor(50 + Math.random() * 500_00),
      snapshot_date: today,
      provider_updated_at: new Date().toISOString(),
    }))
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await service
      .from('price_snapshots')
      .upsert(rows.slice(i, i + 500), { onConflict: 'card_variant_id,provider,snapshot_date' })
    if (error) throw error
  }
}

// M9.1: never throws. A real Postgres statement timeout on one query is itself a number worth
// reporting, not a reason to crash the whole run and hide every other measurement — callers below
// decide what a failure means (M9.2: it now fails the step, see SLOW_MS below), this function just
// reports. A caller that needs the actual rows (for a cursor) still gets `data: null` on failure and
// must handle that explicitly.
async function timeRpc(client, name, args) {
  const t0 = performance.now()
  const { data, error, count } = await client.rpc(name, args)
  const ms = performance.now() - t0
  if (error) return { ms, rows: 0, payloadBytes: 0, count: null, data: null, error: error.message }
  const payloadBytes = Buffer.byteLength(JSON.stringify(data ?? []))
  return {
    ms,
    rows: Array.isArray(data) ? data.length : 1,
    payloadBytes,
    count,
    data,
    error: null,
  }
}

// M9.2 (TESTING.md §7/§41, DECISIONS.md D-059): this defect class has now recurred three times
// (M7's LATERAL regression, M9.1's statement timeout, both traced to real causes only after a
// dedicated investigation) without CI ever failing on its own benchmark — TESTING.md §7's original
// "never assert a threshold" reasoning was about a *tight* millisecond budget being unfair on a
// shared runner, not about ignoring an outright multi-second regression or timeout forever. Now that
// the benchmark seeds representative planner statistics before timing anything (analyzeSeededTables,
// above — this is what made the M9.1 "one call 7.5s, another 64.7ms" ambiguity disappear), a result
// past SLOW_MS is real, not noise, and the whole point of catching this earlier is a red CI job, not
// a log line nobody reads. Every result below (repeated-sort rows and every single-shot call) is
// checked against this one generous, catastrophic-only threshold; process.exitCode is set to 1 if
// anything trips it, failing the `db-tests` job.
const SLOW_MS = 1500
let anyFailure = false

function report(label, result) {
  if (result.error) {
    console.log(`  ${label.padEnd(16)} FAILED after ${result.ms.toFixed(1)} ms: ${result.error}`)
    anyFailure = true
  } else {
    const flag = result.ms > SLOW_MS ? '  SLOW' : ''
    console.log(
      `  ${label.padEnd(16)} ${result.ms.toFixed(1).padStart(7)} ms  ${String(result.rows).padStart(3)} rows  ${result.payloadBytes.toLocaleString()} bytes${flag}`,
    )
    if (result.ms > SLOW_MS) anyFailure = true
  }
}

// A single timed call cannot distinguish "this sort is slow" from "this was the unlucky first call
// before a plan/cache warmed up" (docs/PROJECT_JOURNAL.md, the same ambiguity the M9.1 investigation
// left open). Every supported sort reports first/median/max over several repeated calls, feeding a
// summary table so a reviewer sees the whole picture at a glance instead of scrolling logs. A real
// Postgres statement timeout (57014) is reported as a row, never treated as a crash — this script's
// own stated design (see timeRpc's comment) — and is exactly the kind of result this table exists to
// make impossible to miss.
const REPEATS_PER_SORT = 3

const summaryRows = []

async function timeSortRepeated(client, sort, extraArgs = {}) {
  const timings = []
  let sawError = null
  let sampleRowCount = 0
  for (let i = 0; i < REPEATS_PER_SORT; i += 1) {
    const result = await timeRpc(client, 'list_portfolio', {
      p_sort: sort,
      p_limit: 30,
      ...extraArgs,
    })
    if (result.error) {
      sawError = result.error
      timings.push(result.ms)
    } else {
      timings.push(result.ms)
      sampleRowCount = result.rows
    }
  }
  timings.sort((a, b) => a - b)
  const first = timings[0]
  const max = timings[timings.length - 1]
  const median = timings[Math.floor(timings.length / 2)]
  const status = sawError ? `FAILED: ${sawError}` : max > SLOW_MS ? 'SLOW' : 'ok'
  if (sawError || max > SLOW_MS) anyFailure = true
  summaryRows.push({ sort, first, median, max, rows: sampleRowCount, status })
  console.log(
    `  ${sort.padEnd(16)} first ${first.toFixed(1).padStart(7)} ms  median ${median.toFixed(1).padStart(7)} ms  max ${max.toFixed(1).padStart(7)} ms  ${status}`,
  )
}

function printSummaryTable() {
  console.log('\n=== Summary: sort | first | median | max | status (ms, p_limit=30) ===')
  const header = `${'sort'.padEnd(18)} ${'first'.padStart(9)} ${'median'.padStart(9)} ${'max'.padStart(9)}  status`
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const row of summaryRows) {
    console.log(
      `${row.sort.padEnd(18)} ${row.first.toFixed(1).padStart(9)} ${row.median.toFixed(1).padStart(9)} ${row.max.toFixed(1).padStart(9)}  ${row.status}`,
    )
  }
  const slow = summaryRows.filter((r) => r.status !== 'ok')
  if (slow.length > 0) {
    console.log(
      `\n::error::${slow.length} Portfolio benchmark row(s) exceeded ${SLOW_MS} ms or failed outright: ` +
        slow.map((r) => r.sort).join(', '),
    )
  } else {
    console.log(`\nAll ${summaryRows.length} sorts stayed under ${SLOW_MS} ms on every run.`)
  }
}

async function main() {
  pauseRecomputeDrain()
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
    const variantIds = await seedSyntheticCatalog(SYNTHETIC_VARIANT_COUNT)
    await seedPricing(variantIds)
    const { collectionId } = await seed(user.id, variantIds)

    // M9.2 investigation: capture the plan a real bulk-seed-then-query moment produces (before
    // autovacuum/autoanalyze — or this script — has ever run ANALYZE on the freshly-inserted rows),
    // then ANALYZE and capture again. See scripts/portfolio-perf-explain.sql's header.
    runExplainPhase('cold-pre-analyze', user.id)
    analyzeSeededTables()
    runExplainPhase('post-analyze', user.id)

    const { error: signInError } = await userClient.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    })
    if (signInError) throw signInError

    console.log(
      `\nBenchmark: list_portfolio (limit 30, first page) by sort mode — ${REPEATS_PER_SORT} runs each, post-ANALYZE`,
    )
    // Full public.portfolio_sort_order enum (TESTING.md §32) — every sort the UI actually offers.
    const sorts = [
      'value_desc',
      'value_asc',
      'name_asc',
      'name_desc',
      'set_asc',
      'quantity_desc',
      'acquired_newest',
      'acquired_oldest',
      'added_newest',
      'added_oldest',
      'number_asc',
      'number_desc',
    ]
    for (const sort of sorts) {
      await timeSortRepeated(userClient, sort)
    }
    printSummaryTable()

    console.log('\nBenchmark: list_portfolio filtered (condition=NM)')
    report(
      'filtered',
      await timeRpc(userClient, 'list_portfolio', {
        p_sort: 'name_asc',
        p_limit: 30,
        p_condition: 'NM',
      }),
    )

    console.log('\nBenchmark: keyset second page (name_asc)')
    const first = await timeRpc(userClient, 'list_portfolio', { p_sort: 'name_asc', p_limit: 30 })
    const lastRow = first.data?.at(-1)
    if (lastRow) {
      report(
        'next page',
        await timeRpc(userClient, 'list_portfolio', {
          p_sort: 'name_asc',
          p_limit: 30,
          p_cursor_holding_id: lastRow.holding_id,
          p_cursor_name: lastRow.card_name ?? '',
        }),
      )
    } else {
      console.log(
        `  first page FAILED (${first.error}) — cannot fetch a cursor to time the next page`,
      )
    }

    // M9.1 addition (TESTING.md §7 gate, prompt §84-86): value_desc's keyset page is the one M9
    // actually changed (resolver join, holding-total value cursor) — the M7 benchmark predates
    // resolve_variant_market_values entirely, so this is the specific path that needed re-timing.
    console.log('\nBenchmark: keyset second page (value_desc)')
    const firstValue = await timeRpc(userClient, 'list_portfolio', {
      p_sort: 'value_desc',
      p_limit: 30,
    })
    report('first page', firstValue)
    const lastValueRow = firstValue.data?.at(-1)
    if (lastValueRow) {
      report(
        'next page',
        await timeRpc(userClient, 'list_portfolio', {
          p_sort: 'value_desc',
          p_limit: 30,
          p_cursor_holding_id: lastValueRow.holding_id,
          p_cursor_name: lastValueRow.card_name ?? lastValueRow.manual_name ?? '',
          p_cursor_value_minor:
            lastValueRow.holding_value_nok_minor === null
              ? null
              : Number(lastValueRow.holding_value_nok_minor),
          p_cursor_has_value: lastValueRow.holding_value_nok_minor !== null,
        }),
      )
    } else {
      console.log('  next page SKIPPED — first page failed, no cursor available')
    }

    console.log('\nBenchmark: list_portfolio low-value filter')
    report(
      'low-value',
      await timeRpc(userClient, 'list_portfolio', {
        p_sort: 'value_asc',
        p_limit: 30,
        p_low_value: true,
      }),
    )

    console.log('\nBenchmark: list_portfolio missing-value filter')
    report(
      'missing-value',
      await timeRpc(userClient, 'list_portfolio', {
        p_sort: 'name_asc',
        p_limit: 30,
        p_missing_value: true,
      }),
    )

    console.log('\nBenchmark: list_portfolio custom collection scope')
    report(
      'coll. scope',
      await timeRpc(userClient, 'list_portfolio', {
        p_sort: 'value_desc',
        p_limit: 30,
        p_custom_collection_id: collectionId,
      }),
    )

    console.log('\nBenchmark: portfolio_counts()')
    report('counts', await timeRpc(userClient, 'portfolio_counts', {}))

    console.log('\nBenchmark: portfolio_counts() custom collection scope')
    report(
      'counts scoped',
      await timeRpc(userClient, 'portfolio_counts', { p_custom_collection_id: collectionId }),
    )

    console.log(`\nSeeded holdings: ~${LOT_COUNT} lots (with ~30% identity reuse).`)

    if (anyFailure) {
      console.log(
        `\n::error::Portfolio benchmark: at least one call exceeded ${SLOW_MS} ms or failed — ` +
          'failing this step (DECISIONS.md D-059 policy: this defect class has recurred before, ' +
          'and planner statistics are now representative, so a catastrophic result here is real).',
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
