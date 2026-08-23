import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceClient, deleteSyntheticUser, type TestClient } from '../../tests/db/setup'
import {
  SNAPSHOT_COLUMNS,
  hasSupabaseEnv,
  skipUnlessM12,
  type M12Surface,
} from './helpers/contract'
import {
  acquireRaw,
  backdateAcquisition,
  correctProviderPrice,
  day,
  drainQueue,
  fullRebuild,
  makeEnv,
  makeVariant,
  readSnapshots,
  sellLots,
  setFxRate,
  setManual,
  setProviderPrice,
  voidSale,
  type FixtureEnv,
  type SnapshotRow,
} from './helpers/fixtures'
import {
  compareExpectedToRow,
  expectedSeriesBetween,
  firstTrackedDate,
  loadFacts,
  type OracleFacts,
} from './helpers/oracle'

/**
 * THE CENTRAL GATE (priority 1): a full rebuild must equal incremental recomputation exactly,
 * byte-for-byte over every semantic column, over a fixture containing backdating, a partial
 * sale, a voided-and-re-entered sale, manual set/change plus a backdated correction, a price
 * correction, a genuine-zero observation and an unpriced variant.
 *
 * Differential protocol: user INC replays the identical event sequence with the queue drained
 * after every mutation; user FULL replays it with no drain at all and is then materialised by a
 * single explicit full rebuild. Both are additionally judged against the independent oracle.
 * If incremental drift ever exists, the two users' caches cannot agree; if the rebuild is not a
 * pure function of canonical facts, FULL diverges from the oracle.
 */

let service: TestClient
const cleanupUsers: string[] = []

beforeAll(async () => {
  if (!hasSupabaseEnv()) return
  service = createServiceClient()
})

afterAll(async () => {
  if (!hasSupabaseEnv() || !service) return
  for (const id of cleanupUsers) await deleteSyntheticUser(service, id)
})

interface ReplayHandles {
  w1VariantId: string
}

async function replay(
  env: FixtureEnv,
  interleaveDrains: boolean,
  surface: M12Surface,
): Promise<ReplayHandles> {
  const step = async (): Promise<void> => {
    if (interleaveDrains) await drainQueue(surface)
  }

  await setFxRate(env, 'EUR', day(-1), '10.00000000')

  const w1 = await makeVariant(env, 'eq-w1')
  await setProviderPrice(env, w1.variantId, 'tcgdex_cardmarket', 800, day(2)) // unit 8 000
  await acquireRaw(env, w1.variantId, day(5), 5_000)
  await acquireRaw(env, w1.variantId, day(5), 5_000) // second lot, same holding identity
  await step()

  const w2 = await makeVariant(env, 'eq-w2')
  const w2acq = await acquireRaw(env, w2.variantId, day(7), 4_000)
  await setManual(env, w2acq.holdingId, 5_000, day(8))
  await step()

  // Partial sale: exactly one of W1's two units leaves on day(12).
  const { data: w1Lots } = await env.service
    .from('acquisition_lots')
    .select('id')
    .eq('holding_id', await lotOfFirstHoldingForVariant(env, w1.variantId))
    .order('created_at')
  if (!w1Lots || w1Lots.length < 2) throw new Error('expected two lots behind W1')
  const soldLotId = String(w1Lots[0]!.id)
  const sale1 = await sellLots(
    env,
    day(12),
    [{ lotId: soldLotId, quantity: 1, unitGrossMinor: 9_000 }],
    1_000,
  )
  await step()

  await backdateAcquisition(env, w2acq, 1, 4_000, day(6))
  await step()

  await voidSale(env, sale1.saleId)
  await step()
  await sellLots(env, day(14), [{ lotId: soldLotId, quantity: 1, unitGrossMinor: 9_000 }], 1_000)
  await step()

  await setManual(env, w2acq.holdingId, 5_200, day(16))
  await step()
  await setManual(env, w2acq.holdingId, 4_800, day(4)) // BACKDATED correction into settled history
  await step()

  await correctProviderPrice(env, w1.variantId, 'tcgdex_cardmarket', day(2), 850) // unit -> 8 500
  await step()

  const w3 = await makeVariant(env, 'eq-w3') // genuinely zero-priced
  await setProviderPrice(env, w3.variantId, 'tcgdex_cardmarket', 0, day(10))
  await acquireRaw(env, w3.variantId, day(11), 200)
  await step()

  const w4 = await makeVariant(env, 'eq-w4') // never priced at all
  await acquireRaw(env, w4.variantId, day(13), 300)
  await step()

  return { w1VariantId: w1.variantId }
}

async function lotOfFirstHoldingForVariant(env: FixtureEnv, variantId: string): Promise<string> {
  const { data, error } = await env.service
    .from('holdings')
    .select('id')
    .eq('card_variant_id', variantId)
    .eq('user_id', env.user.id)
    .limit(1)
    .single<{ id: string }>()
  if (error || !data) throw new Error(`holding for variant not found: ${error?.message}`)
  return data.id
}

function semanticMap(rows: SnapshotRow[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const r of rows) {
    const record = r as unknown as Record<string, unknown>
    map.set(
      r.snapshot_date,
      SNAPSHOT_COLUMNS.map((c) => Number(record[c])),
    )
  }
  return map
}

describe('M12 central gate: full rebuild == incremental == oracle', () => {
  it('two identical event sequences converge byte-identically regardless of recompute path', async (ctx) => {
    if (!hasSupabaseEnv()) ctx.skip('No Supabase ephemeral stack configured.')
    const probe = createServiceClient()
    const surface = await skipUnlessM12(ctx, probe)

    const inc = await makeEnv('m12-equiv-inc')
    const full = await makeEnv('m12-equiv-full')
    cleanupUsers.push(inc.user.id, full.user.id)

    await replay(inc, true, surface)
    await replay(full, false, surface)

    // FULL never touched the queue; materialise it with one explicit full rebuild.
    await fullRebuild(surface, full.user.id, day(0), day(40))

    const factsInc: OracleFacts = await loadFacts(service, inc.user.id)
    const factsFull: OracleFacts = await loadFacts(service, full.user.id)
    const rowsInc = await readSnapshots(inc)
    const rowsFull = await readSnapshots(full)

    // Both users judged against the independent oracle. Each user is judged across its OWN full
    // cached range: the incremental user's drains legitimately extend through current_date,
    // while the full-rebuild user's explicit rebuild was bounded at day(40).
    for (const [facts, rows, label] of [
      [factsInc, rowsInc, 'incremental'],
      [factsFull, rowsFull, 'full-rebuild'],
    ] as const) {
      const lastCached = rows[rows.length - 1]?.snapshot_date
      if (!lastCached) throw new Error(`${label}: cache is empty`)
      const expected = expectedSeriesBetween(facts, firstTrackedDate(facts), lastCached)
      for (const exp of expected) {
        const actual = rows.find((r) => r.snapshot_date === exp.snapshot_date)
        if (!actual) throw new Error(`${label}: missing snapshot ${exp.snapshot_date}`)
        const mismatch = compareExpectedToRow(exp, actual as unknown as Record<string, unknown>)
        if (mismatch) {
          throw new Error(
            `${label} ${exp.snapshot_date} ${mismatch.column}: oracle ${mismatch.expected}, ` +
              `database ${String(mismatch.actual)}`,
          )
        }
      }
    }

    // The gate itself: the incremental cache must cover everything the explicit rebuild produced,
    // and every shared date must be byte-identical on all seven semantic columns. (The raw key
    // sets are NOT equal by construction: drains extend through current_date, the explicit
    // rebuild was bounded at day(40).) A cache that depends on how it was computed cannot hold
    // on any shared date without failing here.
    const mapInc = semanticMap(rowsInc)
    const mapFull = semanticMap(rowsFull)
    expect(mapInc.size).toBeGreaterThanOrEqual(mapFull.size)
    for (const [date, fullValues] of mapFull) {
      const incValues = mapInc.get(date)
      if (!incValues) throw new Error(`full-rebuild date ${date} missing from the incremental cache`)
      for (let i = 0; i < SNAPSHOT_COLUMNS.length; i++) {
        const column = SNAPSHOT_COLUMNS[i]
        if (incValues[i] !== fullValues[i]) {
          throw new Error(
            `PATH DIVERGENCE at ${date} column ${column}: incremental=${incValues[i]} ` +
              `full=${fullValues[i]}. The cache can never be allowed to depend on how it was ` +
              `computed.`,
          )
        }
      }
    }

    // Rebuild twice more: the output is stable under repetition (idempotence).
    await fullRebuild(surface, full.user.id, day(0), day(40))
    await fullRebuild(surface, full.user.id, day(0), day(40))
    const rowsFullAgain = await readSnapshots(full)
    const mapAgain = semanticMap(rowsFullAgain)
    for (const [date, values] of mapFull) {
      expect(mapAgain.get(date)).toEqual(values)
    }

    // Poison probe: if the service role may touch a cached cell, a full rebuild must repair it.
    const victimDate = rowsInc[0]?.snapshot_date
    if (!victimDate) throw new Error('incremental user produced no rows')
    const oracleVictim = expectedSeriesBetween(factsInc, victimDate, victimDate)[0]!
    const { error: poisonError } = await service
      .from('portfolio_snapshots')
      .update({ market_value_nok_minor: 999_999_999 })
      .eq('user_id', inc.user.id)
      .eq('snapshot_date', victimDate)
    if (poisonError) {
      console.warn(
        '[m12-adversarial] poison probe skipped: service role cannot UPDATE portfolio_snapshots ' +
          `(${poisonError.message}). Repair-on-rebuild is then enforced by construction.`,
      )
    } else {
      await fullRebuild(surface, inc.user.id, victimDate, victimDate)
      const repaired = (await readSnapshots(inc)).find((r) => r.snapshot_date === victimDate)
      expect(Number(repaired?.market_value_nok_minor)).toBe(oracleVictim.market_value_nok_minor)
    }
  })

  it('a stale cache cell is corrected by the queue path as well, not only by explicit rebuilds', async (ctx) => {
    if (!hasSupabaseEnv()) ctx.skip('No Supabase ephemeral stack configured.')
    const probe = createServiceClient()
    const surface = await skipUnlessM12(ctx, probe)

    const env = await makeEnv('m12-equiv-queue')
    cleanupUsers.push(env.user.id)
    await setFxRate(env, 'EUR', day(-1), '10.00000000')
    const v = await makeVariant(env, 'eq-q1')
    await setProviderPrice(env, v.variantId, 'tcgdex_cardmarket', 1000, day(0)) // unit 10 000
    await acquireRaw(env, v.variantId, day(3), 4_000)
    await drainQueue(surface)

    const before = await readSnapshots(env)
    const day5 = before.find((r) => r.snapshot_date === day(5))
    expect(Number(day5?.market_value_nok_minor)).toBe(10_000)

    const { error: poisonError } = await service
      .from('portfolio_snapshots')
      .update({ market_value_nok_minor: 123 })
      .eq('user_id', env.user.id)
      .eq('snapshot_date', day(5))
    if (poisonError) {
      console.warn(
        '[m12-adversarial] queue-repair probe skipped: no service-side UPDATE grant ' +
          `(${poisonError.message}).`,
      )
      return
    }

    // Any later canonical event that dirties day(5)-or-before must wash the poison out through
    // the ordinary incremental path - here a backdated manual valuation effective day(2).
    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('card_variant_id', v.variantId)
      .eq('user_id', env.user.id)
      .limit(1)
      .single<{ id: string }>()
    if (!holding) throw new Error('holding not found')
    await setManual(env, holding.id, 11_000, day(2))
    await drainQueue(surface)

    const after = await readSnapshots(env)
    expect(Number(after.find((r) => r.snapshot_date === day(5))?.market_value_nok_minor)).toBe(
      11_000,
    )
    const facts = await loadFacts(service, env.user.id)
    // Rows exist only from the user's first tracked date onward (DATA_MODEL §6: no fabricated
    // pre-history). The backdated manual valuation's effective_from does NOT extend tracked
    // history before the earliest ownership/ledger event - helpers/oracle.ts#firstTrackedDate
    // encodes the same rule, so the comparison range starts there rather than at day(2).
    const origin = firstTrackedDate(facts)
    const expected = expectedSeriesBetween(facts, origin, day(20))
    for (const exp of expected) {
      const actual = after.find((r) => r.snapshot_date === exp.snapshot_date)
      if (!actual) throw new Error(`missing snapshot ${exp.snapshot_date} after queue repair`)
      const mismatch = compareExpectedToRow(exp, actual as unknown as Record<string, unknown>)
      if (mismatch) {
        throw new Error(
          `queue repair ${exp.snapshot_date} ${mismatch.column}: oracle ${mismatch.expected}, ` +
            `database ${String(mismatch.actual)}`,
        )
      }
    }
  })
})
