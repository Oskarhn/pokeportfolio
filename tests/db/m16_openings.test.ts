import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
 * M16: Openings V1 — canonical DB core (FINANCIAL_MODEL.md §5, prompt scenarios E1–E8/E11–E16).
 * The central gates: openings create NO spend (CS/GPO byte-identical across an opening), the
 * consumed frozen basis is exact down to the residual minor unit (the corrected §29995 example),
 * pulled cards carry NULL basis structurally, void/reconcile lifecycles never orphan money, and
 * History reports ONE event per opening. Cross-user/anon attacks live in
 * tests/authorization/m16_openings.test.ts, same split M8/M10 established.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm16-openings-a')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

const DAY_MS = 86_400_000
const dateOffset = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)
const today = dateOffset(0)

interface OpeningRow {
  id: string
  opened_on: string
  sealed_product_id: string
  source_lot_id: string
  quantity_opened: number
  cost_source: 'from_lot' | 'unknown'
  /** PostgREST serializes an uncast composite bigint field as a plain JSON number. */
  cost_nok_minor: number | null
  tracking_completeness: 'all_cards' | 'selected_pulls' | 'unknown'
  bulk_remainder_estimate_nok_minor: number | null
  bulk_remainder_count: number | null
  provisional_purchase_id: string | null
  reconciled_at: string | null
  reconciled_to_purchase_id: string | null
  notes: string | null
  voided_at: string | null
}

interface LotRow {
  id: string
  quantity: number
  quantity_remaining: number
  unit_cost_basis_nok_minor: number | null
  residual_nok_minor: number
  cost_basis_state: string
  origin: string
  opening_id: string | null
  acquired_on: string
  voided_at: string | null
}

interface SpendingRow {
  gpo_nok_minor: string
  cs_nok_minor: string
  hs_nok_minor: string
}

async function spendingOf(client: TestClient): Promise<SpendingRow> {
  const { data, error } = await client.rpc('purchase_spending_summary').single<SpendingRow>()
  if (error) throw new Error(error.message)
  return data
}

/** One sealed purchase line, NOK, optional shipping. Returns the produced lot. */
async function buySealed(
  client: TestClient,
  options: {
    quantity: number
    unitPriceMinor: number
    shippingMinor?: number
    purchasedOn?: string
  },
): Promise<{ purchaseId: string; lotId: string }> {
  const { data: purchase, error } = await client
    .rpc('create_purchase', {
      p_purchased_on: options.purchasedOn ?? today,
      p_currency: 'NOK',
      p_shipping_minor: options.shippingMinor ?? 0,
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: options.quantity,
          unit_price_minor: options.unitPriceMinor,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)

  const { data: line, error: lineError } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  if (lineError) throw new Error(lineError.message)

  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', line.id)
    .single()
  if (lotError) throw new Error(lotError.message)
  return { purchaseId: purchase.id, lotId: lot.id }
}

async function lotById(lotId: string): Promise<LotRow> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select(
      'id, quantity, quantity_remaining, unit_cost_basis_nok_minor, residual_nok_minor, ' +
        'cost_basis_state, origin, opening_id, acquired_on, voided_at',
    )
    .eq('id', lotId)
    .single<LotRow>()
  if (error) throw new Error(error.message)
  return data
}

async function countRows(table: string): Promise<number> {
  const { count, error } = await service
    .from(table)
    .select('id', { count: 'exact' })
    .eq('user_id', userA.id)
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function disposalsOf(lotId: string) {
  const { data, error } = await service
    .from('lot_disposals')
    .select(
      'id, kind, quantity, disposed_on, opening_id, cost_basis_at_disposal_nok_minor, voided_at',
    )
    .eq('lot_id', lotId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data as {
    id: string
    kind: string
    quantity: number
    disposed_on: string
    opening_id: string | null
    /** Uncast bigint column — plain JSON number over PostgREST. */
    cost_basis_at_disposal_nok_minor: number | null
    voided_at: string | null
  }[]
}

interface PullWire {
  card_variant_id?: string
  manual_card_id?: string
  quantity: number
  condition?: string
}

async function callCreateOpening(client: TestClient, args: Record<string, unknown>) {
  return client.rpc('create_opening', args).single<OpeningRow>()
}

/** The test clients are untyped (setup.ts); this names what list_history_events emits. */
interface HistoryRow {
  event_kind: string
  primary_id: string
  occurred_on: string
  recorded_at: string
  title: string
  subtitle: string
  amount_nok_minor: string | null
  status: string
  href: string
}

async function historyEvents(client: TestClient, args: Record<string, unknown>) {
  const { data, error } = await client.rpc('list_history_events', args)
  if (error) throw new Error(error.message)
  // Through `unknown`: a direct any→T cast changes nothing per the type system.
  return (data ?? []) as unknown as HistoryRow[]
}

interface ActivityRow {
  activity_type: string
  primary_id: string
  secondary_id: string | null
  occurred_on: string
  amount_nok_minor: string | null
}

async function recentActivity(client: TestClient, limit: number) {
  const { data, error } = await client.rpc('get_recent_activity', { p_limit: limit })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as ActivityRow[]
}

describe('E1 — opening creates NO spend; consumption freezes the exact share', () => {
  it('buy 10 packs @ 5990, open 2: CS/GPO byte-identical before/after, cost 11980 frozen', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 10, unitPriceMinor: 5990 })
    const before = await spendingOf(clientA)
    expect(BigInt(before.gpo_nok_minor)).toBe(59900n)

    const { data: opening, error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 2,
      p_opened_on: today,
      p_pulls: [
        { card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' },
      ] satisfies PullWire[],
    })
    if (error) throw new Error(error.message)

    // The spend ledger is UNTOUCHED by the act of opening (prompt §6 invariant).
    const after = await spendingOf(clientA)
    expect(after.gpo_nok_minor).toBe(before.gpo_nok_minor)
    expect(after.cs_nok_minor).toBe(before.cs_nok_minor)

    expect(opening.cost_source).toBe('from_lot')
    expect(opening.cost_nok_minor).toBe(11980)
    expect(opening.quantity_opened).toBe(2)
    expect(opening.sealed_product_id).toBe(seedCatalog.sealedProductId)
    expect(opening.provisional_purchase_id).toBeNull()
    expect(opening.reconciled_at).toBeNull()

    // The consumption IS one disposal row; D1 decremented the source lot.
    const disposals = await disposalsOf(lotId)
    expect(disposals).toHaveLength(1)
    expect(disposals[0]!.kind).toBe('opened')
    expect(disposals[0]!.quantity).toBe(2)
    expect(disposals[0]!.opening_id).toBe(opening.id)
    expect(disposals[0]!.cost_basis_at_disposal_nok_minor).toBe(11980)
    expect((await lotById(lotId)).quantity_remaining).toBe(8)

    // The pull lot: origin/state/basis are structurally correct, acquired at opened_on.
    const { data: pulls, error: pullsError } = await service
      .from('acquisition_lots')
      .select(
        'id, origin, cost_basis_state, unit_cost_basis_minor, unit_cost_basis_nok_minor, opening_id, acquired_on',
      )
      .eq('opening_id', opening.id)
    if (pullsError) throw new Error(pullsError.message)
    expect(pulls).toHaveLength(1)
    expect(pulls[0]!.origin).toBe('opening')
    expect(pulls[0]!.cost_basis_state).toBe('unallocated_opening')
    expect(pulls[0]!.unit_cost_basis_minor).toBeNull()
    expect(pulls[0]!.unit_cost_basis_nok_minor).toBeNull()
    expect(pulls[0]!.acquired_on).toBe(today)
  })

  it('a costed pull is structurally unrepresentable (M2 + origin/state consistency)', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 5, unitPriceMinor: 1000 })
    const { data: opening } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
    })
    if (!opening) throw new Error('opening missing')

    // Direct INSERT (authenticated holds it on acquisition_lots) cannot attach a basis to an
    // opening-origin lot — the constraint refuses, not RPC discipline.
    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', userA.id)
      .eq('sealed_product_id', seedCatalog.sealedProductId)
      .limit(1)
      .single()
    const { error: insertError } = await clientA.from('acquisition_lots').insert({
      holding_id: holding!.id,
      origin: 'opening',
      cost_basis_state: 'known',
      unit_cost_basis_minor: 500,
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      opening_id: opening.id,
    })
    expect(insertError).not.toBeNull()

    const { error: wrongOriginError } = await clientA.from('acquisition_lots').insert({
      holding_id: holding!.id,
      origin: 'purchase',
      cost_basis_state: 'unallocated_opening',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
      opening_id: opening.id,
    })
    expect(wrongOriginError).not.toBeNull()
  })
})

describe('E2 — residual exactness: 3 units, attributable 29995', () => {
  it('open 2 then open 1: 19996 + 9999 = 29995 exactly (residual rides the exhausting disposal)', async () => {
    // line_total 29994 (9998 × 3) + 1 shipping allocated to the single line → attributable 29995.
    const { lotId } = await buySealed(clientA, {
      quantity: 3,
      unitPriceMinor: 9998,
      shippingMinor: 1,
    })
    const lot = await lotById(lotId)
    expect(lot.unit_cost_basis_nok_minor).toBe(9998)
    expect(lot.residual_nok_minor).toBe(1)

    const first = await callCreateOpening(clientA, { p_source_lot_id: lotId, p_quantity: 2 })
    if (first.error) throw new Error(first.error.message)
    expect(first.data.cost_nok_minor).toBe(19996) // floor division only, no residual yet

    const second = await callCreateOpening(clientA, { p_source_lot_id: lotId, p_quantity: 1 })
    if (second.error) throw new Error(second.error.message)
    expect(second.data.cost_nok_minor).toBe(9999) // last unit + the lot's residual, exactly once

    expect(BigInt(first.data.cost_nok_minor!) + BigInt(second.data.cost_nok_minor!)).toBe(29995n)
  })

  it('inverse order, open 1 then open 2: 9998 + 19997 = 29995 exactly (deterministic both ways)', async () => {
    const { lotId } = await buySealed(clientA, {
      quantity: 3,
      unitPriceMinor: 9998,
      shippingMinor: 1,
    })
    const first = await callCreateOpening(clientA, { p_source_lot_id: lotId, p_quantity: 1 })
    if (first.error) throw new Error(first.error.message)
    expect(first.data.cost_nok_minor).toBe(9998)

    const second = await callCreateOpening(clientA, { p_source_lot_id: lotId, p_quantity: 2 })
    if (second.error) throw new Error(second.error.message)
    expect(second.data.cost_nok_minor).toBe(19997)

    expect(BigInt(first.data.cost_nok_minor!) + BigInt(second.data.cost_nok_minor!)).toBe(29995n)
  })
})

describe('E3 — gift/unknown-cost sealed product opens honestly', () => {
  it('gifted packs: cost stays NULL, pulled basis stays NULL, nothing counted as zero', async () => {
    const before = await spendingOf(clientA)
    const { data: added, error } = await clientA
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_sealed_intent: 'planned_to_open',
        p_origin: 'gift',
        p_cost_basis_state: 'not_paid',
        p_quantity: 2,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()
    if (error) throw new Error(error.message)

    const { data: opening, error: openError } = await callCreateOpening(clientA, {
      p_source_lot_id: added.lot_id,
      p_quantity: 2,
    })
    if (openError) throw new Error(openError.message)

    expect(opening.cost_source).toBe('unknown')
    expect(opening.cost_nok_minor).toBeNull()

    const disposals = await disposalsOf(added.lot_id)
    expect(disposals[0]!.cost_basis_at_disposal_nok_minor).toBeNull()

    const { data: detail } = await clientA.rpc('get_opening', { p_opening_id: opening.id }).single<{
      opening_return_nok_minor: string | null
      net_proceeds_from_sold_pulls_nok_minor: string
      retained_tracked_value_nok_minor: string
    }>()
    expect(detail!.opening_return_nok_minor).toBeNull()

    const after = await spendingOf(clientA)
    expect(after.gpo_nok_minor).toBe(before.gpo_nok_minor)
  })
})

describe('E4/E5 — pull tracking: commons, energy, manual fallback, completeness flag', () => {
  it('all_cards tracking records every pull class; unpriced ones are counted, never zeroed', async () => {
    // A catalog-missing card gets the manual-card fallback (D-037).
    const { data: manual, error: manualError } = await clientA
      .from('manual_card_definitions')
      .insert({ name: 'M16 fixture catalog miss' })
      .select('id')
      .single<{ id: string }>()
    if (manualError) throw new Error(manualError.message)

    const { lotId } = await buySealed(clientA, { quantity: 4, unitPriceMinor: 2500 })
    const { data: opening, error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 2,
      p_tracking_completeness: 'all_cards',
      p_pulls: [
        { card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' },
        { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 12, condition: 'NM' },
        { manual_card_id: manual.id, quantity: 1, condition: 'EX' },
      ] satisfies PullWire[],
    })
    if (error) throw new Error(error.message)

    const { data: pulls } = await service
      .from('acquisition_lots')
      .select('id, quantity, opening_id, origin, cost_basis_state')
      .eq('opening_id', opening.id)
      .order('created_at')
    expect(pulls).toHaveLength(3)
    // Basic Energy is ordinary first-class inventory: twelve copies, one lot, never aggregated away.
    expect(pulls![1]!.quantity).toBe(12)

    const { data: detail } = await clientA.rpc('get_opening', { p_opening_id: opening.id }).single<{
      tracking_completeness: string
      priced_pull_lot_count: number
      unpriced_pull_lot_count: number
      retained_tracked_value_nok_minor: string
      opening_return_nok_minor: string | null
    }>()
    expect(detail!.tracking_completeness).toBe('all_cards')
    // No price facts exist for these variants in this fixture: all three lots honestly unpriced.
    expect(detail!.priced_pull_lot_count).toBe(0)
    expect(detail!.unpriced_pull_lot_count).toBe(3)
    expect(detail!.retained_tracked_value_nok_minor).toBe('0')
    expect(detail!.opening_return_nok_minor).toBe('-5000') // 0 − 2×2500
  })

  it('a resolved market price feeds retained value (resolver called through the same rule)', async () => {
    // Private fixture variant no other suite touches (avoids the shared-catalog snapshot
    // collision class M10 documented).
    const { data: variant, error: variantError } = await service
      .from('card_variants')
      .insert({
        card_id: seedCatalog.charizardCardId,
        finish: 'normal',
        stamp: '',
        subtype: 'm16-pricing-fixture',
        size: 'standard',
      })
      .select('id')
      .single<{ id: string }>()
    if (variantError) throw new Error(variantError.message)

    // Ensure SOME EUR→NOK observation exists on/before today (shared cache; insert only if absent).
    const { data: fx } = await service
      .from('fx_rates')
      .select('rate_date')
      .eq('base_currency', 'EUR')
      .eq('quote_currency', 'NOK')
      .eq('source', 'norges_bank')
      .lte('rate_date', today)
      .limit(1)
    if ((fx ?? []).length === 0) {
      const { error: fxFail } = await service.from('fx_rates').insert({
        base_currency: 'EUR',
        quote_currency: 'NOK',
        rate_date: today,
        source: 'norges_bank',
        rate: '11.00000000',
      })
      if (fxFail) throw new Error(fxFail.message)
    }

    const { error: snapFail } = await service.from('price_snapshots').insert({
      card_variant_id: variant.id,
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: 10000,
      snapshot_date: today,
    })
    if (snapFail) throw new Error(snapFail.message)

    // Expected NOK comes from THE SAME resolver every other surface uses — never re-derived here.
    const { data: resolved } = await clientA
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [variant.id] })
      .single<{ price_state: string; value_nok_minor: string | null }>()

    const { lotId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 10000 })
    const { data: opening, error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_pulls: [{ card_variant_id: variant.id, quantity: 2, condition: 'NM' }],
    })
    if (error) throw new Error(error.message)

    const { data: detail } = await clientA.rpc('get_opening', { p_opening_id: opening.id }).single<{
      priced_pull_lot_count: number
      unpriced_pull_lot_count: number
      retained_tracked_value_nok_minor: string
    }>()

    if (resolved && resolved.price_state !== 'missing' && resolved.value_nok_minor !== null) {
      const expected = BigInt(resolved.value_nok_minor) * 2n
      expect(detail!.priced_pull_lot_count).toBe(1)
      expect(detail!.unpriced_pull_lot_count).toBe(0)
      expect(BigInt(detail!.retained_tracked_value_nok_minor)).toBe(expected)
    } else {
      // No cached FX yet in this run: honestly unpriced, never a fabricated figure (F14/F9).
      expect(detail!.priced_pull_lot_count).toBe(0)
      expect(detail!.unpriced_pull_lot_count).toBe(1)
      expect(detail!.retained_tracked_value_nok_minor).toBe('0')
    }
  })

  it('selected_pulls completeness marker is preserved, never inferred (E5)', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 1500 })
    const { data: opening, error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_tracking_completeness: 'selected_pulls',
      p_bulk_remainder_estimate_nok_minor: 24000,
      p_bulk_remainder_count: 60,
    })
    if (error) throw new Error(error.message)
    expect(opening.tracking_completeness).toBe('selected_pulls')

    const { data: detail } = await clientA.rpc('get_opening', { p_opening_id: opening.id }).single<{
      tracking_completeness: string
      bulk_remainder_estimate_nok_minor: string | null
      bulk_remainder_count: number | null
    }>()
    expect(detail!.tracking_completeness).toBe('selected_pulls')
    expect(detail!.bulk_remainder_estimate_nok_minor).toBe('24000')
    expect(detail!.bulk_remainder_count).toBe(60)
  })

  it('bulk remainder is both-or-neither and estimate-only — never inventory, never spend', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 1, unitPriceMinor: 1200 })
    const openingsBefore = await countRows('openings')
    const { error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_bulk_remainder_estimate_nok_minor: 500,
    })
    expect(error).not.toBeNull()
    // The refused opening added nothing anywhere.
    expect(await countRows('openings')).toBe(openingsBefore)
  })
})

describe('E6 — selling a pull keeps the opening link forever', () => {
  it('sale of a pull: NULL frozen basis, PUD not RRC, proceeds feed the opening result', async () => {
    const { lotId: sealedLot } = await buySealed(clientA, { quantity: 1, unitPriceMinor: 79900 })
    const { data: opening, error } = await callCreateOpening(clientA, {
      p_source_lot_id: sealedLot,
      p_quantity: 1,
      p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
    })
    if (error) throw new Error(error.message)
    const { data: pull } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('opening_id', opening.id)
      .single()

    const before = await clientA.rpc('sales_summary').single<{
      pud_nok_minor: string
      rrc_nok_minor: string
      nsp_nok_minor: string
    }>()
    if (before.error) throw new Error(before.error.message)

    const { data: sale, error: saleError } = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: pull!.id, quantity: 1, unit_gross_minor: 45000 }],
        p_idempotency_key: crypto.randomUUID(),
      })
      .single<{ id: string }>()
    if (saleError) throw new Error(saleError.message)

    const { data: line } = await service
      .from('sale_lines')
      .select('cost_basis_at_sale_nok_minor, realized_result_nok_minor, net_proceeds_nok_minor')
      .eq('sale_id', sale.id)
      .single()
    // Current sale semantics: an opening-pull lot has no cost basis — proceeds without result.
    expect(line!.cost_basis_at_sale_nok_minor).toBeNull()
    expect(line!.realized_result_nok_minor).toBeNull()
    expect(line!.net_proceeds_nok_minor).toBe(45000)

    const after = await clientA.rpc('sales_summary').single<{
      pud_nok_minor: string
      rrc_nok_minor: string
      nsp_nok_minor: string
    }>()
    if (after.error) throw new Error(after.error.message)
    expect(BigInt(after.data.pud_nok_minor) - BigInt(before.data.pud_nok_minor)).toBe(45000n)
    expect(after.data.rrc_nok_minor).toBe(before.data.rrc_nok_minor)

    // The sold lot keeps its opening attribution permanently (§5.3).
    const soldLot = await lotById(pull!.id)
    expect(soldLot.opening_id).toBe(opening.id)

    const { data: detail } = await clientA.rpc('get_opening', { p_opening_id: opening.id }).single<{
      sold_pull_lot_count: number
      net_proceeds_from_sold_pulls_nok_minor: string
      opening_return_nok_minor: string
    }>()
    expect(detail!.sold_pull_lot_count).toBe(1)
    expect(detail!.net_proceeds_from_sold_pulls_nok_minor).toBe('45000')
    expect(BigInt(detail!.opening_return_nok_minor)).toBe(45000n - 79900n)

    // Voiding that sale revives the pull and drops the proceeds term again.
    const { error: voidSaleError } = await clientA.rpc('void_sale', { p_sale_id: sale.id })
    if (voidSaleError) throw new Error(voidSaleError.message)
    expect((await lotById(pull!.id)).quantity_remaining).toBe(1)
    const { data: revertedDetail } = await clientA
      .rpc('get_opening', { p_opening_id: opening.id })
      .single<{ sold_pull_lot_count: number; net_proceeds_from_sold_pulls_nok_minor: string }>()
    expect(revertedDetail!.sold_pull_lot_count).toBe(0)
    expect(revertedDetail!.net_proceeds_from_sold_pulls_nok_minor).toBe('0')
  })
})

describe('E7/E8 — refusal and concurrency at the quantity boundary', () => {
  it('opening more units than remain is refused with zero mutation (E7)', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 2000 })
    const openingsBefore = await countRows('openings')
    const disposalsBefore = await countRows('lot_disposals')

    const { error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 4,
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('remain available')

    expect(await countRows('openings')).toBe(openingsBefore)
    expect(await countRows('lot_disposals')).toBe(disposalsBefore)
    expect((await lotById(lotId)).quantity_remaining).toBe(3)
  })

  it('two concurrent 6-of-10 openings: exactly one succeeds, no negative quantity (E8)', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 10, unitPriceMinor: 1000 })

    const outcomes = await Promise.all([
      callCreateOpening(clientA, { p_source_lot_id: lotId, p_quantity: 6 })
        .then((r): 'ok' | 'failed' => (r.error ? 'failed' : 'ok'))
        .catch((): 'ok' | 'failed' => 'failed'),
      callCreateOpening(clientA, { p_source_lot_id: lotId, p_quantity: 6 })
        .then((r): 'ok' | 'failed' => (r.error ? 'failed' : 'ok'))
        .catch((): 'ok' | 'failed' => 'failed'),
    ])
    expect(outcomes.filter((s) => s === 'ok')).toHaveLength(1)
    expect(outcomes.filter((s) => s === 'failed')).toHaveLength(1)

    const lot = await lotById(lotId)
    expect(lot.quantity_remaining).toBe(4)
  })
})

describe('E11/E12 — void lifecycle', () => {
  it('void a simple linked opening: sealed restored, pulls corrected, history honest', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 5, unitPriceMinor: 3000 })
    const { data: opening, error } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 2,
      p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
    })
    if (error) throw new Error(error.message)

    const { error: voidError } = await clientA.rpc('void_opening', {
      p_opening_id: opening.id,
      p_reason: 'recorded the wrong product',
    })
    expect(voidError).toBeNull()

    expect((await lotById(lotId)).quantity_remaining).toBe(5)
    const disposals = await disposalsOf(lotId)
    expect(disposals[0]!.voided_at).not.toBeNull()

    const { data: pulls } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('opening_id', opening.id)
    expect((pulls ?? []).length).toBeGreaterThan(0)
    expect((pulls ?? []).every((p) => p.voided_at !== null)).toBe(true)

    const { data: voidedOpening } = await service
      .from('openings')
      .select('voided_at')
      .eq('id', opening.id)
      .single()
    expect(voidedOpening!.voided_at).not.toBeNull()

    // Double-void is a named error, never a silent no-op that could double-restore quantity.
    const { error: again } = await clientA.rpc('void_opening', { p_opening_id: opening.id })
    expect(again).not.toBeNull()
  })

  it('void a PROVISIONAL opening: the provisional purchase leaves the ledger symmetrically', async () => {
    const before = await spendingOf(clientA)

    const { data: opening, error } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_unit_price_minor: 29950,
        p_purchased_on: today,
        p_opened_on: today,
        p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 2, condition: 'NM' }],
      })
      .single<OpeningRow>()
    if (error) throw new Error(error.message)

    const during = await spendingOf(clientA)
    // D-021/§5.5: the provisional entry is REAL spend — GPO/CS counted it exactly once.
    expect(BigInt(during.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(59900n)

    const { error: voidError } = await clientA.rpc('void_opening', { p_opening_id: opening.id })
    expect(voidError).toBeNull()

    const afterVoid = await spendingOf(clientA)
    expect(afterVoid.gpo_nok_minor).toBe(before.gpo_nok_minor)
    const { data: purchase } = await service
      .from('purchases')
      .select('voided_at, origin')
      .eq('id', opening.provisional_purchase_id!)
      .single()
    expect(purchase!.voided_at).not.toBeNull()
    expect(purchase!.origin).toBe('provisional_opening')
  })

  it('void is REFUSED while a pull has been sold (E12) — never orphan a financial fact', async () => {
    const { lotId: sealedLot } = await buySealed(clientA, { quantity: 1, unitPriceMinor: 50000 })
    const { data: opening } = await callCreateOpening(clientA, {
      p_source_lot_id: sealedLot,
      p_quantity: 1,
      p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
    })
    const { data: pull } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('opening_id', opening!.id)
      .single()

    const { data: sale, error: saleError } = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [{ lot_id: pull!.id, quantity: 1, unit_gross_minor: 60000 }],
        p_idempotency_key: crypto.randomUUID(),
      })
      .single<{ id: string }>()
    if (saleError) throw new Error(saleError.message)

    const openingsBefore = await countRows('openings')
    const { error: voidError } = await clientA.rpc('void_opening', {
      p_opening_id: opening!.id,
    })
    expect(voidError).not.toBeNull()
    expect(voidError!.message).toContain('downstream disposal')
    expect(await countRows('openings')).toBe(openingsBefore)
    expect(
      (await service.from('sales').select('voided_at').eq('id', sale.id).single()).data!.voided_at,
    ).toBeNull()
  })
})

describe('provisional reconciliation WITHOUT audit_events (F12, prompt §18/§19)', () => {
  it('provisional → real receipt → reconcile: money counted once at every instant', async () => {
    const before = await spendingOf(clientA)

    // Step 1: provisional opening (never entered as a purchase).
    const { data: opening, error } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 3,
        p_unit_price_minor: 19900,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (error) throw new Error(error.message)
    expect(opening.cost_source).toBe('from_lot')
    expect(opening.cost_nok_minor).toBe(59700)

    // Step 2: the real receipt arrives — 3 boxes @ 19900 + 90 shipping = attributable 59790.
    const { lotId: realLot } = await buySealed(clientA, {
      quantity: 3,
      unitPriceMinor: 19900,
      shippingMinor: 90,
    })
    const realLotRow = await lotById(realLot)
    expect(realLotRow.residual_nok_minor).toBe(0) // 59790 / 3 divides evenly

    // Step 3: reconcile — one transaction repoints, retires the provisional consumption,
    // voids the provisional purchase and records provenance on the row itself.
    const { data: reconciled, error: recError } = await clientA
      .rpc('reconcile_opening_cost', {
        p_opening_id: opening.id,
        p_real_source_lot_id: realLot,
      })
      .single<OpeningRow>()
    if (recError) throw new Error(recError.message)

    expect(reconciled.source_lot_id).toBe(realLot)
    expect(reconciled.cost_nok_minor).toBe(59790)
    expect(reconciled.reconciled_to_purchase_id).not.toBeNull()
    expect(reconciled.reconciled_at).not.toBeNull()
    // The historical pointer survives; the PURCHASE is what got voided.
    expect(reconciled.provisional_purchase_id).toBe(opening.provisional_purchase_id)

    // Exactly ONE active monetary source: provisional voided, real live. Net lifetime effect
    // versus before step 1: exactly the real receipt's total, counted once (F12/E13).
    const { data: provPurchase } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', opening.provisional_purchase_id!)
      .single()
    expect(provPurchase!.voided_at).not.toBeNull()

    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor)).toBe(BigInt(before.gpo_nok_minor) + 59790n)

    // The provisional lot was restored (disposal retired); the real lot is now consumed.
    const { data: oldDisposals } = await service
      .from('lot_disposals')
      .select('lot_id, voided_at')
      .eq('opening_id', opening.id)
      .order('created_at')
    expect(oldDisposals).toHaveLength(2)
    expect(oldDisposals![0]!.voided_at).not.toBeNull()
    expect(oldDisposals![1]!.voided_at).toBeNull()
    expect(oldDisposals![1]!.lot_id).toBe(realLot)

    // Double-reconcile is refused.
    const { error: twice } = await clientA.rpc('reconcile_opening_cost', {
      p_opening_id: opening.id,
      p_real_source_lot_id: realLot,
    })
    expect(twice).not.toBeNull()
  })

  it('reconciliation target must be the same product, known-cost, with enough units', async () => {
    const { data: opening } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_unit_price_minor: 10000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()

    // A different product (Japanese fixture set) is not a valid target.
    const { data: jpProduct } = await service
      .from('sealed_products')
      .insert({
        product_type: 'booster_pack',
        name: 'M16 wrong-product fixture',
        language: 'ja',
        created_by_user_id: userA.id,
      })
      .select('id')
      .single<{ id: string }>()
    const { data: wrongHolding } = await clientA
      .from('holdings')
      .insert({ holding_kind: 'sealed', sealed_product_id: jpProduct!.id, grading_state: 'raw' })
      .select('id')
      .single<{ id: string }>()
    const { data: wrongLot } = await clientA
      .from('acquisition_lots')
      .insert({
        holding_id: wrongHolding!.id,
        origin: 'pre_tracking',
        cost_basis_state: 'unknown',
        acquired_on: today,
        quantity: 5,
        quantity_remaining: 5,
      })
      .select('id')
      .single<{ id: string }>()

    const { error: wrongProduct } = await clientA.rpc('reconcile_opening_cost', {
      p_opening_id: opening!.id,
      p_real_source_lot_id: wrongLot!.id,
    })
    expect(wrongProduct).not.toBeNull()
  })

  it('no audit_events dependency anywhere (E16)', async () => {
    const { error } = await service.from('audit_events').select('*').limit(1)
    // If the table existed, service_role would read it without error — an error IS the proof.
    expect(error).not.toBeNull()
    expect(JSON.stringify(error)).toMatch(/audit_events/i)
  })
})

describe('E13 — backdated opening dirties M12 history from the correct date', () => {
  it('sealed owned until opened_on; pulls enter same day; dirty_from = earliest touched date', async () => {
    // Purchase AFTER the (older) opening date, so the opening is what moves the boundary.
    const purchasedOn = dateOffset(-5)
    const openedOn = dateOffset(-10)

    const { lotId } = await buySealed(clientA, {
      quantity: 2,
      unitPriceMinor: 4000,
      purchasedOn,
    })
    // Purchase already dirtied the queue at its own date.
    const { data: beforeQueue } = await service
      .from('portfolio_recompute_queue')
      .select('dirty_from')
      .eq('user_id', userA.id)
      .maybeSingle<{ dirty_from: string }>()

    await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_opened_on: openedOn,
      p_pulls: [
        { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 3, condition: 'NM' },
      ],
    })

    const { data: queue } = await service
      .from('portfolio_recompute_queue')
      .select('dirty_from')
      .eq('user_id', userA.id)
      .maybeSingle<{ dirty_from: string }>()
    expect(queue).not.toBeNull()
    expect(queue!.dirty_from).toBe(openedOn)
    expect(new Date(queue!.dirty_from).getTime()).toBeLessThan(
      new Date(beforeQueue?.dirty_from ?? purchasedOn).getTime(),
    )
  })
})

describe('E15 — History reports exactly ONE event per opening', () => {
  it('opening arm appears once; its pulls do not double-report as Added; voided filters', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 5500 })
    const { data: opening, error: openError } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
    })
    if (openError) throw new Error(openError.message)

    const openingEvents = await historyEvents(clientA, { p_kind: 'opening' })
    expect(openingEvents).toHaveLength(1)
    expect(openingEvents[0]!.primary_id).toBe(opening.id)
    expect(openingEvents[0]!.amount_nok_minor).toBe('5500')
    expect(openingEvents[0]!.subtitle).toContain('×1')

    // The pull lot must NOT appear again as an acquisition ("Added") event.
    const acquisitionEvents = await historyEvents(clientA, {
      p_kind: 'acquisition',
      p_include_voided: true,
    })
    const { data: openingPullRows } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('opening_id', opening.id)
    const pullIds = new Set(((openingPullRows ?? []) as { id: string }[]).map((r) => r.id))
    for (const event of acquisitionEvents) {
      expect(pullIds.has(event.primary_id)).toBe(false)
    }

    // Legacy unlinked origin='opening' lots (D-038) DO still appear as acquisitions.
    const { data: legacy } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'opening',
        p_cost_basis_state: 'unallocated_opening',
        p_quantity: 1,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()
    const legacyEvents = await historyEvents(clientA, {
      p_kind: 'acquisition',
      p_include_voided: true,
    })
    expect(legacyEvents.some((e) => e.primary_id === legacy!.lot_id)).toBe(true)

    // Voided openings hide by default and appear only through the explicit toggle.
    const { data: voidable } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
    })
    await clientA.rpc('void_opening', { p_opening_id: voidable!.id })
    const activeOnly = await historyEvents(clientA, { p_kind: 'opening' })
    expect(activeOnly.every((e) => e.status === 'active')).toBe(true)
    const withVoided = await historyEvents(clientA, {
      p_kind: 'opening',
      p_include_voided: true,
    })
    expect(withVoided.some((e) => e.primary_id === voidable!.id && e.status === 'voided')).toBe(
      true,
    )
  })

  it("Home's recent activity does not report opening pulls individually", async () => {
    const { lotId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 2100 })
    const { data: opening, error: openError } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_pulls: [
        { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 5, condition: 'NM' },
      ],
    })
    if (openError) throw new Error(openError.message)
    const activity = await recentActivity(clientA, 20)
    const { data: openingPullRows } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('opening_id', opening.id)
    const pullIds = new Set(((openingPullRows ?? []) as { id: string }[]).map((r) => r.id))
    for (const row of activity) {
      expect(pullIds.has(row.primary_id)).toBe(false)
    }
  })
})

// ── E14 reset (runs LAST in this file — it wipes user A) ────────────────────────────────────

describe('E14 — full reset clears opening state and leaves other users untouched', () => {
  let userB: SyntheticUser
  let clientB: TestClient

  beforeAll(async () => {
    userB = await createSyntheticUser(service, 'm16-openings-reset-b')
    clientB = await signInAs(userB)
  })

  afterAll(async () => {
    await deleteSyntheticUser(service, userB.id)
  })

  it('reset removes openings, their pulls, disposals and provisional purchases; B survives', async () => {
    // User B owns data that MUST survive A's reset untouched.
    const bBefore = await buySealed(clientB, { quantity: 2, unitPriceMinor: 7000 })
    const { data: bOpening } = await callCreateOpening(clientB, {
      p_source_lot_id: bBefore.lotId,
      p_quantity: 1,
    })
    expect(bOpening).not.toBeNull()

    // User A: a provisional opening plus a second linked opening with pulls.
    await clientA.rpc('create_opening_from_provisional', {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_unit_price_minor: 12345,
      p_purchased_on: today,
    })
    const aLinked = await buySealed(clientA, { quantity: 4, unitPriceMinor: 800 })
    await callCreateOpening(clientA, {
      p_source_lot_id: aLinked.lotId,
      p_quantity: 2,
      p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
    })

    const openingsBefore = await countRows('openings')
    expect(openingsBefore).toBeGreaterThanOrEqual(2)

    const { data, error } = await clientA.rpc('reset_my_portfolio_data')
    if (error) throw new Error(error.message)
    const counts = (data as Record<string, number>[])[0]!

    expect(counts.openings_deleted).toBe(openingsBefore)
    expect(counts.opening_pull_lots_deleted).toBeGreaterThanOrEqual(2)
    expect(await countRows('openings')).toBe(0)
    expect(await countRows('lot_disposals')).toBe(0)
    expect(await countRows('acquisition_lots')).toBe(0)
    expect(await countRows('holdings')).toBe(0)
    expect(await countRows('purchases')).toBe(0)

    const aSpending = await spendingOf(clientA)
    expect(aSpending.gpo_nok_minor).toBe('0')

    // B is untouched, byte-for-byte in shape.
    expect((await lotById(bBefore.lotId)).quantity_remaining).toBe(1)
    const { data: bStillThere } = await service
      .from('openings')
      .select('id, voided_at')
      .eq('id', bOpening!.id)
      .single()
    expect(bStillThere!.voided_at).toBeNull()
  })
})
