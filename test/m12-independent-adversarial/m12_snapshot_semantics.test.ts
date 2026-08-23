import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  deleteSyntheticUser,
  seedCatalog,
  type TestClient,
} from '../../tests/db/setup'
import { hasSupabaseEnv, skipUnlessM12, type M12Surface } from './helpers/contract'
import {
  acquireRaw,
  acquireSealed,
  backdateAcquisition,
  clearManual,
  correctProviderPrice,
  day,
  drainQueue,
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
 * Historical correctness of the derived snapshot series, judged by an independent oracle
 * (helpers/oracle.ts - zero shared code with the implementation).
 *
 * Scenario letters map to the adversarial brief. Pattern throughout: build a deterministic event
 * sequence through REAL product write paths, recompute expectations from canonical facts in
 * TypeScript, drain the incremental path, then compare exact integer minor units over the FULL
 * date range. A wrong value anywhere fails, not only where we happened to look. Literal integer
 * assertions document WHAT each scenario pins down; the full-range comparison is the gate.
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

function snapAt(rows: SnapshotRow[], date: string): SnapshotRow | null {
  return rows.find((r) => r.snapshot_date === date) ?? null
}

function num(row: SnapshotRow | null, column: string): number {
  if (!row) throw new Error(`no snapshot row for column lookup: ${column}`)
  return Number((row as unknown as Record<string, unknown>)[column])
}

/** Full-range equality: every expected day present and exact on all seven semantic columns. */
function compareFullRange(facts: OracleFacts, rows: SnapshotRow[], from: string, to: string): void {
  const expected = expectedSeriesBetween(facts, from, to)
  for (const exp of expected) {
    const actual = snapAt(rows, exp.snapshot_date)
    if (!actual) {
      throw new Error(
        `no snapshot row exists for ${exp.snapshot_date}. The contract requires one ` +
          `end-of-business-day state per user per date from the first tracked date onward; ` +
          `a sparse series cannot answer chart queries honestly.`,
      )
    }
    const mismatch = compareExpectedToRow(exp, actual as unknown as Record<string, unknown>)
    if (mismatch) {
      throw new Error(
        `snapshot ${exp.snapshot_date} column ${mismatch.column}: oracle expects ` +
          `${mismatch.expected}, database has ${String(mismatch.actual)}. The oracle reads ` +
          `canonical facts only; investigate the engine before touching these assertions.`,
      )
    }
  }
}

async function latestLiveSaleId(env: FixtureEnv): Promise<string> {
  const { data, error } = await env.service
    .from('sales')
    .select('id')
    .eq('user_id', env.user.id)
    .is('voided_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (error || !data) throw new Error(`latest live sale lookup failed: ${error?.message}`)
  return data.id
}

describe('M12 historical snapshot semantics vs the independent oracle', () => {
  it('scenarios A/B/C/D/E/F/G/H/I/J/K/L/M on one deterministic timeline', async (ctx) => {
    if (!hasSupabaseEnv()) ctx.skip('No Supabase ephemeral stack configured.')
    const env0 = createServiceClient()
    const surface0: M12Surface = await skipUnlessM12(ctx, env0)
    const env: FixtureEnv = await makeEnv('m12-semantics')
    cleanupUsers.push(env.user.id)
    const surface = surface0

    await setFxRate(env, 'EUR', day(-2), '10.00000000') // factor 10 everywhere below

    // Scenario A/B/F vehicle: priced from day(0), owned from day(29), then the sale moved.
    const va = await makeVariant(env, 'va')
    await setProviderPrice(env, va.variantId, 'tcgdex_cardmarket', 1000, day(0)) // unit 10 000
    await setProviderPrice(env, va.variantId, 'tcgdex_cardmarket', 2000, day(40)) // unit 20 000
    const acqVA = await acquireRaw(env, va.variantId, day(29), 50_000)

    // Scenario G vehicle: bought day(38), only observation dated day(41).
    const vg = await makeVariant(env, 'vg')
    await setProviderPrice(env, vg.variantId, 'tcgdex_cardmarket', 1500, day(41)) // unit 15 000
    await acquireRaw(env, vg.variantId, day(38), 9_000)

    // Scenario C vehicle: acquire and fully sell on day(55).
    const vc = await makeVariant(env, 'vc')
    await setProviderPrice(env, vc.variantId, 'tcgdex_cardmarket', 600, day(50))
    const acqVC = await acquireRaw(env, vc.variantId, day(55), 5_000)
    await sellLots(env, day(55), [{ lotId: acqVC.lotId, quantity: 1, unitGrossMinor: 6_000 }])

    // Scenario D vehicle: acquired day(40), BACKDATED to day(15); manual effective day(10).
    const vd = await makeVariant(env, 'vd')
    const acqVD = await acquireRaw(env, vd.variantId, day(40), 8_000)
    await setManual(env, acqVD.holdingId, 9_000, day(10))

    // Scenario I vehicle: two observations; the day(45) one gets corrected afterwards.
    const vi = await makeVariant(env, 'vi')
    await setProviderPrice(env, vi.variantId, 'tcgdex_cardmarket', 400, day(20)) // unit 4 000
    await setProviderPrice(env, vi.variantId, 'tcgdex_cardmarket', 500, day(45)) // unit 5 000
    await acquireRaw(env, vi.variantId, day(50), 1_000)

    // Scenario K vehicles: genuinely-zero-priced card next to a never-priced card.
    const vz = await makeVariant(env, 'vz')
    await setProviderPrice(env, vz.variantId, 'tcgdex_cardmarket', 0, day(30))
    await acquireRaw(env, vz.variantId, day(33), 100)
    const vu = await makeVariant(env, 'vu')
    await acquireRaw(env, vu.variantId, day(33), 100)

    // Scenario L vehicle: graded holding, printing has raw prices, manual at day(30).
    const vl = await makeVariant(env, 'vl')
    await setProviderPrice(env, vl.variantId, 'tcgdex_cardmarket', 3000, day(0))
    const { data: gradedHolding, error: gradedHoldingError } = await service
      .from('holdings')
      .insert({
        user_id: env.user.id,
        holding_kind: 'graded_card',
        card_variant_id: vl.variantId,
        grading_state: 'graded',
        grader: 'psa',
        grade: 10,
      })
      .select('id')
      .single<{ id: string }>()
    if (gradedHoldingError) throw new Error(gradedHoldingError.message)
    const { error: gradedLotError } = await service.from('acquisition_lots').insert({
      holding_id: gradedHolding!.id,
      user_id: env.user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: day(25),
      quantity: 1,
      quantity_remaining: 1,
    })
    if (gradedLotError) throw new Error(gradedLotError.message)
    await setManual(env, gradedHolding!.id, 45_000, day(30))

    // Scenario M vehicle: sealed, manual-only valuation arriving day(38).
    const acqSealed = await acquireSealed(env, seedCatalog.sealedProductId, day(35), 12_000)
    await setManual(env, acqSealed.holdingId, 13_000, day(38))

    // Scenario J vehicle: manual history on a raw card with no provider price: set day(12),
    // change day(20), BACKDATED correction to day(5), clear after the span.
    const vj = await makeVariant(env, 'vj')
    const acqVJ = await acquireRaw(env, vj.variantId, day(10), 2_000)
    await setManual(env, acqVJ.holdingId, 11_100, day(12))
    await setManual(env, acqVJ.holdingId, 22_200, day(20))
    await setManual(env, acqVJ.holdingId, 5_500, day(5))
    await clearManual(env, acqVJ.holdingId)

    await backdateAcquisition(env, acqVD, 1, 8_000, day(15))
    await drainQueue(surface)

    let facts = await loadFacts(service, env.user.id)
    let rows = await readSnapshots(env)

    expect(firstTrackedDate(facts)).toBe(day(10))
    expect(rows.filter((r) => r.snapshot_date < day(10))).toEqual([])

    compareFullRange(facts, rows, day(10), day(99))

    expect(num(snapAt(rows, day(28)), 'open_lot_count')).toBe(3)
    expect(num(snapAt(rows, day(28)), 'unvalued_lot_count')).toBe(1)
    // Test correction (was 20_100): day(28) >= day(20), so VJ is covered by its day(20)-effective
    // change row (22_200), not the first set (11_100). 9_000 VD + 22_200 VJ = 31_200.
    expect(num(snapAt(rows, day(28)), 'market_value_nok_minor')).toBe(31_200)

    // Test correction (was 30_100): same VJ region rule; VA is fresh here (obs day(0), age 29).
    // 10_000 VA + 9_000 VD + 22_200 VJ = 41_200.
    expect(num(snapAt(rows, day(29)), 'market_value_nok_minor')).toBe(41_200)
    // Test correction (was 75_100): VL's manual arrives exactly on day(30); VA still fresh at
    // age 30. 10_000 + 9_000 + 22_200 + 45_000 = 86_200.
    expect(num(snapAt(rows, day(30)), 'market_value_nok_minor')).toBe(86_200)
    expect(num(snapAt(rows, day(31)), 'unvalued_lot_count')).toBe(2)
    expect(num(snapAt(rows, day(35)), 'unvalued_lot_count')).toBe(3)
    expect(num(snapAt(rows, day(40)), 'unvalued_lot_count')).toBe(2)
    // Test correction (was 96_100): VA re-freshens to 20_000 on its own day(40) observation.
    // 20_000 VA + 9_000 VD + 22_200 VJ + 45_000 VL + 13_000 sealed + 0 VZ = 109_200.
    expect(num(snapAt(rows, day(40)), 'market_value_nok_minor')).toBe(109_200)

    // Scenario G: no look-ahead. VG owned from day(38), unvalued until its day(41) observation,
    // valued ON day(41) itself - never before.
    expect(num(snapAt(rows, day(39)), 'unvalued_lot_count')).toBe(3) // VA, VG, VU
    expect(num(snapAt(rows, day(39)), 'market_value_nok_minor')).toBe(89_200)
    expect(num(snapAt(rows, day(41)), 'unvalued_lot_count')).toBe(1) // VU only
    expect(num(snapAt(rows, day(41)), 'market_value_nok_minor')).toBe(124_200)

    // Scenario C: end-of-day semantics. The round-trip lot is closed ON day(55): the open-lot
    // count does not step, while both frozen cumulatives move by their exact amounts.
    expect(num(snapAt(rows, day(54)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(55)), 'open_lot_count'),
    )
    expect(num(snapAt(rows, day(54)), 'sales_proceeds_to_date_nok_minor')).toBe(0)
    expect(num(snapAt(rows, day(55)), 'sales_proceeds_to_date_nok_minor')).toBe(6_000)
    expect(num(snapAt(rows, day(54)), 'collectible_spend_to_date_nok_minor')).toBe(82_200)
    expect(num(snapAt(rows, day(55)), 'collectible_spend_to_date_nok_minor')).toBe(87_200)

    // Scenario D: ownership begins at the BACKDATED date; the day(10)-effective manual valuation
    // must not reach day(14).
    expect(num(snapAt(rows, day(14)), 'market_value_nok_minor')).toBe(11_100)
    expect(num(snapAt(rows, day(15)), 'market_value_nok_minor')).toBe(20_100)

    // Scenario J: reconstructable manual history - corrected region, first set, change, and
    // in-range values surviving the wall-clock clear that happened after the span.
    expect(num(snapAt(rows, day(11)), 'market_value_nok_minor')).toBe(5_500)
    expect(num(snapAt(rows, day(13)), 'market_value_nok_minor')).toBe(11_100)
    // Test correction (was 76_200): on day(21) VL is not yet owned (lot starts day(25)), so the
    // 45_000 manual cannot appear. Open lots are VJ + VD only: 22_200 + 9_000 = 31_200.
    expect(num(snapAt(rows, day(21)), 'market_value_nok_minor')).toBe(31_200)
    expect(num(snapAt(rows, day(98)), 'market_value_nok_minor')).toBe(89_200)

    // Scenario K: the zero-priced card counts as valued-at-zero (open, not unvalued); the
    // never-priced card is counted instead. Neither is aggregated away.
    expect(num(snapAt(rows, day(34)), 'open_lot_count')).toBe(6)
    expect(num(snapAt(rows, day(34)), 'unvalued_lot_count')).toBe(2)
    // Test correction (was 65_100): same VJ region rule as above - 22_200 from day(20).
    // 9_000 VD + 22_200 VJ + 45_000 VL + 0 VZ = 76_200; VA is unvalued here (age 34 > 30).
    expect(num(snapAt(rows, day(34)), 'market_value_nok_minor')).toBe(76_200)

    // Scenario L/M boundaries.
    expect(num(snapAt(rows, day(29)), 'unvalued_lot_count')).toBe(1) // VL graded, pre-manual
    expect(num(snapAt(rows, day(36)), 'unvalued_lot_count')).toBe(3) // VA, VU, sealed
    expect(num(snapAt(rows, day(43)), 'market_value_nok_minor')).toBe(124_200)

    // ------------------- Scenario I: correct the day(45) observation. -------------------
    const day49RowBefore = snapAt(rows, day(49))
    const day52MarketBefore = num(snapAt(rows, day(52)), 'market_value_nok_minor')
    const day75UnvaluedBefore = num(snapAt(rows, day(75)), 'unvalued_lot_count')
    await correctProviderPrice(env, vi.variantId, 'tcgdex_cardmarket', day(45), 700) // unit -> 7 000
    await drainQueue(surface)
    facts = await loadFacts(service, env.user.id)
    rows = await readSnapshots(env)
    compareFullRange(facts, rows, day(10), day(99))
    // An earlier unrelated snapshot stays identical on every semantic column.
    expect(snapAt(rows, day(49))).toEqual(day49RowBefore)
    // D-and-forward recomputed exactly where the corrected observation rules: VI's unit moved
    // 5000 -> 7000 from its acquisition (day 50) through the observation's last usable day (75),
    // and ages back into unvalued the day after - counted, never zeroed.
    expect(num(snapAt(rows, day(52)), 'market_value_nok_minor')).toBe(day52MarketBefore + 2_000)
    expect(num(snapAt(rows, day(76)), 'unvalued_lot_count')).toBe(day75UnvaluedBefore + 1)

    // ------------------- Scenario B: sell VA fully on day(60). -------------------
    await sellLots(env, day(60), [{ lotId: acqVA.lotId, quantity: 1, unitGrossMinor: 25_000 }])
    await drainQueue(surface)
    facts = await loadFacts(service, env.user.id)
    rows = await readSnapshots(env)
    compareFullRange(facts, rows, day(10), day(99))
    expect(num(snapAt(rows, day(59)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(58)), 'open_lot_count'),
    )
    expect(num(snapAt(rows, day(60)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(58)), 'open_lot_count') - 1,
    )
    expect(num(snapAt(rows, day(59)), 'sales_proceeds_to_date_nok_minor')).toBe(6_000)
    expect(num(snapAt(rows, day(60)), 'sales_proceeds_to_date_nok_minor')).toBe(31_000)

    // ------------------- Scenario F: move the sale LATER to day(75). -------------------
    // The OLD earlier date is dirtied too: ownership reappears across days 60..74.
    await voidSale(env, await latestLiveSaleId(env))
    await sellLots(env, day(75), [{ lotId: acqVA.lotId, quantity: 1, unitGrossMinor: 25_000 }])
    await drainQueue(surface)
    facts = await loadFacts(service, env.user.id)
    rows = await readSnapshots(env)
    compareFullRange(facts, rows, day(10), day(99))
    expect(num(snapAt(rows, day(61)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(59)), 'open_lot_count'),
    )
    expect(num(snapAt(rows, day(74)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(59)), 'open_lot_count'),
    )
    expect(num(snapAt(rows, day(75)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(59)), 'open_lot_count') - 1,
    )

    // ------------------- Scenario E: move the sale EARLIER to day(65). -------------------
    await voidSale(env, await latestLiveSaleId(env))
    await sellLots(env, day(65), [{ lotId: acqVA.lotId, quantity: 1, unitGrossMinor: 25_000 }])
    await drainQueue(surface)
    facts = await loadFacts(service, env.user.id)
    rows = await readSnapshots(env)
    compareFullRange(facts, rows, day(10), day(99))
    expect(num(snapAt(rows, day(64)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(59)), 'open_lot_count'),
    )
    expect(num(snapAt(rows, day(65)), 'open_lot_count')).toBe(
      num(snapAt(rows, day(59)), 'open_lot_count') - 1,
    )
    expect(num(snapAt(rows, day(64)), 'sales_proceeds_to_date_nok_minor')).toBe(6_000)
    expect(num(snapAt(rows, day(65)), 'sales_proceeds_to_date_nok_minor')).toBe(31_000)
  })
})
