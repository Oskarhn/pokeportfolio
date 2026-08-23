import type { TestClient } from '../../../tests/db/setup'
import { SNAPSHOT_COLUMNS, type SnapshotColumn } from './contract'

/**
 * An INDEPENDENT TypeScript model of the M12 snapshot semantics, derived only from
 * FINANCIAL_MODEL.md §3/§6/§8, DATA_MODEL.md §6, UX_FLOWS.md F10 and the adversarial brief.
 * It shares zero code with the implementation and never trusts derived columns: every input is a
 * canonical fact table row, and every derived figure is recomputed here.
 *
 * Interpretations that are CONTRACT LOCKS rather than safe derivations are marked LOCK below.
 * When the suite fails on one of those, the resolution is a deliberate reconciliation against the
 * implementation branch's decision record (e.g. D-062) — not a silent test edit.
 */

export interface OracleFacts {
  euPricing: boolean
  holdings: Map<string, { kind: string; variantId: string | null }>
  lots: {
    id: string
    holdingId: string
    acquiredOn: string
    quantity: number
    unitCostBasisNokMinor: number | null
    costBasisState: string
    voidedAt: string | null
  }[]
  disposalsByLot: Map<string, { disposedOn: string; quantity: number; voidedAt: string | null }[]>
  collectibleSpendEvents: { date: string; amountNokMinor: number }[]
  proceedsEvents: { date: string; amountNokMinor: number }[]
  manualByHolding: Map<
    string,
    { valueMinor: number; effectiveFrom: string; supersededAt: string | null; createdAt: string }[]
  >
  pricesByVariant: Map<
    string,
    { provider: string; valueMinor: number; snapshotDate: string; currency: string }[]
  >
  fxByCurrency: Map<string, { rateDate: string; rate: number }[]> // rate scaled by 1e8
}

const RATE_SCALE = 100_000_000n

export async function loadFacts(service: TestClient, userId: string): Promise<OracleFacts> {
  const [holdings, lots, disposals, lines, sales, manuals, prices, fx, profile] = await Promise.all(
    [
      service.from('holdings').select('id, holding_kind, card_variant_id').eq('user_id', userId),
      service
        .from('acquisition_lots')
        .select(
          'id, holding_id, acquired_on, quantity, unit_cost_basis_nok_minor, cost_basis_state, voided_at',
        )
        .eq('user_id', userId),
      service
        .from('lot_disposals')
        .select('lot_id, disposed_on, quantity, voided_at')
        .eq('user_id', userId),
      service
        .from('purchase_lines')
        .select(
          'attributable_cost_nok_minor, spend_class, purchases!inner(purchased_on, voided_at, user_id)',
        )
        .eq('purchases.user_id', userId),
      service
        .from('sales')
        .select('sold_on, net_proceeds_nok_minor, voided_at')
        .eq('user_id', userId),
      service
        .from('manual_valuations')
        .select('holding_id, value_minor, effective_from, superseded_at, created_at')
        .eq('user_id', userId),
      service
        .from('price_snapshots')
        .select('card_variant_id, provider, value_minor, snapshot_date, source_currency'),
      service.from('fx_rates').select('base_currency, rate_date, rate'),
      service.from('profiles').select('use_eu_pricing').eq('id', userId).single(),
    ],
  )

  const throwIf = (label: string, e: { message: string } | null) => {
    if (e) throw new Error(`oracle could not load ${label}: ${e.message}`)
  }
  throwIf('holdings', holdings.error)
  throwIf('lots', lots.error)
  throwIf('disposals', disposals.error)
  throwIf('purchase_lines', lines.error)
  throwIf('sales', sales.error)
  throwIf('manual_valuations', manuals.error)
  throwIf('price_snapshots', prices.error)
  throwIf('fx_rates', fx.error)
  throwIf('profiles', profile.error)

  const facts: OracleFacts = {
    euPricing: Boolean(
      (profile.data as { use_eu_pricing: boolean } | null)?.use_eu_pricing ?? true,
    ),
    holdings: new Map(),
    lots: [],
    disposalsByLot: new Map(),
    collectibleSpendEvents: [],
    proceedsEvents: [],
    manualByHolding: new Map(),
    pricesByVariant: new Map(),
    fxByCurrency: new Map(),
  }

  for (const h of holdings.data as unknown as {
    id: string
    holding_kind: string
    card_variant_id: string | null
  }[]) {
    facts.holdings.set(h.id, { kind: h.holding_kind, variantId: h.card_variant_id })
  }
  for (const l of lots.data as unknown as Record<string, unknown>[]) {
    facts.lots.push({
      id: String(l.id),
      holdingId: String(l.holding_id),
      acquiredOn: String(l.acquired_on),
      quantity: Number(l.quantity),
      unitCostBasisNokMinor:
        l.unit_cost_basis_nok_minor === null ? null : Number(l.unit_cost_basis_nok_minor),
      costBasisState: String(l.cost_basis_state),
      voidedAt: l.voided_at === null ? null : String(l.voided_at),
    })
  }
  for (const d of disposals.data as Record<string, unknown>[]) {
    const list = facts.disposalsByLot.get(String(d.lot_id)) ?? []
    list.push({
      disposedOn: String(d.disposed_on),
      quantity: Number(d.quantity),
      voidedAt: d.voided_at === null ? null : String(d.voided_at),
    })
    facts.disposalsByLot.set(String(d.lot_id), list)
  }
  for (const line of lines.data as unknown as {
    attributable_cost_nok_minor: unknown
    spend_class: string
    purchases: { purchased_on: string; voided_at: string | null }
  }[]) {
    const purchaseRow = Array.isArray(line.purchases)
      ? (line.purchases as unknown as { purchased_on: string; voided_at: string | null }[])[0]
      : line.purchases
    if (!purchaseRow || purchaseRow.voided_at !== null) continue
    if (line.spend_class !== 'collectible') continue
    facts.collectibleSpendEvents.push({
      date: purchaseRow.purchased_on,
      amountNokMinor: Number(line.attributable_cost_nok_minor),
    })
  }
  for (const s of sales.data as {
    sold_on: string
    net_proceeds_nok_minor: unknown
    voided_at: string | null
  }[]) {
    if (s.voided_at !== null) continue
    facts.proceedsEvents.push({ date: s.sold_on, amountNokMinor: Number(s.net_proceeds_nok_minor) })
  }
  for (const m of manuals.data as {
    holding_id: string
    value_minor: unknown
    effective_from: string
    superseded_at: string | null
    created_at: string
  }[]) {
    const list = facts.manualByHolding.get(m.holding_id) ?? []
    list.push({
      valueMinor: Number(m.value_minor),
      effectiveFrom: m.effective_from,
      supersededAt: m.superseded_at,
      createdAt: m.created_at,
    })
    facts.manualByHolding.set(m.holding_id, list)
  }
  for (const p of prices.data as {
    card_variant_id: string
    provider: string
    value_minor: unknown
    snapshot_date: string
    source_currency: string
  }[]) {
    const list = facts.pricesByVariant.get(p.card_variant_id) ?? []
    list.push({
      provider: p.provider,
      valueMinor: Number(p.value_minor),
      snapshotDate: p.snapshot_date,
      currency: p.source_currency,
    })
    facts.pricesByVariant.set(p.card_variant_id, list)
  }
  for (const r of fx.data as { base_currency: string; rate_date: string; rate: unknown }[]) {
    const list = facts.fxByCurrency.get(r.base_currency) ?? []
    // numeric(18,8) arrives through PostgREST either as a JSON number or its text form; both are
    // normalised into the integer-scaled domain before any arithmetic happens.
    const numeric = typeof r.rate === 'number' ? r.rate : Number(r.rate)
    list.push({ rateDate: r.rate_date, rate: Number(BigInt(Math.round(numeric * 1e8))) })
    facts.fxByCurrency.set(r.base_currency, list)
  }

  return facts
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
}

/** Half-up rounding of minor × rate, entirely in integers. */
export function convertMinorToNok(valueMinor: number, rateScaled: number): number {
  const product = BigInt(Math.trunc(valueMinor)) * BigInt(Math.trunc(rateScaled))
  const half = BigInt(RATE_SCALE) / 2n
  return Number((product + half) / BigInt(RATE_SCALE))
}

/**
 * Manual-valuation interval model (D-062, corner RESOLVED after independent review — formerly
 * the LOCK-1 open question): each manual valuation occupies the interval [effective_from, end)
 * where `end` depends on HOW the row ended, and the schema's timestamps distinguish the two ways
 * because now() is the transaction timestamp:
 *
 * - ATOMIC REPLACEMENT: set_manual_valuation supersedes the old row and inserts the new one in
 *   ONE transaction, so the old row's superseded_at equals the successor's created_at. The
 *   replacement's effective_from defines the economic boundary.
 * - INDEPENDENT CLEAR: clear_manual_valuation stamps superseded_at and inserts nothing. If a new
 *   valuation only arrives LATER as a separate transaction, the cleared row STAYS CLEARED — it
 *   ends at its own clear date and the gap before the later row resolves through the automatic
 *   path. An explicit clear is never resurrected by an unrelated future insertion.
 *
 * Pairing is "does ANY row share this supersession timestamp", not "the immediately-next row in
 * effective_from order": a still-later backdated correction can sort between a row and its true
 * successor, and misreading that as a clear would produce overlapping intervals. A terminal row
 * whose successor was backdated BELOW it ends at its own supersession date. This is the only
 * reading under which full history stays reconstructable from final table state while `clear`
 * still changes today's resolution.
 */
export function manualValueAt(
  facts: OracleFacts,
  holdingId: string,
  dateIso: string,
): number | null {
  const rows = [...(facts.manualByHolding.get(holdingId) ?? [])].sort(
    (a, b) =>
      Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )
  const replacedTimestamps = new Set(
    rows
      .filter((r) => r.supersededAt !== null)
      .filter((r) => rows.some((o) => o.createdAt === r.supersededAt))
      .map((r) => r.supersededAt as string),
  )
  let winner: { valueMinor: number; effectiveFrom: string; createdAt: string } | null = null
  for (const r of rows) {
    if (r.effectiveFrom > dateIso) continue
    const nextEf = rows.find((o) => o.effectiveFrom > r.effectiveFrom)?.effectiveFrom
    const clearDate = r.supersededAt === null ? null : r.supersededAt.slice(0, 10)
    const ends: string[] = []
    if (nextEf !== undefined) ends.push(nextEf)
    // Cleared independently (always), or superseded with no later-effective successor (the
    // backdated-below case): the row's own supersession/clear date bounds it.
    if (
      r.supersededAt !== null &&
      clearDate !== null &&
      (!replacedTimestamps.has(r.supersededAt) || nextEf === undefined)
    ) {
      ends.push(clearDate)
    }
    const end = ends.length === 0 ? null : ends.reduce((min, b) => (b < min ? b : min))
    if (end !== null && dateIso >= end) continue
    if (
      winner === null ||
      r.effectiveFrom > winner.effectiveFrom ||
      (r.effectiveFrom === winner.effectiveFrom && r.createdAt >= winner.createdAt)
    ) {
      winner = r
    }
  }
  return winner?.valueMinor ?? null
}

/**
 * LOCK (historical freshness, FINANCIAL_MODEL §3 + §6): a provider observation is a step function
 * over time — for historical day D the candidate is the latest observation dated ≤ D, and its age
 * is measured FROM D, not from today. A price two days old as of D stays fresh for D forever.
 */
export function resolvedUnitValueNok(
  facts: OracleFacts,
  holdingId: string,
  dateIso: string,
): number | null {
  const holding = facts.holdings.get(holdingId)
  if (!holding) return null
  const manual = manualValueAt(facts, holdingId, dateIso)
  if (manual !== null) return manual

  // LOCK (F10 / sealed manual-only): raw provider prices never value graded or sealed holdings.
  if (holding.kind !== 'raw_card' || holding.variantId === null) return null

  const observations = facts.pricesByVariant.get(holding.variantId) ?? []
  const latestFor = (
    provider: string,
  ): { valueMinor: number; snapshotDate: string; currency: string } | null => {
    let best: { valueMinor: number; snapshotDate: string; currency: string } | null = null
    for (const o of observations) {
      if (o.provider !== provider) continue
      if (o.snapshotDate > dateIso) continue // LOCK: no look-ahead — scenario G
      if (best === null || o.snapshotDate > best.snapshotDate) best = o
    }
    return best
  }

  const preferred = facts.euPricing ? 'tcgdex_cardmarket' : 'tcgdex_tcgplayer'
  const fallback = facts.euPricing ? 'tcgdex_tcgplayer' : 'tcgdex_cardmarket'

  const pick = (provider: string): { unit: number } | null => {
    const obs = latestFor(provider)
    if (!obs) return null
    const age = daysBetween(obs.snapshotDate, dateIso)
    if (age > 30) return null // fresh ≤ 3, stale ≤ 30, missing beyond — FINANCIAL_MODEL §6
    const rates = facts.fxByCurrency.get(obs.currency) ?? []
    let rate: number | null = null
    let bestDate = ''
    for (const r of rates) {
      if (r.rateDate > obs.snapshotDate) continue // FX observed on/before the observation's own date
      if (rate === null || r.rateDate > bestDate) {
        rate = r.rate
        bestDate = r.rateDate
      }
    }
    if (rate === null) return null // no honest conversion available → unvalued, never zero
    return { unit: convertMinorToNok(obs.valueMinor, rate) }
  }

  const primary = pick(preferred)
  if (primary !== null) return primary.unit
  const secondary = pick(fallback)
  return secondary?.unit ?? null
}

export function quantityRemainingAsOf(
  facts: OracleFacts,
  lotIndex: number,
  dateIso: string,
): number {
  const lot = facts.lots[lotIndex]
  if (!lot) return 0
  let remaining = lot.quantity
  for (const d of facts.disposalsByLot.get(lot.id) ?? []) {
    if (d.voidedAt !== null) continue
    if (d.disposedOn <= dateIso) remaining -= d.quantity
  }
  return remaining
}

export function isOpenAt(facts: OracleFacts, lotIndex: number, dateIso: string): boolean {
  const lot = facts.lots[lotIndex]
  if (!lot) return false
  if (lot.voidedAt !== null) return false
  if (lot.acquiredOn > dateIso) return false
  return quantityRemainingAsOf(facts, lotIndex, dateIso) > 0
}

export function sumSince(
  events: { date: string; amountNokMinor: number }[],
  dateIso: string,
): number {
  return events.filter((e) => e.date <= dateIso).reduce((acc, e) => acc + e.amountNokMinor, 0)
}

export interface ExpectedSnapshotRow {
  snapshot_date: string
  market_value_nok_minor: number
  attributed_value_nok_minor: number
  cost_basis_nok_minor: number
  collectible_spend_to_date_nok_minor: number
  sales_proceeds_to_date_nok_minor: number
  open_lot_count: number
  unvalued_lot_count: number
}

export function expectedSnapshotAt(facts: OracleFacts, dateIso: string): ExpectedSnapshotRow {
  let market = 0
  let attributed = 0
  let costBasis = 0
  let openLots = 0
  let unvalued = 0

  for (let i = 0; i < facts.lots.length; i++) {
    if (!isOpenAt(facts, i, dateIso)) continue
    openLots += 1
    const lot = facts.lots[i]!
    const remaining = quantityRemainingAsOf(facts, i, dateIso)
    const holdingId = lot.holdingId
    const unit = resolvedUnitValueNok(facts, holdingId, dateIso)
    if (unit === null) {
      unvalued += 1
    } else {
      market += unit * remaining
    }
    if (lot.costBasisState === 'known' && lot.unitCostBasisNokMinor !== null) {
      attributed += (unit ?? 0) * remaining
      costBasis += lot.unitCostBasisNokMinor * remaining
    }
  }

  return {
    snapshot_date: dateIso,
    market_value_nok_minor: market,
    attributed_value_nok_minor: attributed,
    cost_basis_nok_minor: costBasis,
    collectible_spend_to_date_nok_minor: sumSince(facts.collectibleSpendEvents, dateIso),
    sales_proceeds_to_date_nok_minor: sumSince(facts.proceedsEvents, dateIso),
    open_lot_count: openLots,
    unvalued_lot_count: unvalued,
  }
}

/** Earliest date the user's own events make trackable — nothing may exist before it. */
export function firstTrackedDate(facts: OracleFacts): string {
  const dates: string[] = [
    ...facts.lots.filter((l) => l.voidedAt === null).map((l) => l.acquiredOn),
    ...facts.collectibleSpendEvents.map((e) => e.date),
    ...facts.proceedsEvents.map((e) => e.date),
  ]
  if (dates.length === 0) throw new Error('fixture produced no trackable events')
  return dates.reduce((min, d) => (d < min ? d : min))
}

export function compareExpectedToRow(
  expected: ExpectedSnapshotRow,
  actual: Record<string, unknown>,
): { column: SnapshotColumn; expected: number; actual: unknown } | null {
  for (const column of SNAPSHOT_COLUMNS) {
    const actualValue = actual[column]
    if (Number(actualValue) !== expected[column]) {
      return { column, expected: expected[column], actual: actualValue }
    }
  }
  return null
}

/** Day-by-day expectations across an inclusive calendar range. */
export function expectedSeriesBetween(
  facts: OracleFacts,
  fromIso: string,
  toIso: string,
): ExpectedSnapshotRow[] {
  const out: ExpectedSnapshotRow[] = []
  const cursor = new Date(`${fromIso}T00:00:00Z`)
  const end = Date.parse(`${toIso}T00:00:00Z`)
  while (cursor.getTime() <= end) {
    const iso = cursor.toISOString().slice(0, 10)
    out.push(expectedSnapshotAt(facts, iso))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}
