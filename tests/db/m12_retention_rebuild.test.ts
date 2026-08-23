import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M9.1 retention × M12 rebuild — the cross-milestone gate (DECISIONS.md D-070).
 *
 * thin_price_snapshots() compacts dense daily provider observations older than 60 days to one
 * survivor per ISO week. Those deleted rows were canonical facts when a historical snapshot was
 * first computed, so after compaction the SAME historical day legitimately derives from the
 * remaining weekly facts — portfolio_snapshots is a REBUILDABLE CACHE relative to CURRENTLY
 * RETAINED canonical facts, not a frozen ledger (D-070). This test proves the whole loop in one
 * database: dense history → snapshot built → real thinning runs → invalidation fires → drain
 * recomputes → cache equals a from-scratch rebuild over the retained facts, while every frozen
 * ledger figure stays byte-identical and no valued day ever collapses into fabricated zero or
 * missing.
 *
 * Determinism across calendar weekdays comes from Monday-aligned week anchors (the technique
 * m91_retention.test.ts established): "same ISO week" here can never drift from Postgres's own
 * date_trunc('week', ...), so exactly which observation survives thinning is known in advance
 * and the before/after values below are fixed integers, not ranges.
 *
 * Runs after the M10 fixtures in file order but BEFORE m91_retention reseeds its own data;
 * thinning touches the whole table, which is why every assertion here is scoped to this suite's
 * own synthetic variant and user.
 */

let service: TestClient
let user: SyntheticUser

/** Monday (UTC) of the ISO week containing `d` — matches date_trunc('week', ...) in Postgres. */
function mondayOf(d: Date): Date {
  const m = new Date(d)
  const dow = (m.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  m.setUTCDate(m.getUTCDate() - dow)
  m.setUTCHours(0, 0, 0, 0)
  return m
}

function addDays(d: Date, days: number): Date {
  const c = new Date(d)
  c.setUTCDate(c.getUTCDate() + days)
  return c
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

const today = new Date()
const thisWeek = mondayOf(today)
// Two distinct full weeks, entirely older than the 60-day daily-retention window:
const olderWeek = addDays(thisWeek, -77) // Monday, ~11 weeks ago
const denseWeek = addDays(thisWeek, -70) // Monday, ~10 weeks ago

// Observation plan for ONE variant (EUR, factor 11.5 → NOK minor = value × 11.5):
//   olderWeek+3 (Thu): 800   — survives as its week's only/latest observation
//   denseWeek+1 (Tue): 900   — thinned (denseWeek's survivor is Friday)
//   denseWeek+3 (Thu): 900   — thinned
//   denseWeek+5 (Fri): 1200  — survives as denseWeek's latest observation
//
// Target day D* = denseWeek+4: pre-thinning it resolves against denseWeek+3 (age 1) = 900 ×
// 11.5 = 10350; after thinning that row is gone and D* falls back to olderWeek+3 (age 11, well
// inside the 30-day freshness window) = 800 × 11.5 = 9200. The one-time compaction adjustment,
// exactly as D-070 accepts it. The survivor's own day (denseWeek+5) keeps 13800 throughout —
// facts that survive keep their derivations stable.

let variantId: string

async function seedPrice(valueMinor: number, onIso: string): Promise<void> {
  const { error } = await service.from('price_snapshots').insert({
    card_variant_id: variantId,
    provider: 'tcgdex_cardmarket',
    price_kind: 'cm_trend',
    source_currency: 'EUR',
    value_minor: valueMinor,
    snapshot_date: onIso,
    provider_updated_at: `${onIso}T12:00:00Z`,
  })
  if (error) throw new Error(error.message)
}

async function priceRowCount(): Promise<number> {
  const { count, error } = await service
    .from('price_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('card_variant_id', variantId)
    .eq('provider', 'tcgdex_cardmarket')
  if (error) throw new Error(error.message)
  return count ?? 0
}

interface SemanticRow {
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

async function readRows(): Promise<SemanticRow[]> {
  const { data, error } = await service
    .from('portfolio_snapshots')
    .select('*')
    .eq('user_id', user.id)
    .order('snapshot_date')
  if (error) throw new Error(error.message)
  return data
}

function rowAt(rows: SemanticRow[], d: Date): SemanticRow {
  const target = iso(d)
  const row = rows.find((r) => r.snapshot_date === target)
  if (!row) throw new Error(`no snapshot row for ${target}`)
  return row
}

async function rebuild(fromDaysAgo: number): Promise<void> {
  const f = new Date(today)
  f.setUTCDate(f.getUTCDate() - fromDaysAgo)
  const { error } = await service.rpc('rebuild_portfolio_snapshots', {
    p_user_id: user.id,
    p_from: iso(f),
    p_through: iso(today),
  })
  if (error) throw new Error(error.message)
}

beforeAll(async () => {
  service = createServiceClient()

  // Ancient FX fact — older than every observation this suite inserts, and dated outside every
  // other suite's EUR window so the as-of lookup resolves HERE deterministically.
  const { error: fxError } = await service.from('fx_rates').upsert(
    {
      base_currency: 'EUR',
      quote_currency: 'NOK',
      rate_date: iso(addDays(thisWeek, -120)),
      rate: '11.50000000',
      source: 'norges_bank',
    },
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
  if (fxError) throw new Error(fxError.message)

  // A private catalog card unique to this run (per-run UUIDs keep price_snapshots' unique key
  // collision-free across suites sharing the stack), under the shared seed set.
  const cardId = crypto.randomUUID()
  variantId = crypto.randomUUID()
  const { error: cardError } = await service.from('cards').insert({
    id: cardId,
    set_id: seedCatalog.cardSetId,
    local_id: 'm12retention',
    name: 'M12 Retention Interaction',
    language: 'en',
  })
  if (cardError) throw new Error(cardError.message)
  const { error: variantError } = await service.from('card_variants').insert({
    id: variantId,
    card_id: cardId,
    finish: 'normal',
  })
  if (variantError) throw new Error(variantError.message)
})

beforeEach(async () => {
  user = await createSyntheticUser(service, 'm12-retention')
})

afterEach(async () => {
  await deleteSyntheticUser(service, user.id)
})

afterAll(async () => {
  // The synthetic catalog variant is deliberately left in place — shared-catalog cleanup would
  // race parallel CI workers for zero benefit; rows are inert without a user.
})

describe('M9.1 thinning × M12 rebuild (D-070)', () => {
  it('compaction adjusts an older CMV point once, from retained weekly facts, with the frozen ledger untouched and the cache still fully rebuildable', async () => {
    // ── Canonical state: one known-cost raw-card lot plus the dense/weekly observation plan ──
    const holdingId = crypto.randomUUID()
    const { error: holdingError } = await service.from('holdings').insert({
      id: holdingId,
      user_id: user.id,
      holding_kind: 'raw_card',
      card_variant_id: variantId,
      condition: 'NM',
      grading_state: 'raw',
    })
    if (holdingError) throw new Error(holdingError.message)

    const purchaseTotal = 5000
    const { data: purchase, error: purchaseError } = await service
      .from('purchases')
      .insert({
        user_id: user.id,
        purchased_on: iso(olderWeek),
        currency: 'NOK',
        subtotal_minor: purchaseTotal,
        shipping_minor: 0,
        customs_minor: 0,
        discount_minor: 0,
        total_minor: purchaseTotal,
        fx_rate_to_nok: '1',
        fx_rate_date: iso(olderWeek),
        fx_source: 'manual',
        total_nok_minor: purchaseTotal,
      })
      .select('id')
      .single()
    if (purchaseError) throw new Error(purchaseError.message)
    const { data: line, error: lineError } = await service
      .from('purchase_lines')
      .insert({
        purchase_id: purchase.id,
        user_id: user.id,
        line_type: 'bulk_lot',
        spend_class: 'collectible',
        description: 'm12 retention fixture basis',
        quantity: 1,
        unit_price_minor: purchaseTotal,
        line_total_minor: purchaseTotal,
        attributable_cost_minor: purchaseTotal,
        attributable_cost_nok_minor: purchaseTotal,
      })
      .select('id')
      .single()
    if (lineError) throw new Error(lineError.message)

    const lotId = crypto.randomUUID()
    const { error: lotError } = await service.from('acquisition_lots').insert({
      id: lotId,
      holding_id: holdingId,
      user_id: user.id,
      origin: 'purchase',
      cost_basis_state: 'unknown', // promoted below once the backing line exists
      acquired_on: iso(olderWeek),
      quantity: 1,
      quantity_remaining: 1,
    })
    if (lotError) throw new Error(lotError.message)
    const { error: promoteError } = await service
      .from('acquisition_lots')
      .update({
        cost_basis_state: 'known',
        unit_cost_basis_minor: purchaseTotal,
        unit_cost_basis_nok_minor: purchaseTotal,
        residual_nok_minor: 0,
        purchase_line_id: line.id,
      })
      .eq('id', lotId)
    if (promoteError) throw new Error(promoteError.message)

    await seedPrice(800, iso(addDays(olderWeek, 3)))
    await seedPrice(900, iso(addDays(denseWeek, 1)))
    await seedPrice(900, iso(addDays(denseWeek, 3)))
    await seedPrice(1200, iso(addDays(denseWeek, 5)))

    // ── Snapshot built while the dense facts still exist ──────────────────────────────────────
    await rebuild(200)
    // The fixture's own canonical inserts already queued work; clear the queue so the ONLY
    // dirty marker measured below is the one thinning itself produces.
    const { error: preDrainError } = await service.rpc('drain_portfolio_recompute_queue')
    if (preDrainError) throw new Error(preDrainError.message)

    const preRows = await readRows()

    const dStar = addDays(denseWeek, 4)
    const dSurvivor = addDays(denseWeek, 5)
    const preStar = rowAt(preRows, dStar)
    const preSurvivor = rowAt(preRows, dSurvivor)

    // Deterministic pre-compaction expectations (dense fact still covering D*).
    expect(preStar.market_value_nok_minor).toBe(10350) // 900 × 11.5, from denseWeek+3
    expect(preStar.unvalued_lot_count).toBe(0)
    expect(preSurvivor.market_value_nok_minor).toBe(13800) // 1200 × 11.5, its own day
    // Frozen-ledger figures, recorded for the unchanged-after-compaction assertion.
    expect(preStar.collectible_spend_to_date_nok_minor).toBe(5000)
    expect(preStar.cost_basis_nok_minor).toBe(5000)

    // ── The REAL M9.1 retention job runs ────────────────────────────────────────────────────
    const beforeCount = await priceRowCount()
    expect(beforeCount).toBe(4)
    const { error: thinError } = await service.rpc('thin_price_snapshots')
    if (thinError) throw new Error(thinError.message)
    const afterCount = await priceRowCount()
    expect(afterCount).toBeLessThan(beforeCount)
    // Exactly the planned survivors: the two week-latest observations.
    const { data: survivors, error: survivorsError } = await service
      .from('price_snapshots')
      .select('snapshot_date, value_minor')
      .eq('card_variant_id', variantId)
      .eq('provider', 'tcgdex_cardmarket')
      .order('snapshot_date')
    if (survivorsError) throw new Error(survivorsError.message)
    expect(survivors.map((r) => r.snapshot_date)).toEqual([
      iso(addDays(olderWeek, 3)),
      iso(addDays(denseWeek, 5)),
    ])

    // ── Thinning invalidated history: queued from the oldest deleted observation, then drained ──
    const { data: queueRow, error: queueError } = await service
      .from('portfolio_recompute_queue')
      .select('user_id, dirty_from')
      .eq('user_id', user.id)
      .maybeSingle<{ user_id: string; dirty_from: string }>()
    if (queueError) throw new Error(queueError.message)
    expect(queueRow).not.toBeNull()
    expect(queueRow!.dirty_from).toBe(iso(addDays(denseWeek, 1)))

    const { error: drainError } = await service.rpc('drain_portfolio_recompute_queue')
    if (drainError) throw new Error(drainError.message)
    const { data: queueAfter, error: queueAfterError } = await service
      .from('portfolio_recompute_queue')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (queueAfterError) throw new Error(queueAfterError.message)
    expect(queueAfter).toBeNull()

    // ── The recomputed cache derives from CURRENTLY RETAINED canonical facts ────────────────
    const postRows = await readRows()
    const postStar = rowAt(postRows, dStar)
    const postSurvivor = rowAt(postRows, dSurvivor)

    // The accepted one-time adjustment (D-070): D* now derives from the retained weekly
    // observation olderWeek+3 (800 × 11.5) — changed exactly once, never fabricated.
    expect(postStar.market_value_nok_minor).toBe(9200)
    expect(postStar.unvalued_lot_count).toBe(0) // no zero/missing transition — fallback is real
    // A day whose covering fact SURVIVED keeps its derivation exactly.
    expect(postSurvivor.market_value_nok_minor).toBe(13800)
    expect(postSurvivor.unvalued_lot_count).toBe(0)

    // Frozen ledger semantics untouched by a storage-maintenance job. The invariant set is the
    // FROZEN-LEDGER columns only - spend/proceeds cumulatives, cost basis (lots + adjustments,
    // never prices), and ownership structure. ACMV is deliberately excluded: it is CMV
    // restricted to costed lots, i.e. MARKET-derived, and legitimately moves with compaction -
    // pinned explicitly right below instead.
    const LEDGER_COLUMNS = [
      'cost_basis_nok_minor',
      'collectible_spend_to_date_nok_minor',
      'sales_proceeds_to_date_nok_minor',
      'open_lot_count',
    ] as const
    expect(postRows.length).toBe(preRows.length)
    for (let i = 0; i < postRows.length; i += 1) {
      for (const col of LEDGER_COLUMNS) {
        expect(postRows[i]![col]).toBe(preRows[i]![col])
      }
    }
    // The market-derived columns moved exactly where the covering observation changed:
    expect(postStar.attributed_value_nok_minor).toBe(9200)
    expect(postSurvivor.attributed_value_nok_minor).toBe(13800)

    // ── Cache == full rebuild from the CURRENT retained canonical set (D-070's equality rule) ──
    const strippedPost = postRows.map(({ computed_at: _c, ...rest }) => {
      void _c
      return rest
    })
    await service.from('portfolio_snapshots').delete().eq('user_id', user.id)
    await rebuild(400)
    const rebuiltRows = await readRows()
    const strippedRebuilt = rebuiltRows.map(({ computed_at: _c2, ...rest }) => {
      void _c2
      return rest
    })
    expect(strippedRebuilt).toEqual(strippedPost)

    // And the rebuilt-from-scratch series still carries the retained-fact derivations.
    expect(rowAt(rebuiltRows, dStar).market_value_nok_minor).toBe(9200)
    expect(rowAt(rebuiltRows, dSurvivor).market_value_nok_minor).toBe(13800)
  })
})
