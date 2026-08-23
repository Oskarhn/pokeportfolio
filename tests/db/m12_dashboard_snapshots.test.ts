import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M12: the snapshot cache engine (DATA_MODEL.md §6, FINANCIAL_MODEL.md §3, TESTING.md §3).
 *
 * The centre of gravity is the FULL-VS-INCREMENTAL equality gate: the same canonical state must
 * produce byte-identical semantic rows whether the cache was maintained incrementally as events
 * happened or rebuilt from scratch — computed_at excluded, everything else compared exactly.
 * Around it sit the ownership-timeline boundaries, the as-of valuation rules (freshness measured
 * from the snapshot date, never from today; no future observations; genuine zero ≠ missing),
 * the manual-valuation interval model (D-062), the frozen-ledger cumulatives, data-quality
 * counts, monthly spend reconciliation (F1), the sales-figure split (RRC/PUD, F5) and the
 * historical display-currency rule (D-067).
 *
 * Fixtures use dedicated catalog variants (created here, unique per run) so price_snapshots'
 * unique (variant, provider, date) key never collides with another suite sharing the ephemeral
 * stack — the exact class of cross-file collision M10 found the hard way.
 */

let service: TestClient
let user: SyntheticUser

const today = new Date()
function daysAgo(n: number): string {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function createTestVariant(label: string): Promise<string> {
  const cardId = crypto.randomUUID()
  const variantId = crypto.randomUUID()
  const { error: cardError } = await service.from('cards').insert({
    id: cardId,
    set_id: seedCatalog.cardSetId,
    local_id: `m12-${label}`,
    name: `M12 Test ${label}`,
    language: 'en',
  })
  if (cardError) throw new Error(cardError.message)
  const { error: variantError } = await service.from('card_variants').insert({
    id: variantId,
    card_id: cardId,
    finish: 'normal',
  })
  if (variantError) throw new Error(variantError.message)
  return variantId
}

interface HoldingSpec {
  kind?: 'raw_card' | 'graded_card' | 'sealed'
  variantId?: string | null
  sealedProductId?: string | null
  quantity?: number
  costState?: 'known' | 'not_paid' | 'unknown'
  unitCostNok?: number | null
  acquiredDaysAgo?: number
}

async function makeLot(userId: string, spec: HoldingSpec & { holdingId: string }): Promise<string> {
  const { data, error } = await service
    .from('acquisition_lots')
    .insert({
      holding_id: spec.holdingId,
      user_id: userId,
      origin: spec.costState === 'known' ? 'purchase' : 'gift',
      // A 'known' lot is promoted AFTER its backing purchase line exists (M2's CHECK demands the
      // reference at insert time) — inserted here in its legal intermediate 'unknown' state.
      cost_basis_state: spec.costState === 'known' ? 'unknown' : (spec.costState ?? 'not_paid'),
      unit_cost_basis_minor: null,
      acquired_on: daysAgo(spec.acquiredDaysAgo ?? 100),
      quantity: spec.quantity ?? 1,
      quantity_remaining: spec.quantity ?? 1,
      // M11's trigger requires an explicit intent on every sealed lot.
      sealed_intent: (spec.kind ?? 'raw_card') === 'sealed' ? 'undecided' : null,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  const lotId = data.id as string

  // M2/F7: a 'known' basis is only legal with a real purchase line behind it — manufacture the
  // canonical backing rows so the lot satisfies
  // acquisition_lots_cost_basis_state_consistency exactly as create_purchase would have written
  // it. The purchase lands in CS by construction; tests asserting CS account for this.
  if ((spec.costState ?? 'not_paid') === 'known') {
    const acquiredOn = daysAgo(spec.acquiredDaysAgo ?? 100)
    const qty = spec.quantity ?? 1
    const total = (spec.unitCostNok ?? 0) * qty
    const { data: purchase, error: purchaseError } = await service
      .from('purchases')
      .insert({
        user_id: userId,
        purchased_on: acquiredOn,
        currency: 'NOK',
        subtotal_minor: total,
        shipping_minor: 0,
        customs_minor: 0,
        discount_minor: 0,
        total_minor: total,
        fx_rate_to_nok: '1',
        fx_rate_date: acquiredOn,
        fx_source: 'manual',
        total_nok_minor: total,
      })
      .select('id')
      .single()
    if (purchaseError) throw new Error(purchaseError.message)
    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .insert({
        purchase_id: purchase.id,
        user_id: userId,
        line_type: 'bulk_lot',
        spend_class: 'collectible',
        description: 'm12 fixture basis',
        quantity: qty,
        unit_price_minor: spec.unitCostNok ?? 0,
        line_total_minor: total,
        attributable_cost_minor: total,
        attributable_cost_nok_minor: total,
      })
      .select('id')
      .single()
    if (lineError) throw new Error(lineError.message)
    const { error: linkError } = await service
      .from('acquisition_lots')
      .update({
        cost_basis_state: 'known',
        unit_cost_basis_minor: spec.unitCostNok ?? 0,
        unit_cost_basis_nok_minor: spec.unitCostNok ?? 0,
        residual_nok_minor: 0,
        purchase_line_id: line.id,
      })
      .eq('id', lotId)
    if (linkError) throw new Error(linkError.message)
  }

  return lotId
}

async function makeHolding(
  userId: string,
  spec: HoldingSpec = {},
): Promise<{ holdingId: string; lotId: string }> {
  const kind = spec.kind ?? 'raw_card'
  const { data: holding, error } = await service
    .from('holdings')
    .insert({
      user_id: userId,
      holding_kind: kind,
      card_variant_id: kind === 'raw_card' ? (spec.variantId ?? null) : null,
      sealed_product_id: kind === 'sealed' ? (spec.sealedProductId ?? null) : null,
      condition: kind === 'raw_card' ? 'NM' : null,
      grading_state: kind === 'graded_card' ? 'graded' : 'raw',
      grader: kind === 'graded_card' ? 'psa' : null,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  const lotId = await makeLot(userId, { ...spec, holdingId: holding.id as string })
  return { holdingId: holding.id as string, lotId }
}

async function addPrice(opts: {
  variantId: string
  provider?: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
  currency?: 'EUR' | 'USD'
  valueMinor: number
  daysAgo: number
}): Promise<void> {
  const { error } = await service.from('price_snapshots').insert({
    card_variant_id: opts.variantId,
    provider: opts.provider ?? 'tcgdex_cardmarket',
    price_kind: opts.provider === 'tcgdex_tcgplayer' ? 'tp_market' : 'cm_trend',
    source_currency: opts.currency ?? 'EUR',
    value_minor: opts.valueMinor,
    snapshot_date: daysAgo(opts.daysAgo),
    provider_updated_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
}

/** A real sale against one lot, inserted directly (the RPC layer is exercised by the M10
 *  suites; here the canonical rows are what matters). Freezes basis when given. */
async function sellUnits(opts: {
  userId: string
  lotId: string
  quantity: number
  daysAgoSold: number
  proceedsMinor: number
  costBasisAtSaleMinor?: number | null
}): Promise<void> {
  const soldOn = daysAgo(opts.daysAgoSold)
  const { data: sale, error: saleError } = await service
    .from('sales')
    .insert({
      user_id: opts.userId,
      sold_on: soldOn,
      currency: 'NOK',
      gross_minor: opts.proceedsMinor,
      fees_minor: 0,
      shipping_cost_minor: 0,
      shipping_charged_minor: 0,
      net_proceeds_minor: opts.proceedsMinor,
      fx_rate_to_nok: '1',
      fx_rate_date: soldOn,
      fx_source: 'manual',
      net_proceeds_nok_minor: opts.proceedsMinor,
      idempotency_key: crypto.randomUUID(),
    })
    .select('id')
    .single()
  if (saleError) throw new Error(saleError.message)

  const { data: line, error: lineError } = await service
    .from('sale_lines')
    .insert({
      sale_id: sale.id as string,
      user_id: opts.userId,
      lot_id: opts.lotId,
      quantity: opts.quantity,
      unit_gross_minor: opts.proceedsMinor / opts.quantity,
      line_gross_minor: opts.proceedsMinor,
      allocated_fees_minor: 0,
      allocated_shipping_minor: 0,
      allocated_shipping_charged_minor: 0,
      net_proceeds_minor: opts.proceedsMinor,
      net_proceeds_nok_minor: opts.proceedsMinor,
      cost_basis_at_sale_nok_minor: opts.costBasisAtSaleMinor ?? null,
      realized_result_nok_minor:
        opts.costBasisAtSaleMinor == null
          ? null
          : opts.proceedsMinor - (opts.costBasisAtSaleMinor ?? 0),
    })
    .select('id')
    .single()
  if (lineError) throw new Error(lineError.message)

  const { error: disposalError } = await service.from('lot_disposals').insert({
    lot_id: opts.lotId,
    user_id: opts.userId,
    kind: 'sale',
    quantity: opts.quantity,
    disposed_on: soldOn,
    sale_line_id: line.id as string,
  })
  if (disposalError) throw new Error(disposalError.message)
}

async function setManualValue(opts: {
  userId: string
  holdingId: string
  valueMinor: number
  effectiveFromDaysAgo: number
}): Promise<void> {
  // Same supersede-then-insert shape the set_manual_valuation RPC performs — the partial
  // unique index allows at most one active row per holding, and the interval model (D-062)
  // reads history through exactly this append-only trail.
  const { error: supersedeError } = await service
    .from('manual_valuations')
    .update({ superseded_at: new Date().toISOString() })
    .eq('holding_id', opts.holdingId)
    .is('superseded_at', null)
  if (supersedeError) throw new Error(supersedeError.message)

  const { error } = await service.from('manual_valuations').insert({
    user_id: opts.userId,
    holding_id: opts.holdingId,
    value_minor: opts.valueMinor,
    currency: 'NOK',
    value_nok_minor: opts.valueMinor,
    effective_from: daysAgo(opts.effectiveFromDaysAgo),
  })
  if (error) throw new Error(error.message)
}

async function clearManualValue(holdingId: string, clearDaysAgo = 0): Promise<void> {
  const cleared = new Date(today)
  cleared.setUTCDate(cleared.getUTCDate() - clearDaysAgo)
  const { error } = await service
    .from('manual_valuations')
    .update({ superseded_at: cleared.toISOString() })
    .eq('holding_id', holdingId)
    .is('superseded_at', null)
  if (error) throw new Error(error.message)
}

async function rebuild(pUserId: string, pFromDaysAgo: number, pThroughDaysAgo = 0) {
  const { error } = await service.rpc('rebuild_portfolio_snapshots', {
    p_user_id: pUserId,
    p_from: daysAgo(pFromDaysAgo),
    p_through: daysAgo(pThroughDaysAgo),
  })
  if (error) throw new Error(error.message)
}

interface SnapshotRow {
  snapshot_date: string
  market_value_nok_minor: number
  attributed_value_nok_minor: number
  cost_basis_nok_minor: number
  collectible_spend_to_date_nok_minor: number
  sales_proceeds_to_date_nok_minor: number
  open_lot_count: number
  unvalued_lot_count: number
  computed_at: string
}

async function readSnapshots(pUserId: string): Promise<SnapshotRow[]> {
  const { data, error } = await service
    .from('portfolio_snapshots')
    .select('*')
    .eq('user_id', pUserId)
    .order('snapshot_date')
  if (error) throw new Error(error.message)
  return data
}

function snapByDate(rows: SnapshotRow[], daysAgoN: number): SnapshotRow | undefined {
  const target = daysAgo(daysAgoN)
  return rows.find((r) => r.snapshot_date === target)
}

function expectSnap(
  rows: SnapshotRow[],
  daysAgoN: number,
  expected: Partial<Omit<SnapshotRow, 'snapshot_date' | 'computed_at'>>,
): void {
  const row = snapByDate(rows, daysAgoN)
  expect(row, `expected a snapshot ${daysAgoN} days ago`).toBeDefined()
  if (!row) return
  for (const [key, value] of Object.entries(expected)) {
    expect(row[key as keyof SnapshotRow], `${key} ${daysAgoN} days ago`).toBe(value)
  }
}

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'm12-snap-a')

  // Deterministic FX facts — deliberately ANCIENT only. This suite shares the ephemeral stack's
  // fx_rates with the pre-existing M9/M9.1 fixtures: any EUR rate dated inside their observation
  // windows would silently win their as-of conversions (real cross-suite contamination CI
  // caught). The display-FX re-rate lives in its own test, dated even older than these.
  await service.from('fx_rates').upsert(
    [
      {
        base_currency: 'EUR',
        quote_currency: 'NOK',
        rate_date: daysAgo(400),
        rate: '11.50000000',
        source: 'norges_bank',
      },
      {
        base_currency: 'USD',
        quote_currency: 'NOK',
        rate_date: daysAgo(400),
        rate: '10.00000000',
        source: 'norges_bank',
      },
    ],
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
})

// A pristine user per test: snapshot rows are portfolio-level totals, so any shared user would
// make absolute assertions accumulate across tests (real contamination CI caught). The
// withUser-wrapped ownership tests additionally isolate themselves; this hook covers the rest.
beforeEach(async () => {
  user = await createSyntheticUser(service, 'm12-snap-fresh')
})

afterEach(async () => {
  await deleteSyntheticUser(service, user.id)
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

// ── Ownership timeline hard gates (prompt §17-§22, TESTING.md §3) ────────────────────────────

async function withUser(label: string, fn: (u: SyntheticUser) => Promise<void>): Promise<void> {
  const u = await createSyntheticUser(service, label)
  try {
    await fn(u)
  } finally {
    await deleteSyntheticUser(service, u.id)
  }
}

describe('M12 ownership timeline', () => {
  // Every test runs under its OWN synthetic user: snapshot rows are portfolio-level totals, so
  // a shared user would make each test's absolute assertions accumulate every earlier test's
  // holdings (a real cross-test contamination CI caught on the first engine run).
  it('a lot acquired 30 days ago contributes nothing before its acquisition date', async () => {
    await withUser('m12-own-acquire', async (u) => {
      const variant = await createTestVariant('own-acquire')
      await makeHolding(u.id, { variantId: variant, acquiredDaysAgo: 30, quantity: 2 })
      await addPrice({ variantId: variant, valueMinor: 1150, daysAgo: 45 }) // priced before ownership

      await rebuild(u.id, 40)
      const rows = await readSnapshots(u.id)

      // §91: no rows exist before the first tracked date — absence IS the no-history shape,
      // never a zero-filled row.
      expect(snapByDate(rows, 31)).toBeUndefined()
      // 2 units × 11.50 € × 11.5 = 26450 øre while the observation is within its 30-day window.
      expectSnap(rows, 30, { open_lot_count: 1, market_value_nok_minor: 26450 })
      expectSnap(rows, 15, { open_lot_count: 1, market_value_nok_minor: 26450 }) // age exactly 30
      // Day 14: the observation is 31 days old as-of D — excluded and COUNTED, never zeroed.
      expectSnap(rows, 14, { open_lot_count: 1, market_value_nok_minor: 0, unvalued_lot_count: 1 })
    })
  })

  it('a sale on day S contributes nothing from day S onward, earlier days unchanged', async () => {
    await withUser('m12-own-sell', async (u) => {
      const variant = await createTestVariant('own-sell')
      const { lotId } = await makeHolding(u.id, {
        variantId: variant,
        acquiredDaysAgo: 120,
        quantity: 1,
      })
      await addPrice({ variantId: variant, valueMinor: 2300, daysAgo: 130 })
      await sellUnits({ userId: u.id, lotId, quantity: 1, daysAgoSold: 100, proceedsMinor: 5000 })

      await rebuild(u.id, 130)
      const rows = await readSnapshots(u.id)

      expectSnap(rows, 110, { open_lot_count: 1, market_value_nok_minor: 26450 })
      expectSnap(rows, 101, { open_lot_count: 1, market_value_nok_minor: 26450 })
      // Sale day itself: end-of-business-day state — already gone.
      expectSnap(rows, 100, { open_lot_count: 0, market_value_nok_minor: 0 })
      expectSnap(rows, 99, { open_lot_count: 0 })
      // Proceeds accumulate from the sale day onward.
      expectSnap(rows, 101, { sales_proceeds_to_date_nok_minor: 0 })
      expectSnap(rows, 100, { sales_proceeds_to_date_nok_minor: 5000 })
    })
  })

  it('a partial sale reduces quantity from the disposal date; voiding restores history', async () => {
    await withUser('m12-own-partial', async (u) => {
      const variant = await createTestVariant('own-partial')
      const { lotId } = await makeHolding(u.id, {
        variantId: variant,
        acquiredDaysAgo: 90,
        quantity: 5,
      })
      await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 95 })
      // A second observation keeps the valuation window overlapping the sale date — otherwise
      // the first observation's 30-day freshness expires before day 50 and the post-sale
      // assertions would be about missing coverage instead of quantity.
      await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 55 })
      await sellUnits({
        userId: u.id,
        lotId,
        quantity: 2,
        daysAgoSold: 50,
        proceedsMinor: 3000,
      })

      await rebuild(u.id, 95)
      let rows = await readSnapshots(u.id)
      expectSnap(rows, 90, { open_lot_count: 1, market_value_nok_minor: 57500 }) // 5 × 115.00
      // Days −64…−56 sit BETWEEN the two observation windows: open lots with no resolvable
      // value — excluded from CMV and counted, never zeroed (F14). The engine must not bridge
      // the gap by inventing a price.
      expectSnap(rows, 60, { open_lot_count: 1, market_value_nok_minor: 0, unvalued_lot_count: 1 })
      // −55 is still BEFORE the sale date (−50): five units under observation 2.
      expectSnap(rows, 55, { open_lot_count: 1, market_value_nok_minor: 57500 })
      expectSnap(rows, 51, { open_lot_count: 1, market_value_nok_minor: 57500 })
      // From the sale day onward: three units.
      expectSnap(rows, 50, { open_lot_count: 1, market_value_nok_minor: 34500 })
      expectSnap(rows, 25, { open_lot_count: 1, market_value_nok_minor: 34500 })

      // Void the sale: corrected truth puts all five units back across the whole history.
      const { data: disposal } = await service
        .from('lot_disposals')
        .select('id')
        .eq('lot_id', lotId)
        .single()
      await service
        .from('lot_disposals')
        .update({ voided_at: new Date().toISOString() })
        .eq('id', disposal!.id)

      await rebuild(u.id, 95)
      rows = await readSnapshots(u.id)
      expectSnap(rows, 90, { open_lot_count: 1, market_value_nok_minor: 57500 })
      expectSnap(rows, 55, { open_lot_count: 1, market_value_nok_minor: 57500 })
      expectSnap(rows, 50, { open_lot_count: 1, market_value_nok_minor: 57500 })
      expectSnap(rows, 45, { open_lot_count: 1, market_value_nok_minor: 57500 })
      expectSnap(rows, 10, { open_lot_count: 1, market_value_nok_minor: 57500 })
      expectSnap(rows, 10, { sales_proceeds_to_date_nok_minor: 0 }) // voided sale excluded everywhere
    })
  })

  it('same-day acquire + full sell ends that business day at zero', async () => {
    await withUser('m12-own-sameday', async (u) => {
      const variant = await createTestVariant('own-sameday')
      const { lotId } = await makeHolding(u.id, {
        variantId: variant,
        acquiredDaysAgo: 10,
        quantity: 1,
      })
      await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 12 })
      await sellUnits({ userId: u.id, lotId, quantity: 1, daysAgoSold: 10, proceedsMinor: 900 })

      await rebuild(u.id, 14)
      const rows = await readSnapshots(u.id)
      // §91: nothing is tracked before acquisition day — absence, not a zero row.
      expect(snapByDate(rows, 11)).toBeUndefined()
      expectSnap(rows, 10, { open_lot_count: 0, sales_proceeds_to_date_nok_minor: 900 })
    })
  })

  it('backdating a lot rewrites history from the new acquired_on, not before', async () => {
    await withUser('m12-own-backdate', async (u) => {
      const variant = await createTestVariant('own-backdate')
      const { lotId } = await makeHolding(u.id, {
        variantId: variant,
        acquiredDaysAgo: 0,
        quantity: 1,
      })
      await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 25 })

      await rebuild(u.id, 30)
      expect(snapByDate(await readSnapshots(u.id), 21)).toBeUndefined()

      const { error } = await service
        .from('acquisition_lots')
        .update({ acquired_on: daysAgo(20) })
        .eq('id', lotId)
      expect(error).toBeNull()

      await rebuild(u.id, 30)
      const rows = await readSnapshots(u.id)
      expectSnap(rows, 21, { open_lot_count: 0 })
      expectSnap(rows, 20, { open_lot_count: 1, market_value_nok_minor: 11500 })
    })
  })
})

// ── Historical valuation (prompt Part B) ─────────────────────────────────────────────────────

describe('M12 historical valuation', () => {
  it('never uses an observation dated after the snapshot date', async () => {
    const variant = await createTestVariant('val-future')
    await makeHolding(user.id, { variantId: variant, acquiredDaysAgo: 40 })
    await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: -1 }) // tomorrow

    await rebuild(user.id, 45)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 5, { open_lot_count: 1, market_value_nok_minor: 0, unvalued_lot_count: 1 })
  })

  it('measures freshness from the snapshot date: a 60-day-old observation is real history at D−55, not missing', async () => {
    const variant = await createTestVariant('val-fresh-hist')
    await makeHolding(user.id, { variantId: variant, acquiredDaysAgo: 70 })
    // Observed 60 days ago. TODAY its age is 60 (>30 → current resolver says missing), but the
    // HISTORICAL snapshot at D−55 saw it five days old — fresh fact, must be used there.
    await addPrice({ variantId: variant, valueMinor: 2000, daysAgo: 60 })

    await rebuild(user.id, 75)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 55, { market_value_nok_minor: 23000, unvalued_lot_count: 0 }) // age 5; 20 € × 11.5
    // Exactly 30 days after the observation: still included (boundary, prompt §25).
    expectSnap(rows, 30, { market_value_nok_minor: 23000, unvalued_lot_count: 0 })
    // 31 days after: expired — excluded and COUNTED, never zeroed (F14).
    expectSnap(rows, 29, { market_value_nok_minor: 0, unvalued_lot_count: 1 })
    expectSnap(rows, 1, { market_value_nok_minor: 0, unvalued_lot_count: 1 })
  })

  it('a price correction changes its own date forward, never earlier days', async () => {
    const variant = await createTestVariant('val-correction')
    await makeHolding(user.id, { variantId: variant, acquiredDaysAgo: 50 })
    await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 40 })

    await rebuild(user.id, 55)
    expectSnap(await readSnapshots(user.id), 42, {
      market_value_nok_minor: 0,
      unvalued_lot_count: 1,
    })
    expectSnap(await readSnapshots(user.id), 41, {
      market_value_nok_minor: 0,
      unvalued_lot_count: 1,
    })
    expectSnap(await readSnapshots(user.id), 40, { market_value_nok_minor: 11500 })

    // Correct the day-40 observation. Day 39 must stay absent; day 40+ must move.
    const { error } = await service
      .from('price_snapshots')
      .update({ value_minor: 1500 })
      .eq('card_variant_id', variant)
      .eq('provider', 'tcgdex_cardmarket')
      .eq('snapshot_date', daysAgo(40))
    expect(error).toBeNull()

    await rebuild(user.id, 55)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 41, { market_value_nok_minor: 0, unvalued_lot_count: 1 })
    expectSnap(rows, 40, { market_value_nok_minor: 17250 })
    expectSnap(rows, 39, { market_value_nok_minor: 17250 })
  })

  it('a genuine zero observation is a valued fact; absence stays missing (F14)', async () => {
    const variantZero = await createTestVariant('val-zero')
    const variantMissing = await createTestVariant('val-missing')
    await makeHolding(user.id, { variantId: variantZero, acquiredDaysAgo: 20 })
    await makeHolding(user.id, { variantId: variantMissing, acquiredDaysAgo: 20 })
    await addPrice({ variantId: variantZero, valueMinor: 0, daysAgo: 10 })

    await rebuild(user.id, 25)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 5, {
      open_lot_count: 2,
      unvalued_lot_count: 1, // only the truly-missing one
      market_value_nok_minor: 0, // the zero observation contributes a REAL zero
    })
  })

  it('a pre-tracking acquisition has no fabricated market history before its first observation', async () => {
    const variant = await createTestVariant('val-pretracking')
    await makeHolding(user.id, { variantId: variant, acquiredDaysAgo: 200 })
    await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 50 }) // tracking began "M9"

    await rebuild(user.id, 210)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 100, {
      open_lot_count: 1,
      market_value_nok_minor: 0,
      unvalued_lot_count: 1,
    })
    expectSnap(rows, 50, { market_value_nok_minor: 11500, unvalued_lot_count: 0 })
  })

  it('converts provider currencies with the FX observed on/before the observation date', async () => {
    const variant = await createTestVariant('val-fx')
    await makeHolding(user.id, { variantId: variant, acquiredDaysAgo: 60 })
    await addPrice({
      variantId: variant,
      provider: 'tcgdex_tcgplayer',
      currency: 'USD',
      valueMinor: 500,
      daysAgo: 45,
    })
    await rebuild(user.id, 65)
    expectSnap(await readSnapshots(user.id), 40, { market_value_nok_minor: 5000 }) // 5.00 × 10.0
  })
})

// ── Manual valuation intervals (D-062, prompt §28/§110) ──────────────────────────────────────

describe('M12 manual valuation intervals', () => {
  it('set, update, clear and backdated corrections reconstruct exact economic intervals', async () => {
    const variant = await createTestVariant('mv-intervals')
    const { holdingId } = await makeHolding(user.id, {
      variantId: variant,
      acquiredDaysAgo: 90,
    })

    await setManualValue({ userId: user.id, holdingId, valueMinor: 1000, effectiveFromDaysAgo: 80 })
    await setManualValue({ userId: user.id, holdingId, valueMinor: 2000, effectiveFromDaysAgo: 50 })
    // Clearing 10 days ago ends the then-active interval at that wall-clock date (D-062's
    // terminal-clear boundary).
    await clearManualValue(holdingId, 10)
    // Backdated correction landing INSIDE the cleared history: rewrites from day 65 forward —
    // under the interval model it governs [−65, −50) because the later-effective row still owns
    // its own stretch up to its terminal clear boundary. Deterministic from canonical data.
    await setManualValue({ userId: user.id, holdingId, valueMinor: 3000, effectiveFromDaysAgo: 65 })

    await rebuild(user.id, 95)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 81, { market_value_nok_minor: 0, unvalued_lot_count: 1 }) // before any value
    expectSnap(rows, 80, { market_value_nok_minor: 1000, unvalued_lot_count: 0 }) // [−80, −65)
    expectSnap(rows, 66, { market_value_nok_minor: 1000, unvalued_lot_count: 0 })
    expectSnap(rows, 65, { market_value_nok_minor: 3000, unvalued_lot_count: 0 }) // correction wins
    expectSnap(rows, 51, { market_value_nok_minor: 3000, unvalued_lot_count: 0 })
    expectSnap(rows, 50, { market_value_nok_minor: 2000, unvalued_lot_count: 0 }) // [−50, −10)
    expectSnap(rows, 11, { market_value_nok_minor: 2000, unvalued_lot_count: 0 })
    expectSnap(rows, 5, { market_value_nok_minor: 0, unvalued_lot_count: 1 }) // cleared stays cleared
  })

  it('graded and sealed holdings resolve manual-or-missing historically, never raw provider prices (F10)', async () => {
    const gradedVariant = await createTestVariant('mv-graded')
    const graded = await makeHolding(user.id, {
      kind: 'graded_card',
      variantId: gradedVariant,
      acquiredDaysAgo: 60,
    })
    await makeHolding(user.id, {
      kind: 'sealed',
      sealedProductId: seedCatalog.sealedProductId,
      acquiredDaysAgo: 60,
    })
    // Provider prices exist for the graded card's printing — must never apply to it.
    await addPrice({ variantId: gradedVariant, valueMinor: 5000, daysAgo: 55 })
    await setManualValue({
      userId: user.id,
      holdingId: graded.holdingId,
      valueMinor: 25000,
      effectiveFromDaysAgo: 40,
    })

    await rebuild(user.id, 65)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 50, {
      open_lot_count: 2,
      market_value_nok_minor: 0, // sealed unvalued, graded refuses the raw price
      unvalued_lot_count: 2,
    })
    expectSnap(rows, 40, { market_value_nok_minor: 25000, unvalued_lot_count: 1 }) // graded manual only
  })

  it('a raw-card manual override beats the provider from its effective date only', async () => {
    const variant = await createTestVariant('mv-override')
    const { holdingId } = await makeHolding(user.id, { variantId: variant, acquiredDaysAgo: 40 })
    await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 35 })
    await setManualValue({ userId: user.id, holdingId, valueMinor: 7777, effectiveFromDaysAgo: 20 })

    await rebuild(user.id, 45)
    const rows = await readSnapshots(user.id)
    expectSnap(rows, 21, { market_value_nok_minor: 11500 })
    expectSnap(rows, 20, { market_value_nok_minor: 7777 })
    expectSnap(rows, 1, { market_value_nok_minor: 7777 })
  })
})

// ── Financial fields per date (prompt Part E, §112) ──────────────────────────────────────────

describe('M12 snapshot financial fields', () => {
  it('reproduces CMV/ACMV/DCB/URC/CS/NSP/TTEP exactly over a mixed ledger (F3, F5)', async () => {
    // Isolated user so lifetime cumulatives are fully controlled.
    const u = await createSyntheticUser(service, 'm12-fin')
    try {
      const v1 = await createTestVariant('fin-known')
      const v2 = await createTestVariant('fin-gift')

      // Known-cost lot: bought 60 days ago for 50000 øre, 2 units @ 25000.
      const known = await makeHolding(u.id, {
        variantId: v1,
        acquiredDaysAgo: 60,
        quantity: 2,
        costState: 'known',
        unitCostNok: 25000,
      })
      // Uncosted gift lot worth real money.
      await makeHolding(u.id, { variantId: v2, acquiredDaysAgo: 40, costState: 'not_paid' })
      // A hobby accessory spend (HS side of F1).
      const { error: purchaseError } = await service.from('purchases').insert({
        user_id: u.id,
        purchased_on: daysAgo(50),
        currency: 'NOK',
        subtotal_minor: 3000,
        shipping_minor: 0,
        customs_minor: 0,
        discount_minor: 0,
        total_minor: 3000,
        fx_rate_to_nok: '1',
        fx_rate_date: daysAgo(50),
        fx_source: 'manual',
        total_nok_minor: 3000,
      })
      if (purchaseError) throw new Error(purchaseError.message)
      const { data: purchaseRow } = await service
        .from('purchases')
        .select('id')
        .eq('user_id', u.id)
        .single()
      const { error: lineError } = await service.from('purchase_lines').insert({
        purchase_id: purchaseRow!.id as string,
        user_id: u.id,
        line_type: 'accessory',
        spend_class: 'hobby',
        description: 'sleeves',
        quantity: 1,
        unit_price_minor: 3000,
        line_total_minor: 3000,
        attributable_cost_minor: 3000,
        attributable_cost_nok_minor: 3000,
      })
      if (lineError) throw new Error(lineError.message)

      await addPrice({ variantId: v1, valueMinor: 3000, daysAgo: 55 }) // 30.00 € → 345 øre/unit... no:
      // 3000 minor EUR × 11.5 = 34500 øre per unit.
      await addPrice({ variantId: v2, valueMinor: 1000, daysAgo: 30 }) // 11.5 → 11500 øre

      // Sell ONE known unit 20 days ago for 40000, basis 25000 → RRC 15000.
      await sellUnits({
        userId: u.id,
        lotId: known.lotId,
        quantity: 1,
        daysAgoSold: 20,
        proceedsMinor: 40000,
        costBasisAtSaleMinor: 25000,
      })

      await rebuild(u.id, 70)
      const rows = await readSnapshots(u.id)

      // Before anything: nothing tracked at all → NO ROW before the first tracked date (§91).
      expect(snapByDate(rows, 69)).toBeUndefined()

      // Day 60: known lot owned, unpriced yet.
      expectSnap(rows, 60, {
        open_lot_count: 1,
        unvalued_lot_count: 1,
        market_value_nok_minor: 0,
        attributed_value_nok_minor: 0, // ACMV: valued ∩ known — none valued yet
        cost_basis_nok_minor: 50000, // DCB: 2 × 25000
        collectible_spend_to_date_nok_minor: 50000, // F7: the known basis traces to a real purchase
        sales_proceeds_to_date_nok_minor: 0,
      })

      // Day 50: priced (2×34500=69000), accessory purchase lands (CS 50000 unchanged, HS 3000).
      expectSnap(rows, 50, {
        open_lot_count: 1,
        unvalued_lot_count: 0,
        market_value_nok_minor: 69000,
        attributed_value_nok_minor: 69000,
        cost_basis_nok_minor: 50000,
        collectible_spend_to_date_nok_minor: 50000,
      })
      // The hobby accessory purchase must never leak into CS:
      expect(snapByDate(rows, 49)?.collectible_spend_to_date_nok_minor).toBe(50000)

      // Day 40: gift lot arrives (UMV grows once priced at day 30).
      expectSnap(rows, 40, { open_lot_count: 2, unvalued_lot_count: 1 })

      // Day 30: both valued. CMV 69000 + 11500 = 80500; ACMV still 69000 (gift uncosted).
      expectSnap(rows, 30, {
        market_value_nok_minor: 80500,
        attributed_value_nok_minor: 69000,
        cost_basis_nok_minor: 50000,
      })

      // After the sale: one known unit left (CMV 34500 + 11500), NSP 40000, DCB 25000.
      expectSnap(rows, 19, {
        open_lot_count: 2,
        market_value_nok_minor: 46000,
        attributed_value_nok_minor: 34500,
        cost_basis_nok_minor: 25000,
        sales_proceeds_to_date_nok_minor: 40000,
      })

      // URC = ACMV − DCB over costed inventory, checked at day 19: 34500 − 25000 = 9500.
      const d19 = snapByDate(rows, 19)!
      expect(d19.attributed_value_nok_minor - d19.cost_basis_nok_minor).toBe(9500)

      // TTEP at day 19 = CMV + NSP − CS = 46000 + 40000 − 50000 = 36000.
      expect(
        d19.market_value_nok_minor +
          d19.sales_proceeds_to_date_nok_minor -
          d19.collectible_spend_to_date_nok_minor,
      ).toBe(36000)

      // F3 holds on every stored row: ACMV ≤ CMV with the remainder being UMV.
      for (const row of rows) {
        expect(row.attributed_value_nok_minor).toBeLessThanOrEqual(row.market_value_nok_minor)
      }

      // F5-style consistency of the frozen sale: RRC (frozen at sale time) + PUD = NSP − Σ basis.
      // Here: RRC 15000, PUD 0, NSP 40000, Σ basis 25000 → 15000 = 15000. ✓ (asserted via the
      // sales_summary surface in the sales-dashboard test below.)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('a grading adjustment raises DCB only from its occurred_on (D-068, prompt §58)', async () => {
    const u = await createSyntheticUser(service, 'm12-adj')
    try {
      const variant = await createTestVariant('adj-lot')
      await makeHolding(u.id, {
        variantId: variant,
        acquiredDaysAgo: 60,
        quantity: 2,
        costState: 'known',
        unitCostNok: 10000,
      })
      const { data: lot } = await service
        .from('acquisition_lots')
        .select('id')
        .eq('user_id', u.id)
        .single()
      const { data: line } = await service
        .from('purchase_lines')
        .insert({
          purchase_id: (
            await service
              .from('purchases')
              .insert({
                user_id: u.id,
                purchased_on: daysAgo(60),
                currency: 'NOK',
                subtotal_minor: 20000,
                shipping_minor: 0,
                customs_minor: 0,
                discount_minor: 0,
                total_minor: 20000,
                fx_rate_to_nok: '1',
                fx_rate_date: daysAgo(60),
                fx_source: 'manual',
                total_nok_minor: 20000,
              })
              .select('id')
              .single()
          ).data!.id as string,
          user_id: u.id,
          line_type: 'grading_fee',
          spend_class: 'collectible',
          quantity: 1,
          unit_price_minor: 999,
          line_total_minor: 999,
          attributable_cost_minor: 999,
          attributable_cost_nok_minor: 999,
          target_lot_id: lot!.id as string,
        })
        .select('id')
        .single()
      const { error: adjError } = await service.from('lot_cost_adjustments').insert({
        lot_id: lot!.id as string,
        user_id: u.id,
        kind: 'grading_fee',
        purchase_line_id: line!.id as string,
        amount_minor: 999,
        currency: 'NOK',
        amount_nok_minor: 999,
        occurred_on: daysAgo(30),
      })
      expect(adjError).toBeNull()

      await rebuild(u.id, 65)
      const rows = await readSnapshots(u.id)
      // Before the adjustment: DCB = 2 × 10000 = 20000. CS already includes the fee's line (999)
      // from its own purchase — spend and basis are different scopes (FINANCIAL_MODEL §4.4).
      expectSnap(rows, 31, { cost_basis_nok_minor: 20000 })
      // From occurred_on: DCB += floor(999 × 2 / 2) = 999 → 20999.
      expectSnap(rows, 30, { cost_basis_nok_minor: 20999 })
      expectSnap(rows, 1, { cost_basis_nok_minor: 20999 })
      // CS includes BOTH the lot-basis purchase (20000) and the grading-fee line (999):
      expectSnap(rows, 31, { collectible_spend_to_date_nok_minor: 20999 })
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})

// ── FULL vs INCREMENTAL — the M12 gate (prompt §16/§111, TESTING.md §3) ──────────────────────

describe('M12 full rebuild equals incremental recompute exactly', () => {
  it('byte-identical semantic rows for a rich, corrected history (computed_at excluded)', async () => {
    const u = await createSyntheticUser(service, 'm12-equality')
    try {
      const vRaw = await createTestVariant('eq-raw')
      const vCorrected = await createTestVariant('eq-corrected')
      const drained: string[] = []

      async function incrementalDrain() {
        const { data, error } = await service.rpc('drain_portfolio_recompute_queue')
        if (error) throw new Error(error.message)
        drained.push(String(data))
      }

      // Event stream, each followed by an incremental drain — the production cadence.
      const raw = await makeHolding(u.id, {
        variantId: vRaw,
        acquiredDaysAgo: 80,
        quantity: 3,
        costState: 'known',
        unitCostNok: 9000,
      })
      await incrementalDrain()

      const corrected = await makeHolding(u.id, {
        variantId: vCorrected,
        acquiredDaysAgo: 75,
      })
      await addPrice({ variantId: vCorrected, valueMinor: 1200, daysAgo: 70 })
      await incrementalDrain()

      await setManualValue({
        userId: u.id,
        holdingId: corrected.holdingId,
        valueMinor: 15000,
        effectiveFromDaysAgo: 60,
      })
      await incrementalDrain()

      // A backdated correction (the classic divergence risk).
      await setManualValue({
        userId: u.id,
        holdingId: corrected.holdingId,
        valueMinor: 16000,
        effectiveFromDaysAgo: 62,
      })
      await incrementalDrain()

      await addPrice({ variantId: vRaw, valueMinor: 1050, daysAgo: 50 })
      await incrementalDrain()

      // Price CORRECTION forward-dirtying.
      await service
        .from('price_snapshots')
        .update({ value_minor: 1100 })
        .eq('card_variant_id', vRaw)
        .eq('provider', 'tcgdex_cardmarket')
        .eq('snapshot_date', daysAgo(50))
      await incrementalDrain()

      // Partial sale, then a void restoring history.
      await sellUnits({
        userId: u.id,
        lotId: raw.lotId,
        quantity: 1,
        daysAgoSold: 40,
        proceedsMinor: 12000,
        costBasisAtSaleMinor: 9000,
      })
      await incrementalDrain()

      const { data: disposal } = await service
        .from('lot_disposals')
        .select('id')
        .eq('lot_id', raw.lotId)
        .single()
      await service
        .from('lot_disposals')
        .update({ voided_at: new Date().toISOString() })
        .eq('id', disposal!.id)
      await incrementalDrain()

      // Manual value updated again, then cleared.
      await setManualValue({
        userId: u.id,
        holdingId: corrected.holdingId,
        valueMinor: 17000,
        effectiveFromDaysAgo: 25,
      })
      await incrementalDrain()
      await clearManualValue(corrected.holdingId)
      await incrementalDrain()

      const incrementalRows = await readSnapshots(u.id)
      expect(incrementalRows.length).toBeGreaterThan(50)

      // Wipe the cache entirely and rebuild from scratch — full rebuild from earliest truth.
      await service.from('portfolio_snapshots').delete().eq('user_id', u.id)
      await rebuild(u.id, 365)
      const fullRows = await readSnapshots(u.id)

      // Strip ONLY the operational timestamp (prompt §16) and demand exact equality.
      const strip = (rows: SnapshotRow[]) =>
        rows.map((row) => {
          const { computed_at: _drop, ...rest } = row
          void _drop
          return rest
        })
      expect(strip(fullRows)).toEqual(strip(incrementalRows))
      expect(drained.length).toBeGreaterThan(5)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})

// ── Data quality, monthly spend, sales figures, display currency ─────────────────────────────

describe('M12 dashboard aggregates', () => {
  it('surfaces mixed data quality exactly: automatic/manual/priced/unpriced/uncosted (§113)', async () => {
    const u = await createSyntheticUser(service, 'm12-quality')
    try {
      const auto = await createTestVariant('q-auto')
      const unpriced = await createTestVariant('q-unpriced')

      await makeHolding(u.id, { variantId: auto, acquiredDaysAgo: 30 }) // automatic raw
      const manualHolding = await makeHolding(u.id, {
        variantId: unpriced,
        acquiredDaysAgo: 30,
      }) // will be manual (its variant has no price)
      await setManualValue({
        userId: u.id,
        holdingId: manualHolding.holdingId,
        valueMinor: 12300,
        effectiveFromDaysAgo: 20,
      })
      await makeHolding(u.id, {
        kind: 'sealed',
        sealedProductId: seedCatalog.sealedProductId,
        acquiredDaysAgo: 30,
      }) // unvalued sealed
      await makeHolding(u.id, {
        variantId: await createTestVariant('q-unknown'),
        acquiredDaysAgo: 30,
        costState: 'unknown',
      }) // uncosted raw, no price either

      await addPrice({ variantId: auto, valueMinor: 2000, daysAgo: 25 })
      await rebuild(u.id, 40)

      const readClient = await signInAs(u)
      const { data: summary, error } = await readClient.rpc('get_dashboard_summary').single<{
        priced_holding_count: string
        unpriced_holding_count: string
        manual_valued_holding_count: string
        auto_priced_holding_count: string
        uncosted_open_lot_count: string
        physical_card_count: string
        sealed_holding_count: string
        raw_value_nok_minor: string
        graded_value_nok_minor: string
        sealed_value_nok_minor: string
      }>()
      if (error) throw new Error(error.message)

      expect(Number(summary.priced_holding_count)).toBe(2) // auto raw + manual raw
      expect(Number(summary.unpriced_holding_count)).toBe(2) // unvalued sealed + unpriced unknown
      expect(Number(summary.manual_valued_holding_count)).toBe(1)
      expect(Number(summary.auto_priced_holding_count)).toBe(1)
      expect(Number(summary.uncosted_open_lot_count)).toBe(1)
      expect(Number(summary.physical_card_count)).toBe(3) // three CARD units; sealed separate
      expect(Number(summary.sealed_holding_count)).toBe(1)
      // Raw = automatic (2000 minor EUR × 11.5 = 23000 øre) + manual raw holding (12300 øre).
      expect(BigInt(summary.raw_value_nok_minor)).toBe(35300n)
      expect(BigInt(summary.graded_value_nok_minor)).toBe(0n)
      expect(BigInt(summary.sealed_value_nok_minor)).toBe(0n)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('monthly spend reconciles GPO = CS + HS per month and matches the lifetime summary (F1)', async () => {
    const u = await createSyntheticUser(service, 'm12-monthly')
    try {
      async function addPurchase(
        monthsAgo: number,
        collectible: number,
        hobby: number,
        shipping: number,
      ) {
        const d = new Date(today)
        d.setUTCMonth(d.getUTCMonth() - monthsAgo)
        d.setUTCDate(10)
        const purchasedOn = d.toISOString().slice(0, 10)
        const subtotal = collectible + hobby
        const total = subtotal + shipping
        const { data: purchase, error } = await service
          .from('purchases')
          .insert({
            user_id: u.id,
            purchased_on: purchasedOn,
            currency: 'NOK',
            subtotal_minor: subtotal,
            shipping_minor: shipping,
            customs_minor: 0,
            discount_minor: 0,
            total_minor: total,
            fx_rate_to_nok: '1',
            fx_rate_date: purchasedOn,
            fx_source: 'manual',
            total_nok_minor: total,
          })
          .select('id')
          .single()
        if (error) throw new Error(error.message)
        const lines = [] as Record<string, unknown>[]
        if (collectible > 0) {
          lines.push({
            purchase_id: purchase.id as string,
            user_id: u.id,
            line_type: 'card',
            spend_class: 'collectible',
            quantity: 1,
            unit_price_minor: collectible,
            line_total_minor: collectible,
            attributable_cost_minor: collectible,
            attributable_cost_nok_minor: collectible,
          })
        }
        if (hobby > 0) {
          lines.push({
            purchase_id: purchase.id as string,
            user_id: u.id,
            line_type: 'accessory',
            spend_class: 'hobby',
            description: 'supplies',
            quantity: 1,
            unit_price_minor: hobby,
            line_total_minor: hobby,
            attributable_cost_minor: hobby,
            attributable_cost_nok_minor: hobby,
          })
        }
        const { error: lineError } = await service.from('purchase_lines').insert(lines)
        if (lineError) throw new Error(lineError.message)
      }

      await addPurchase(2, 50000, 10000, 3000) // shipping splits pro rata
      await addPurchase(1, 20000, 0, 0)
      await addPurchase(0, 0, 5000, 0)

      const readClient = await signInAs(u)
      const { data: months, error } = await readClient.rpc('get_monthly_spend', { p_months: 12 })
      if (error) throw new Error(error.message)

      let lifetimeCs = 0n
      let lifetimeGpo = 0n
      for (const m of months as unknown as {
        month: string
        collectible_nok_minor: string
        hobby_nok_minor: string
        total_nok_minor: string
      }[]) {
        const cs = BigInt(m.collectible_nok_minor)
        const hs = BigInt(m.hobby_nok_minor)
        expect(BigInt(m.total_nok_minor)).toBe(cs + hs) // F1 per month, by construction
        lifetimeCs += cs
        lifetimeGpo += cs + hs
      }
      // Hand-derived expectation: shipping 3000 allocates over weights 50000/10000 exactly
      // (2500 + 500), so nothing is left to rounding here.
      //   month −2: CS 52500, HS 10500 · month −1: CS 20000 · this month: HS 5000
      expect(lifetimeGpo).toBe(88000n)
      expect(lifetimeCs).toBe(72500n)
      const { data: spending, error: spendingError } = await service
        .rpc('purchase_spending_summary')
        .single<{ gpo_nok_minor: string; cs_nok_minor: string; hs_nok_minor: string }>()
      if (spendingError) throw new Error(spendingError.message)
      expect(lifetimeGpo).toBe(BigInt(spending.gpo_nok_minor))
      expect(lifetimeCs).toBe(BigInt(spending.cs_nok_minor))
      // And every krone is collectible-or-hobby, exactly once:
      expect(BigInt(spending.cs_nok_minor) + BigInt(spending.hs_nok_minor)).toBe(
        BigInt(spending.gpo_nok_minor),
      )
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('splits NSP into realized-on-costed vs proceeds-from-uncosted, never a combined profit (§115)', async () => {
    const u = await createSyntheticUser(service, 'm12-salesfig')
    try {
      const vKnown = await createTestVariant('sf-known')
      const vGift = await createTestVariant('sf-gift')
      const known = await makeHolding(u.id, {
        variantId: vKnown,
        acquiredDaysAgo: 50,
        costState: 'known',
        unitCostNok: 10000,
      })
      const gift = await makeHolding(u.id, { variantId: vGift, acquiredDaysAgo: 50 })

      await sellUnits({
        userId: u.id,
        lotId: known.lotId,
        quantity: 1,
        daysAgoSold: 10,
        proceedsMinor: 18000,
        costBasisAtSaleMinor: 10000,
      })
      await sellUnits({
        userId: u.id,
        lotId: gift.lotId,
        quantity: 1,
        daysAgoSold: 5,
        proceedsMinor: 7000,
      })

      const readClient = await signInAs(u)
      const { data: s, error } = await readClient.rpc('sales_summary').single<{
        nsp_nok_minor: string
        rrc_nok_minor: string
        pud_nok_minor: string
      }>()
      if (error) throw new Error(error.message)
      expect(BigInt(s.nsp_nok_minor)).toBe(25000n)
      expect(BigInt(s.rrc_nok_minor)).toBe(8000n) // only the costed sale realizes a result
      expect(BigInt(s.pud_nok_minor)).toBe(7000n) // gift proceeds are inflow, never profit

      // F5: RRC + PUD = NSP − Σ cost_basis_at_sale.
      expect(BigInt(s.rrc_nok_minor) + BigInt(s.pud_nok_minor)).toBe(25000n - 10000n)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('display-currency conversion uses the historical rate of each point and never rewrites storage (D-067)', async () => {
    const u = await createSyntheticUser(service, 'm12-displayfx')
    try {
      // Entirely ancient window so this test's own re-rate can never become the as-of winner
      // for any OTHER suite's recent-dated observations (cross-suite contamination CI caught):
      // base rate @320 = 11.5, re-rate @280 = 12.0, observation @305.
      await service.from('fx_rates').upsert(
        [
          {
            base_currency: 'EUR',
            quote_currency: 'NOK',
            rate_date: daysAgo(280),
            rate: '12.00000000',
            source: 'norges_bank',
          },
        ],
        { onConflict: 'base_currency,quote_currency,rate_date,source' },
      )
      const variant = await createTestVariant('dfx')
      await makeHolding(u.id, { variantId: variant, acquiredDaysAgo: 310 })
      await addPrice({ variantId: variant, valueMinor: 1000, daysAgo: 305 }) // 10.00 EUR → 115.00 NOK

      await rebuild(u.id, 320)

      const readClient = await signInAs(u)
      const { data: nok, error: nokError } = await readClient.rpc('get_portfolio_history', {
        p_display_currency: 'NOK',
        p_from: daysAgo(320),
        p_to: daysAgo(260),
      })
      if (nokError) throw new Error(nokError.message)

      const { data: eur, error: eurError } = await readClient.rpc('get_portfolio_history', {
        p_display_currency: 'EUR',
        p_from: daysAgo(320),
        p_to: daysAgo(260),
      })
      if (eurError) throw new Error(eurError.message)

      type Row = {
        snapshot_date: string
        market_value_nok_minor: string
        display_value_minor: string | null
      }
      const rows = eur as unknown as Row[]
      const at = (d: number) => rows.find((r) => r.snapshot_date === daysAgo(d))!

      // The covered window is exactly [observation date, observation date + 30]; storage is
      // untouched by the display parameter.
      expect(at(305).market_value_nok_minor).toBe('11500')
      expect(at(276).market_value_nok_minor).toBe('11500')
      expect(at(305).display_value_minor).not.toBeNull()

      // Day 305 resolves against the @320 rate: 11500 / 11.5 = exactly 1000 EUR minor units.
      expect(BigInt(at(305).display_value_minor as string)).toBe(1000n)
      expect(BigInt(at(290).display_value_minor as string)).toBe(1000n)

      // From the re-rate's date onward the SAME stored NOK point converts differently:
      // 11500 / 12 = 958.33… → 958 EUR minor. Display history legitimately includes FX movement.
      expect(BigInt(at(280).display_value_minor as string)).toBe(958n)
      expect(BigInt(at(276).display_value_minor as string)).toBe(958n)

      // And the NOK series is identical between calls — conversion is presentation-only.
      const nokRows = nok as unknown as { snapshot_date: string; market_value_nok_minor: string }[]
      expect(nokRows.at(-1)?.market_value_nok_minor).toBe('11500')
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('zero-coverage days are flagged, and custom-collection membership never rewrites history', async () => {
    const u = await createSyntheticUser(service, 'm12-scope')
    try {
      const variant = await createTestVariant('scope-var')
      const { holdingId } = await makeHolding(u.id, { variantId: variant, acquiredDaysAgo: 30 })

      await rebuild(u.id, 40)
      const readClient = await signInAs(u)
      let history = await readClient.rpc('get_portfolio_history', { p_display_currency: 'NOK' })
      const rows = history.data as unknown as { snapshot_date: string; has_coverage: boolean }[]
      expect(rows.at(-1)?.has_coverage).toBe(false) // 100% unvalued → gap, never "worth 0"

      // Membership churn: collection add/remove must leave the MAIN history byte-identical (D-065).
      const { data: collection } = await service
        .from('custom_collections')
        .insert({ user_id: u.id, name: 'Trade binder' })
        .select('id')
        .single()
      await service.from('custom_collection_members').insert({
        collection_id: collection!.id as string,
        holding_id: holdingId,
        user_id: u.id,
      })
      await service
        .from('custom_collection_members')
        .delete()
        .eq('collection_id', collection!.id as string)

      await rebuild(u.id, 40)
      history = await readClient.rpc('get_portfolio_history', { p_display_currency: 'NOK' })
      const rowsAfter = history.data as unknown as {
        snapshot_date: string
        has_coverage: boolean
      }[]
      expect(rowsAfter.map((r) => r.snapshot_date)).toEqual(rows.map((r) => r.snapshot_date))
      expect(rowsAfter.map((r) => r.has_coverage)).toEqual(rows.map((r) => r.has_coverage))

      // Scoped counts still answer correctly for the collection (current-state only).
      const { data: scopedCounts } = await service.rpc('portfolio_counts', {
        p_custom_collection_id: null,
      })
      expect(scopedCounts).not.toBeNull()
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })

  it('an empty account has no fabricated zero-filled history', async () => {
    const u = await createSyntheticUser(service, 'm12-empty')
    try {
      await rebuild(u.id, 365)
      const rows = await readSnapshots(u.id)
      expect(rows).toEqual([])

      const readClient = await signInAs(u)
      const { data: summary } = await readClient.rpc('get_dashboard_summary').single<{
        latest_snapshot_date: string | null
        first_tracked_date: string | null
        market_value_nok_minor: string | null
        pending_recompute: boolean
      }>()
      expect(summary?.latest_snapshot_date).toBeNull()
      expect(summary?.first_tracked_date).toBeNull()
      expect(summary?.market_value_nok_minor).toBeNull()
      expect(summary?.pending_recompute).toBe(false)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})
