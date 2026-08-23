import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServiceClient, deleteSyntheticUser, type TestClient } from '../../../tests/db/setup'
import { hasSupabaseEnv, skipUnlessM12, type M12Surface } from '../helpers/contract'
import {
  acquireRaw,
  backdateAcquisition,
  day,
  drainQueue,
  fullRebuild,
  makeEnv,
  makeVariant,
  setFxRate,
  setProviderPrice,
} from '../helpers/fixtures'

/**
 * Performance pathologies (priority 15) - an AUDIT, not a microbenchmark gate (TESTING.md §7
 * policy). Skipped entirely unless M12_PERF_AUDIT=1 is exported, so ordinary runs stay fast.
 *
 * Scale: ~480 lots across 60 variants with 90 days of provider history. Thresholds are
 * catastrophic-only, in the spirit of D-059: a breach is a genuine regression class finding,
 * ordinary runner variance never trips them.
 */

let service: TestClient
let userId: string | null = null

beforeAll(async () => {
  if (!hasSupabaseEnv()) return
  service = createServiceClient()
})

afterAll(async () => {
  if (!hasSupabaseEnv() || !service) return
  if (userId) await deleteSyntheticUser(service, userId)
})

const PERF_ENABLED = process.env.M12_PERF_AUDIT === '1'

/**
 * ANALYZE after the bulk seed, before anything is timed - the same D-059 discipline both
 * permanent benchmarks follow. A fresh ephemeral database has never been autovacuumed, so every
 * seeded table's reltuples is still Postgres's "never analyzed" sentinel and the planner falls
 * back to no-information defaults; the first CI run of this audit died in exactly that state
 * (a drain statement cancelled by statement timeout on a plan no analyzed database would pick).
 * Mirrors scripts/portfolio-snapshots-benchmark.mjs's analyzeSeededTables.
 */
function analyzeSeededTables(): void {
  const DB_URL = process.env.DB_URL
  if (!DB_URL) {
    console.warn(
      '[m12-adversarial] DB_URL not set - skipping ANALYZE; timings may reflect un-analyzed ' +
        'bulk state (the M9.2 measurement trap).',
    )
    return
  }
  const sql = [
    'holdings',
    'acquisition_lots',
    'card_variants',
    'cards',
    'card_sets',
    'card_series',
    'manual_valuations',
    'price_snapshots',
    'lot_disposals',
    'purchases',
    'purchase_lines',
    'fx_rates',
  ]
    .map((t) => `analyze public.${t};`)
    .join(' ')
  execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' })
}

/**
 * Heavy engine calls for the audit. When DB_URL is available (CI exports it) they run over the
 * direct psql channel, the same one both permanent benchmarks already use for privileged work:
 * a background engine's cost is what is under audit here, and routing it through PostgREST
 * exposes the measurement to platform role/gateway statement caps that have nothing to do with
 * engine cost (the audit passed at 250 ms on one run and died in a statement timeout on the
 * next under runner variance). Falls back to the PostgREST path when DB_URL is absent.
 */
function psqlEngineCall(sql: string): void {
  const DB_URL = process.env.DB_URL
  if (!DB_URL) throw new Error('DB_URL required for the direct engine channel')
  execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8' })
}

async function auditRebuild(
  surface: M12Surface,
  userId: string,
  from: string,
  through: string,
): Promise<void> {
  if (process.env.DB_URL) {
    psqlEngineCall(
      `select public.rebuild_portfolio_snapshots('${userId}', '${from}', '${through}');`,
    )
    return
  }
  await fullRebuild(surface, userId, from, through)
}

async function auditDrain(surface: M12Surface): Promise<void> {
  if (process.env.DB_URL) {
    psqlEngineCall('select public.drain_portfolio_recompute_queue();')
    return
  }
  await drainQueue(surface)
}

describe('M12 performance audit', () => {
  it('rebuild / incremental / dashboard-read at moderate scale stay within catastrophic bounds', async (ctx) => {
    if (!PERF_ENABLED) ctx.skip('set M12_PERF_AUDIT=1 to run the scale audit')
    const surface = await skipUnlessM12(ctx, service)

    const env = await makeEnv('m12-perf')
    userId = env.user.id
    await setFxRate(env, 'EUR', day(-1), '10.00000000')

    const VARIANTS = 60
    const DAYS = 90
    const PURCHASES_PER_VARIANT = 4

    const variantIds: string[] = []
    for (let i = 0; i < VARIANTS; i++) {
      const v = await makeVariant(env, `perf-${i}`)
      variantIds.push(v.variantId)
      for (let d = -DAYS; d <= -1; d += 7) {
        await setProviderPrice(
          env,
          v.variantId,
          'tcgdex_cardmarket',
          500 + ((i * 13 + d) % 400),
          day(d),
        )
      }
    }

    const acquisitions = [] as {
      purchaseId: string
      lotId: string
      holdingId: string
      quantity: number
      price: number
    }[]
    for (let i = 0; i < VARIANTS; i++) {
      for (let k = 0; k < PURCHASES_PER_VARIANT; k++) {
        acquisitions.push({
          ...(await acquireRaw(env, variantIds[i]!, day((i + k) % DAYS), 1_000 + i)),
          quantity: 2,
          price: 1_000 + i,
        })
      }
    }
    expect(acquisitions.length).toBe(VARIANTS * PURCHASES_PER_VARIANT)

    analyzeSeededTables()

    const t = (): number => performance.now()

    // Full rebuild over the entire range.
    let start = t()
    await auditRebuild(surface, env.user.id, day(-DAYS), day(0))
    const rebuildMs = Math.round(t() - start)

    // Single-event incremental: one backdated edit, then a queue drain.
    start = t()
    await backdateAcquisition(
      env,
      acquisitions[0]!,
      acquisitions[0]!.quantity,
      acquisitions[0]!.price,
      day(-DAYS),
    )
    await auditDrain(surface)
    const incrementalMs = Math.round(t() - start)

    // The dashboard read must be a cache read: flat and fast regardless of the work above.
    const summaryRuns: number[] = []
    for (let i = 0; i < 5; i++) {
      start = t()
      const { error } = await env.client.rpc('get_dashboard_summary')
      summaryRuns.push(Math.round(t() - start))
      if (error) throw new Error(`get_dashboard_summary failed: ${error.message}`)
    }
    const summaryAvgMs = Math.round(summaryRuns.reduce((a, b) => a + b, 0) / summaryRuns.length)

    start = t()
    const { error: historyError } = await env.client.rpc('get_portfolio_history', {})
    if (historyError) throw new Error(`get_portfolio_history failed: ${historyError.message}`)
    const historyMs = Math.round(t() - start)

    console.table([
      { measure: 'full rebuild 90d/60v', ms: rebuildMs, catastrophicAfterMs: 30_000 },
      { measure: 'single-edit incremental drain', ms: incrementalMs, catastrophicAfterMs: 10_000 },
      { measure: 'get_dashboard_summary avg x5', ms: summaryAvgMs, catastrophicAfterMs: 750 },
      { measure: 'get_portfolio_history window', ms: historyMs, catastrophicAfterMs: 1_500 },
    ])

    expect(rebuildMs).toBeLessThan(30_000)
    expect(incrementalMs).toBeLessThan(10_000)
    expect(summaryAvgMs).toBeLessThan(750)
    expect(historyMs).toBeLessThan(1_500)
  })
})
