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
import { createGiftedSealedLot } from '../m16-independent/helpers/fixtures'

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

  it('void a PROVISIONAL opening: sealed inventory restored, purchase STAYS ACTIVE (P53 §10 policy)', async () => {
    const before = await spendingOf(clientA)

    const { data: opening, error } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_total_paid_minor: 59900,
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

    // "The opening did not happen" — but the PURCHASE is a separate economic fact that really
    // happened. Voiding must NOT undo it: the money stays counted, and the sealed lot comes
    // back live. (The old symmetric-void would have created a free sealed lot.)
    const afterVoid = await spendingOf(clientA)
    expect(BigInt(afterVoid.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(59900n)
    const { data: purchase } = await service
      .from('purchases')
      .select('voided_at, origin')
      .eq('id', opening.provisional_purchase_id!)
      .single()
    expect(purchase!.voided_at).toBeNull()
    expect(purchase!.origin).toBe('provisional_opening')

    // The sealed source lot is restored via D1.
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('quantity_remaining')
      .eq('id', opening.source_lot_id)
      .single()
    expect(lot!.quantity_remaining).toBe(2)
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
        p_total_paid_minor: 19900,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (error) throw new Error(error.message)
    expect(opening.cost_source).toBe('from_lot')
    // Total-paid exactness (D-090): the ENTERED TOTAL is the opening's cost — not quantity × a
    // per-unit price. qty 3, paid 19900 in total → frozen cost exactly 19900.
    expect(opening.cost_nok_minor).toBe(19900)

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
        p_total_paid_minor: 10000,
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

describe('P56 §3–§5 — reconcile annihilates the provisional world (P54 finding H1)', () => {
  it('post-reconcile canonical world: provisional purchase, source lot AND old disposal all voided; opening repointed; real purchase counted exactly once', async () => {
    const before = await spendingOf(clientA)

    // Provisional buy-and-open: 2 units, total paid 15000.
    const { data: opening, error } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_total_paid_minor: 15000,
        p_purchased_on: today,
        p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
      })
      .single<OpeningRow>()
    if (error) throw new Error(error.message)
    const provisionalLotId = opening.source_lot_id

    // BEFORE reconcile: the whole provisional world is live.
    const { data: provPurchaseBefore } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', opening.provisional_purchase_id!)
      .single()
    expect(provPurchaseBefore!.voided_at).toBeNull()
    const provLotBefore = await lotById(provisionalLotId)
    expect(provLotBefore.voided_at).toBeNull()
    expect(provLotBefore.quantity_remaining).toBe(0)
    const liveDisposalsBefore = (await disposalsOf(provisionalLotId)).filter(
      (d) => d.voided_at === null,
    )
    expect(liveDisposalsBefore).toHaveLength(1)

    // A separate REAL purchase of the same sealed product: 4 @ 7500, no shipping.
    const { purchaseId: realPurchaseId, lotId: realLot } = await buySealed(clientA, {
      quantity: 4,
      unitPriceMinor: 7500,
    })

    const { data: reconciled, error: recError } = await clientA.rpc('reconcile_opening_cost', {
      p_opening_id: opening.id,
      p_real_source_lot_id: realLot,
    })
    if (recError) throw new Error(recError.message)
    expect(reconciled!.source_lot_id).toBe(realLot)
    expect(reconciled!.voided_at).toBeNull()

    // ── The EXACT post-reconcile canonical world (prompt §5) ──

    // OLD provisional purchase: voided.
    const { data: provPurchase } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', opening.provisional_purchase_id!)
      .single()
    expect(provPurchase!.voided_at).not.toBeNull()

    // OLD provisional acquisition lot: VOIDED — never a phantom sealed lot citing a voided
    // purchase. Historical row retained (not deleted).
    const provLotAfter = await lotById(provisionalLotId)
    expect(provLotAfter.voided_at).not.toBeNull()
    expect(provLotAfter.quantity_remaining).toBe(2) // D1 restored it before retirement

    // Every other lot of the provisional purchase is voided too — the P54 repair assertion.
    const { data: provLines } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', opening.provisional_purchase_id!)
    for (const line of provLines ?? []) {
      const { data: lotsOfLine } = await service
        .from('acquisition_lots')
        .select('voided_at')
        .eq('purchase_line_id', line.id)
      expect((lotsOfLine ?? []).length).toBeGreaterThan(0)
      expect((lotsOfLine ?? []).every((l) => l.voided_at !== null)).toBe(true)
    }

    // OLD provisional opened disposal: voided.
    const oldDisposal = (await disposalsOf(provisionalLotId)).find(
      (d) => d.opening_id === opening.id,
    )!
    expect(oldDisposal.voided_at).not.toBeNull()

    // Opening: LIVE, repointed at the real lot.
    const { data: openingAfter } = await service
      .from('openings')
      .select('voided_at, source_lot_id')
      .eq('id', opening.id)
      .single()
    expect(openingAfter!.voided_at).toBeNull()
    expect(openingAfter!.source_lot_id).toBe(realLot)

    // REAL purchase: live. REAL source lot: live, consumed by exactly the opening quantity.
    const { data: realPurchase } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', realPurchaseId)
      .single()
    expect(realPurchase!.voided_at).toBeNull()
    const realLotAfter = await lotById(realLot)
    expect(realLotAfter.voided_at).toBeNull()
    expect(realLotAfter.quantity_remaining).toBe(2) // 4 bought − 2 consumed

    // Exactly ONE live opened disposal for the opening, and it points at the real lot.
    const allOpenDisposals = (await service
      .from('lot_disposals')
      .select('lot_id, voided_at')
      .eq('opening_id', opening.id)) as unknown as { lot_id: string; voided_at: string | null }[]
    const liveOnes = allOpenDisposals.filter((d) => d.voided_at === null)
    expect(liveOnes).toHaveLength(1)
    expect(liveOnes[0]!.lot_id).toBe(realLot)

    // GPO/CS = the REAL purchase only: before + 30000, nothing from the voided provisional.
    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor)).toBe(BigInt(before.gpo_nok_minor) + 30000n)
    expect(BigInt(after.cs_nok_minor)).toBe(BigInt(before.cs_nok_minor) + 30000n)

    // Pull lots created by the provisional opening are UNCHANGED/live — reconciliation retires
    // the provisional money world (purchase + source lot + consumption), never the pulled cards.
    const { data: pulls } = await service
      .from('acquisition_lots')
      .select('voided_at')
      .eq('opening_id', opening.id)
    expect((pulls ?? []).length).toBeGreaterThan(0)
    expect((pulls ?? []).every((p) => p.voided_at === null)).toBe(true)

    // The retired world is unreachable as inventory:
    //   - create_opening on the provisional lot is refused;
    const { error: reopenError } = await callCreateOpening(clientA, {
      p_source_lot_id: provisionalLotId,
      p_quantity: 1,
    })
    expect(reopenError).not.toBeNull()
    expect(reopenError!.message).toContain('unavailable')
    //   - create_sale on the provisional lot is refused.
    const { error: resellError } = await clientA.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: provisionalLotId, quantity: 1, unit_gross_minor: 5000 }],
      p_idempotency_key: crypto.randomUUID(),
    })
    expect(resellError).not.toBeNull()
    expect(resellError!.message).toContain('unavailable')
  })

  it('reconciliation target from a PROVISIONAL purchase is REFUSED (P55 F55-10)', async () => {
    // O1 stays unreconciled; O2 is created and then VOIDED — per the P53 void policy its
    // provisional lot comes back LIVE under a still-live provisional_opening purchase, which
    // without the origin guard would be a perfectly valid-looking target.
    const { data: o1 } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_total_paid_minor: 10000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (o1?.provisional_purchase_id == null) throw new Error('expected provisional opening')

    const { data: o2 } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 3,
        p_total_paid_minor: 15000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (!o2) throw new Error('second provisional opening failed')
    const { error: voidError } = await clientA.rpc('void_opening', { p_opening_id: o2.id })
    expect(voidError).toBeNull()
    const restoredLot = await lotById(o2.source_lot_id)
    expect(restoredLot.voided_at).toBeNull() // live again...
    expect(restoredLot.quantity_remaining).toBe(3) // ...with enough units...

    // ...but it belongs to a provisional_opening purchase: refused.
    const { error: provisionalTarget } = await clientA.rpc('reconcile_opening_cost', {
      p_opening_id: o1.id,
      p_real_source_lot_id: o2.source_lot_id,
    })
    expect(provisionalTarget).not.toBeNull()
    expect(provisionalTarget!.message).toContain('unavailable')
  })

  it('reconciliation target whose purchase is VOIDED is REFUSED', async () => {
    const { data: o1 } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_total_paid_minor: 10000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (!o1) throw new Error('provisional opening failed')

    // An ordinary purchase of the same product, then voided while untouched (fully voidable).
    const { purchaseId, lotId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 7000 })
    const { error: vpError } = await clientA.rpc('void_purchase', {
      p_purchase_id: purchaseId,
      p_reason: 'wrong receipt',
    })
    expect(vpError).toBeNull()
    const voidedLot = await lotById(lotId)
    expect(voidedLot.voided_at).not.toBeNull()

    const { error: voidedTarget } = await clientA.rpc('reconcile_opening_cost', {
      p_opening_id: o1.id,
      p_real_source_lot_id: lotId,
    })
    expect(voidedTarget).not.toBeNull()
    expect(voidedTarget!.message).toContain('unavailable')
  })

  it('a LIVE ordinary purchase of the same product reconciles successfully (control case)', async () => {
    const before = await spendingOf(clientA)
    const { data: o1 } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_total_paid_minor: 10000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (!o1) throw new Error('provisional opening failed')

    const { lotId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 7000 })
    const { error: recError } = await clientA.rpc('reconcile_opening_cost', {
      p_opening_id: o1.id,
      p_real_source_lot_id: lotId,
    })
    expect(recError).toBeNull()

    const after = await spendingOf(clientA)
    // Provisional money replaced by the real receipt: 21000 attributable counted once.
    expect(BigInt(after.gpo_nok_minor)).toBe(BigInt(before.gpo_nok_minor) + 21000n)

    const sourceLot = await lotById(lotId)
    expect(sourceLot.quantity_remaining).toBe(1)
  })
})

describe('P56 §8 — get_opening coverage counts are RETAINED-only; sold pulls stay in proceeds', () => {
  interface GetOpeningRow {
    priced_pull_lot_count: number
    unpriced_pull_lot_count: number
    sold_pull_lot_count: number
    retained_tracked_value_nok_minor: string
    net_proceeds_from_sold_pulls_nok_minor: string
    opening_return_nok_minor: string | null
  }

  async function readOpening(openingId: string): Promise<GetOpeningRow> {
    const { data, error } = await clientA.rpc('get_opening', { p_opening_id: openingId }).single()
    if (error) throw new Error(error.message)
    return data as GetOpeningRow
  }

  it('a fully-sold pull leaves retained value/coverage but stays in sold count and proceeds; a partial sale keeps contributing by remaining quantity', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 10, unitPriceMinor: 1000 })
    const { data: opening } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 4,
      p_pulls: [
        // Will be valued manually, then fully sold → OUT of retained coverage.
        { card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' },
        // Never valued → unpriced, retained.
        { card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' },
        // Valued manually, partially sold (1 of 2) → contributes by remaining quantity.
        { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 2, condition: 'NM' },
      ] satisfies PullWire[],
    })
    if (!opening) throw new Error('opening failed')

    const pulls = (await service
      .from('acquisition_lots')
      .select('id, holding_id')
      .eq('opening_id', opening.id)) as unknown as { id: string; holding_id: string }[]
    expect(pulls).toHaveLength(3)

    const variantByHolding = new Map<string, string>()
    for (const pull of pulls) {
      const { data: holding } = await service
        .from('holdings')
        .select('card_variant_id')
        .eq('id', pull.holding_id)
        .single<{ card_variant_id: string | null }>()
      variantByHolding.set(pull.id, holding!.card_variant_id!)
    }
    const charizardPull = pulls.find(
      (p) => variantByHolding.get(p.id) === seedCatalog.charizardVariantId,
    )!
    const energyPull = pulls.find(
      (p) => variantByHolding.get(p.id) === seedCatalog.grassEnergyVariantId,
    )!

    // Manual valuations make priced/unpriced deterministic without market snapshots.
    const { error: mv1 } = await clientA.rpc('set_manual_valuation', {
      p_holding_id: charizardPull.holding_id,
      p_value_minor: 10000,
      p_effective_from: today,
    })
    expect(mv1).toBeNull()
    const { error: mv2 } = await clientA.rpc('set_manual_valuation', {
      p_holding_id: energyPull.holding_id,
      p_value_minor: 20000,
      p_effective_from: today,
    })
    expect(mv2).toBeNull()

    // Sell the Charizard pull fully and one Grass Energy partially.
    const { data: sale, error: saleError } = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_lines: [
          { lot_id: charizardPull.id, quantity: 1, unit_gross_minor: 12000 },
          { lot_id: energyPull.id, quantity: 1, unit_gross_minor: 25000 },
        ],
        p_idempotency_key: crypto.randomUUID(),
      })
      .single<{ id: string }>()
    if (saleError) throw new Error(saleError.message)

    const detail = await readOpening(opening.id)

    // Coverage counts are CURRENT-RETAINED only: the sold-out Charizard is excluded even though
    // it carries a manual valuation; the unpriced Pikachu and the still-retained Energy count.
    expect(detail.priced_pull_lot_count).toBe(1)
    expect(detail.unpriced_pull_lot_count).toBe(1)
    // Sold provenance is separate: BOTH sold-to lots appear.
    expect(detail.sold_pull_lot_count).toBe(2)

    // Retained tracked value = Energy only, by REMAINING quantity (1 × 20000).
    expect(BigInt(detail.retained_tracked_value_nok_minor)).toBe(20000n)

    // Proceeds include BOTH sales (net figures come from the sale ledger itself).
    const { data: lines } = await service
      .from('sale_lines')
      .select('net_proceeds_nok_minor')
      .eq('sale_id', sale.id)
    const expectedProceeds = (lines ?? []).reduce(
      (sum, l) => sum + BigInt(l.net_proceeds_nok_minor),
      0n,
    )
    expect(expectedProceeds).toBeGreaterThan(0n)
    expect(BigInt(detail.net_proceeds_from_sold_pulls_nok_minor)).toBe(expectedProceeds)
  })
})

describe('P56 §12 — widened purchase_lines CHECK: global envelope audit (D-090)', () => {
  interface LineRow {
    id: string
    quantity: number
    unit_price_minor: number
    line_total_minor: number
  }

  async function firstLineOf(purchaseId: string): Promise<LineRow> {
    const { data, error } = await service
      .from('purchase_lines')
      .select('id, quantity, unit_price_minor, line_total_minor')
      .eq('purchase_id', purchaseId)
      .single<LineRow>()
    if (error) throw new Error(error.message)
    return data
  }

  it('create_purchase writes excess-0 lines inside the envelope', async () => {
    const { lotId, purchaseId } = await buySealed(clientA, {
      quantity: 3,
      unitPriceMinor: 9998,
    })
    const line = await firstLineOf(purchaseId)
    expect(line.line_total_minor).toBe(line.unit_price_minor * line.quantity)
    const lot = await lotById(lotId)
    expect(lot.residual_nok_minor).toBe(0)
  })

  it('update_purchase still passes writing excess-0 rows', async () => {
    const { purchaseId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 5000 })
    const line = await firstLineOf(purchaseId)
    const { error } = await clientA.rpc('update_purchase', {
      p_purchase_id: purchaseId,
      p_purchased_on: today,
      p_currency: 'NOK',
      p_shipping_minor: 0,
      p_lines: [{ line_id: line.id, quantity: line.quantity, unit_price_minor: 5000 }],
    })
    expect(error).toBeNull()
    const rewritten = await firstLineOf(purchaseId)
    expect(rewritten.line_total_minor).toBe(rewritten.unit_price_minor * rewritten.quantity)
  })

  it('line_total below unit × quantity is rejected', async () => {
    const { purchaseId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 5000 })
    const line = await firstLineOf(purchaseId)
    const { error } = await service
      .from('purchase_lines')
      .update({ line_total_minor: line.unit_price_minor * line.quantity - 1 })
      .eq('id', line.id)
    expect(error).not.toBeNull()
    expect(JSON.stringify(error)).toMatch(/purchase_lines_line_total_matches_unit_price/)
  })

  it('line_total above unit × quantity + quantity − 1 is rejected', async () => {
    const { purchaseId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 5000 })
    const line = await firstLineOf(purchaseId)
    const { error } = await service
      .from('purchase_lines')
      .update({ line_total_minor: line.unit_price_minor * line.quantity + line.quantity })
      .eq('id', line.id)
    expect(error).not.toBeNull()
    expect(JSON.stringify(error)).toMatch(/purchase_lines_line_total_matches_unit_price/)
  })

  it('the full legal residual envelope accepts excess = quantity − 1 (and reverts cleanly)', async () => {
    const { purchaseId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 9998 })
    const line = await firstLineOf(purchaseId)
    const legalMax = line.unit_price_minor * line.quantity + line.quantity - 1
    const { error: up } = await service
      .from('purchase_lines')
      .update({ line_total_minor: legalMax })
      .eq('id', line.id)
    expect(up).toBeNull()
    const { error: down } = await service
      .from('purchase_lines')
      .update({ line_total_minor: line.unit_price_minor * line.quantity })
      .eq('id', line.id)
    expect(down).toBeNull()
  })

  it('quantity must be positive and unit price cannot be negative (inherited guards hold alongside)', async () => {
    const { purchaseId } = await buySealed(clientA, { quantity: 2, unitPriceMinor: 4000 })
    const line = await firstLineOf(purchaseId)
    const { error: zeroQty } = await service
      .from('purchase_lines')
      .update({ quantity: 0 })
      .eq('id', line.id)
    expect(zeroQty).not.toBeNull()
    expect(JSON.stringify(zeroQty)).toMatch(/quantity_positive/)

    const { error: negativeUnit } = await service
      .from('purchase_lines')
      .update({ unit_price_minor: -1, line_total_minor: -2 })
      .eq('id', line.id)
    expect(negativeUnit).not.toBeNull()
    expect(JSON.stringify(negativeUnit)).toMatch(
      /amounts_nonnegative|line_total_matches_unit_price/,
    )
  })

  it('the provisional path may use the legal residual: 29995 over qty 3 → unit 9998, residual 1 (I10 shape)', async () => {
    const before = await spendingOf(clientA)
    const { data: opening, error } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 3,
        p_total_paid_minor: 29995,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (error) throw new Error(error.message)
    expect(opening.cost_nok_minor).toBe(29995)

    const provLine = await lotById(opening.source_lot_id)
    expect(provLine.residual_nok_minor).toBe(1)

    // Attributable cost = line_total + allocations, exactly: allocations 0 ⇒ attributable 29995.
    const { data: lines } = await service
      .from('purchase_lines')
      .select(
        'line_total_minor, allocated_shipping_minor, allocated_customs_minor, allocated_discount_minor',
      )
      .eq('purchase_id', opening.provisional_purchase_id!)
    expect((lines ?? []).length).toBe(1)
    const l = (lines ?? [])[0] as unknown as {
      line_total_minor: number
      allocated_shipping_minor: number
      allocated_customs_minor: number
      allocated_discount_minor: number
    }
    expect(l.line_total_minor).toBe(29995)
    expect(
      l.line_total_minor +
        l.allocated_shipping_minor +
        l.allocated_customs_minor +
        l.allocated_discount_minor,
    ).toBe(29995)

    // The entered total entered GPO/CS exactly once.
    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor)).toBe(BigInt(before.gpo_nok_minor) + 29995n)
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

  it("Home's recent activity: pulls not reported individually; exactly ONE Opening row instead (I12)", async () => {
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

    // P53 §18: the exclusion is only half the contract — the opening itself gains exactly ONE
    // activity row (activity_type='opening', occurred_on=opened_on, amount=cost or NULL).
    const openingRows = activity.filter(
      (row) => row.activity_type === 'opening' && row.primary_id === opening.id,
    )
    expect(openingRows).toHaveLength(1)
    expect(openingRows[0]!.occurred_on).toBe(today)
    expect(openingRows[0]!.amount_nok_minor).toBe('2100')
  })
})

// ── P53 integration: server-side idempotency, total-paid exactness, void policy ─────────────

describe('P53 — server-side idempotency (§5/§6)', () => {
  it('I2: the same idempotency key returns the SAME committed opening — never a second one', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 4, unitPriceMinor: 5000 })
    const key = crypto.randomUUID()
    const args = {
      p_source_lot_id: lotId,
      p_quantity: 2,
      p_opened_on: today,
      p_idempotency_key: key,
    }
    const { data: first, error: firstError } = await callCreateOpening(clientA, args)
    if (firstError) throw new Error(firstError.message)
    const { data: second, error: secondError } = await callCreateOpening(clientA, args)
    expect(secondError).toBeNull()
    expect(second!.id).toBe(first.id)

    // Exactly one opening exists for the key, and only one consumption happened.
    const { count } = await service
      .from('openings')
      .select('id', { count: 'exact' })
      .eq('user_id', userA.id)
      .eq('idempotency_key', key)
    expect(count).toBe(1)
    expect((await lotById(lotId)).quantity_remaining).toBe(2)
  })

  it('I2b: the same key with MATERIALLY different arguments is refused as idempotency-key-reuse', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 3, unitPriceMinor: 4000 })
    const key = crypto.randomUUID()
    const { error: firstError } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_opened_on: today,
      p_idempotency_key: key,
    })
    expect(firstError).toBeNull()
    const { error: reuseError } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 2,
      p_opened_on: today,
      p_idempotency_key: key,
    })
    expect(reuseError).not.toBeNull()
    expect(reuseError!.message).toContain('idempotency-key-reuse')
  })

  it('I2c (P56 §14): the key identifies the ORIGINAL operation — same key/lot/quantity/date with different pulls returns the original opening, unchanged', async () => {
    const { lotId } = await buySealed(clientA, { quantity: 4, unitPriceMinor: 4000 })
    const key = crypto.randomUUID()
    const base = {
      p_source_lot_id: lotId,
      p_quantity: 2,
      p_opened_on: today,
      p_idempotency_key: key,
    }
    const { data: first, error: firstError } = await callCreateOpening(clientA, {
      ...base,
      p_pulls: [{ card_variant_id: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' }],
    })
    if (firstError) throw new Error(firstError.message)

    // A retry whose auxiliary pull list differs is STILL a replay of the same operation: the
    // material identity (lot, quantity, business date) matches, so the ORIGINAL committed
    // opening comes back and nothing new is written — no second opening, no extra pull lots.
    const { data: replayed, error: replayError } = await callCreateOpening(clientA, {
      ...base,
      p_pulls: [
        { card_variant_id: seedCatalog.pikachuVariantId, quantity: 2, condition: 'NM' },
        { card_variant_id: seedCatalog.grassEnergyVariantId, quantity: 1, condition: 'GD' },
      ],
    })
    if (replayError) throw new Error(replayError.message)
    expect(replayed.id).toBe(first.id)

    const { count } = await service
      .from('openings')
      .select('id', { count: 'exact' })
      .eq('user_id', userA.id)
      .eq('idempotency_key', key)
    expect(count).toBe(1)

    // The committed pulls are exactly the FIRST request's — the retry mutated nothing.
    const { data: pullLots } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('opening_id', first.id)
    expect(pullLots ?? []).toHaveLength(1)
    const lot = await lotById(lotId)
    expect(lot.quantity_remaining).toBe(2)
  })

  it('I3: a retried PROVISIONAL request creates ONE purchase and ONE opening — replay checked BEFORE the purchase', async () => {
    const before = await spendingOf(clientA)
    const key = crypto.randomUUID()
    const args = {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_total_paid_minor: 12300,
      p_purchased_on: today,
      p_idempotency_key: key,
    }
    const { data: first, error: firstError } = await clientA
      .rpc('create_opening_from_provisional', args)
      .single<OpeningRow>()
    if (firstError) throw new Error(firstError.message)
    const during = await spendingOf(clientA)
    expect(BigInt(during.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(12300n)

    const { data: second, error: secondError } = await clientA
      .rpc('create_opening_from_provisional', args)
      .single<OpeningRow>()
    expect(secondError).toBeNull()
    expect(second!.id).toBe(first.id)

    // One purchase, one opening, one sealed source lot; spend counted exactly once.
    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(12300n)
    const { count: purchaseCount } = await service
      .from('purchases')
      .select('id', { count: 'exact' })
      .eq('user_id', userA.id)
      .eq('origin', 'provisional_opening')
      .eq('total_minor', 12300)
    expect(purchaseCount).toBe(1)
  })

  it('P59 R4 (F-57-4): same key + same identity + DIFFERENT total paid is refused — the old financial fact never silently replays', async () => {
    const before = await spendingOf(clientA)
    const key = crypto.randomUUID()
    const base = {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_purchased_on: today,
      p_idempotency_key: key,
    }
    const { data: first, error: firstError } = await clientA
      .rpc('create_opening_from_provisional', { ...base, p_total_paid_minor: 12300 })
      .single<OpeningRow>()
    if (firstError) throw new Error(firstError.message)

    const { error: reuseError } = await clientA
      .rpc('create_opening_from_provisional', { ...base, p_total_paid_minor: 12500 })
      .single<OpeningRow>()
    expect(reuseError).not.toBeNull()
    expect(reuseError!.message).toContain('idempotency-key-reuse')

    // The committed opening and its purchase are untouched; spend counted exactly once.
    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(12300n)
    const { count } = await service
      .from('purchases')
      .select('id', { count: 'exact' })
      .eq('user_id', userA.id)
      .eq('origin', 'provisional_opening')
      .eq('total_minor', 12300)
    expect(count).toBe(1)
    expect(first.cost_nok_minor).toBe(12300)
  })

  it('P59 R5 (F-57-4): same key + same total + DIFFERENT purchased_on is refused — the business date is material', async () => {
    const before = await spendingOf(clientA)
    const key = crypto.randomUUID()
    const base = {
      p_sealed_product_id: seedCatalog.sealedProductId,
      p_quantity: 1,
      p_total_paid_minor: 9900,
      p_purchased_on: today,
      p_idempotency_key: key,
    }
    const { data: first, error: firstError } = await clientA
      .rpc('create_opening_from_provisional', base)
      .single<OpeningRow>()
    if (firstError) throw new Error(firstError.message)

    const yesterday = dateOffset(-1)
    const { error: reuseError } = await clientA
      .rpc('create_opening_from_provisional', { ...base, p_purchased_on: yesterday })
      .single<OpeningRow>()
    expect(reuseError).not.toBeNull()
    expect(reuseError!.message).toContain('idempotency-key-reuse')

    // The committed receipt keeps its original business date; no second purchase exists.
    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(9900n)
    const { data: purchases } = await service
      .from('purchases')
      .select('id, purchased_on')
      .eq('user_id', userA.id)
      .eq('origin', 'provisional_opening')
      .eq('total_minor', 9900)
    expect(purchases ?? []).toHaveLength(1)
    expect(purchases![0]?.purchased_on).toBe(today)
    // And a full replay with EVERYTHING matching still returns the original opening.
    const { data: replayed, error: replayError } = await clientA
      .rpc('create_opening_from_provisional', base)
      .single<OpeningRow>()
    if (replayError) throw new Error(replayError.message)
    expect(replayed.id).toBe(first.id)
  })

  it('cross-user same UUID is two independent legitimate keys (composite uniqueness)', async () => {
    // User A opens under a chosen key.
    const { lotId } = await buySealed(clientA, { quantity: 1, unitPriceMinor: 8000 })
    const sharedKey = crypto.randomUUID()
    const { error: aError } = await callCreateOpening(clientA, {
      p_source_lot_id: lotId,
      p_quantity: 1,
      p_opened_on: today,
      p_idempotency_key: sharedKey,
    })
    expect(aError).toBeNull()

    // The SAME literal UUID from user B names a DIFFERENT operation and succeeds independently.
    const userB = await createSyntheticUser(service, 'm16-idem-cross-b')
    try {
      const clientB = await signInAs(userB)
      const bBuy = await buySealed(clientB, { quantity: 1, unitPriceMinor: 8000 })
      const { error: bError } = await callCreateOpening(clientB, {
        p_source_lot_id: bBuy.lotId,
        p_quantity: 1,
        p_opened_on: today,
        p_idempotency_key: sharedKey,
      })
      expect(bError).toBeNull()
    } finally {
      await deleteSyntheticUser(service, userB.id)
    }
  })

  it('I10: bought-and-opened total-paid 29995 over qty 3 splits 9998 + residual 1 exactly', async () => {
    const before = await spendingOf(clientA)
    const { data: opening, error } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 3,
        p_total_paid_minor: 29995,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (error) throw new Error(error.message)

    // GPO/CS increased by the TOTAL PAID exactly once (P53 §13).
    const after = await spendingOf(clientA)
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(29995n)
    expect(after.gpo_nok_minor).toBe(after.cs_nok_minor)

    // The lot carries floor-unit + residual; opening all 3 exhausts it at exactly 29995.
    const lot = await lotById(opening.source_lot_id)
    expect(lot.unit_cost_basis_nok_minor).toBe(9998)
    expect(lot.residual_nok_minor).toBe(1)
    expect(lot.quantity_remaining).toBe(0)
    expect(opening.cost_nok_minor).toBe(29995)
    expect(opening.cost_source).toBe('from_lot')

    // Line-level honesty: unit_price is the derived display value, line_total is the EXACT total.
    const { data: line } = await service
      .from('purchase_lines')
      .select('unit_price_minor, line_total_minor, attributable_cost_nok_minor')
      .eq('purchase_id', opening.provisional_purchase_id!)
      .single<{
        unit_price_minor: number
        line_total_minor: number
        attributable_cost_nok_minor: number
      }>()
    expect(line!.unit_price_minor).toBe(9998)
    expect(line!.line_total_minor).toBe(29995)
    expect(line!.attributable_cost_nok_minor).toBe(29995)
  })

  it('I6: known-zero cost is representable; unknown stays NULL — they are different facts', async () => {
    // A provisional entry of total 0 IS a legitimate known-zero basis (genuinely free).
    const { data: zeroCost, error: zeroError } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 1,
        p_total_paid_minor: 0,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (zeroError) throw new Error(zeroError.message)
    expect(zeroCost.cost_source).toBe('from_lot')
    expect(zeroCost.cost_nok_minor).toBe(0)

    // An unknown-cost gift lot keeps cost NULL — never coalesced to the zero above.
    const gifted = await createGiftedSealedLot(service, userA.id, seedCatalog.sealedProductId, 1)
    const { data: unknownCost, error: unknownError } = await callCreateOpening(clientA, {
      p_source_lot_id: gifted.lotId,
      p_quantity: 1,
      p_opened_on: today,
    })
    if (unknownError) throw new Error(unknownError.message)
    expect(unknownCost.cost_source).toBe('unknown')
    expect(unknownCost.cost_nok_minor).toBeNull()
  })

  it('I7/I8: void restores sealed inventory and NEVER touches the purchase — linked or provisional', async () => {
    const before = await spendingOf(clientA)

    // Provisional path: buy-and-open 1 of 2, then void the opening.
    const { data: provOpening, error: provError } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 1,
        p_total_paid_minor: 15000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (provError) throw new Error(provError.message)
    const { error: voidError } = await clientA.rpc('void_opening', {
      p_opening_id: provOpening.id,
    })
    expect(voidError).toBeNull()

    // Sealed restored; purchase still live and still counted (P53 §10 final policy).
    const lot = await lotById(provOpening.source_lot_id)
    expect(lot.quantity_remaining).toBe(1)
    const { data: purchase } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', provOpening.provisional_purchase_id!)
      .single()
    expect(purchase!.voided_at).toBeNull()

    // I9: the PURCHASE correction surface removes incorrect spend separately, exactly once.
    const { error: voidPurchaseError } = await clientA.rpc('void_purchase', {
      p_purchase_id: provOpening.provisional_purchase_id!,
      p_reason: 'recorded wrong amount',
    })
    expect(voidPurchaseError).toBeNull()
    const afterCorrection = await spendingOf(clientA)
    expect(BigInt(afterCorrection.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(0n)
  })
})

// ── P59 §10: reconciliation-target discovery provenance ─────────────────────────────────────

describe('P59 §10 — list_opening_sources carries owner-only purchase provenance for the picker', () => {
  interface ProvenanceSourceRow {
    lot_id: string
    sealed_product_id: string
    quantity_available: number
    cost_known: boolean
    purchase_id: string | null
    purchase_origin: string | null
    purchased_on: string | null
  }

  it('a provisional lot exposes its provisional parent; an ordinary receipt reads manual — the picker can mirror the server rule', async () => {
    // The buy-and-open lot stays live with a provisional parent until reconciled.
    const { data: provOpening, error: provError } = await clientA
      .rpc('create_opening_from_provisional', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_quantity: 2,
        p_total_paid_minor: 15000,
        p_purchased_on: today,
      })
      .single<OpeningRow>()
    if (provError) throw new Error(provError.message)

    const real = await buySealed(clientA, {
      quantity: 4,
      unitPriceMinor: 3000,
      shippingMinor: 200,
      purchasedOn: dateOffset(-3),
    })

    const { data, error } = await clientA.rpc('list_opening_sources')
    if (error) throw new Error(error.message)
    const rows = data as ProvenanceSourceRow[]

    // The provisional-parent row is identifiable so the reconciliation picker can exclude it
    // client-side (the server refuses it regardless).
    const provRow = rows.find((row) => row.lot_id === provOpening.source_lot_id)
    expect(provRow).toBeDefined()
    expect(provRow!.purchase_origin).toBe('provisional_opening')
    expect(provRow!.purchased_on).toBe(today)

    // A legitimate reconciliation target carries its real provenance for display.
    const realRow = rows.find((row) => row.lot_id === real.lotId)
    expect(realRow).toBeDefined()
    expect(realRow!.purchase_origin).toBe('manual')
    expect(realRow!.purchased_on).toBe(dateOffset(-3))
    expect(realRow!.quantity_available).toBe(4)
    expect(realRow!.cost_known).toBe(true)
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
      p_total_paid_minor: 12345,
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
