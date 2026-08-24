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
 * P43 — reset_my_portfolio_data() and list_history_events()
 * (20260901120000_p43_reset_and_history.sql).
 *
 * Reset is the ONE deliberate, destructive, atomic operation in the product (DECISIONS.md
 * D-074): this suite walks the full seed matrix from the prompt's reset test matrix — raw
 * known-cost holding, graded holding with manual valuation, sealed holding, multi-line purchase
 * with an accessory line, sale + disposal, tags/collections/memberships, M12 snapshot + queue
 * rows, and every class of reusable setup metadata — resets User A only, and asserts A is
 * genuinely empty while the preserved metadata survives exactly and User B is untouched.
 *
 * History read surface: event coverage per kind, voided filtering, kind filters, keyset
 * pagination without duplicates or omissions, and title/amount honesty.
 *
 * Cross-tenant attacks live in tests/authorization/p43_reset_history.test.ts.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p43-reset-a')
  userB = await createSyntheticUser(service, 'p43-reset-b')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

interface ResetCounts {
  purchases_deleted: number
  purchase_lines_deleted: number
  sales_deleted: number
  sale_lines_deleted: number
  lot_disposals_deleted: number
  acquisition_lots_deleted: number
  holdings_deleted: number
  manual_valuations_deleted: number
  snapshots_deleted: number
}

async function count(table: string, userId: string): Promise<number> {
  const { count } = await service
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  return count ?? 0
}

async function queueCount(userId: string): Promise<number> {
  const { count } = await service
    .from('portfolio_recompute_queue')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId)
  return count ?? 0
}

async function historyEvents(args: Record<string, unknown> = {}) {
  const { data, error } = await clientA.rpc('list_history_events', args)
  if (error) throw new Error(error.message)
  return data as {
    event_kind: string
    primary_id: string
    secondary_id: string | null
    occurred_on: string
    recorded_at: string
    title: string
    subtitle: string
    amount_nok_minor: string | null
    status: string
    href: string
  }[]
}

// ── The full User A seed ────────────────────────────────────────────────────────────────────────

describe('the seeded portfolio (sanity before reset)', () => {
  let quickAddHoldingId: string
  let quickAddLotId: string
  let gradedHoldingId: string
  let sealedHoldingId: string

  async function seedEverything() {
    // 1. Raw known-cost quick-add — creates purchase + line + lot atomically.
    const added = await clientA.rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 900,
      p_quantity: 1,
      p_acquired_on: today,
    })
    if (added.error) throw new Error(added.error.message)
    quickAddHoldingId = (added.data as { holding_id: string }).holding_id
    quickAddLotId = (added.data as { lot_id: string }).lot_id

    // 2. Multi-line purchase: two card lines + an accessory line + shipping.
    const purchase = await clientA.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 2,
          unit_price_minor: 500,
        },
        { line_type: 'accessory', description: 'Binder', quantity: 1, unit_price_minor: 300 },
      ],
      p_shipping_minor: 100,
    })
    if (purchase.error) throw new Error(purchase.error.message)

    // 3. Graded holding with a manual valuation.
    const graded = await service
      .from('holdings')
      .insert({
        user_id: userA.id,
        holding_kind: 'graded_card',
        card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
        grading_state: 'graded',
        grader: 'PSA',
        grade: 10,
      })
      .select('id')
      .single<{ id: string }>()
    gradedHoldingId = graded.data!.id
    await service.from('acquisition_lots').insert({
      holding_id: gradedHoldingId,
      user_id: userA.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: today,
      quantity: 1,
      quantity_remaining: 1,
    })
    const valued = await clientA.rpc('set_manual_valuation', {
      p_holding_id: gradedHoldingId,
      p_value_minor: 123456,
      p_note: null,
      p_effective_from: today,
    })
    if (valued.error) throw new Error(valued.error.message)

    // 4. Sealed holding (curated seed product) via direct fixture insert.
    const sealed = await service
      .from('holdings')
      .insert({
        user_id: userA.id,
        holding_kind: 'sealed',
        sealed_product_id: seedCatalog.sealedProductId,
      })
      .select('id')
      .single<{ id: string }>()
    sealedHoldingId = sealed.data!.id
    await service.from('acquisition_lots').insert({
      holding_id: sealedHoldingId,
      user_id: userA.id,
      origin: 'pre_tracking',
      cost_basis_state: 'unknown',
      acquired_on: today,
      quantity: 3,
      quantity_remaining: 3,
    })

    // 5. Sale of one unit from the quick-add lot — creates sale + sale_line + disposal.
    const sale = await clientA.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_lines: [{ lot_id: quickAddLotId, quantity: 1, unit_gross_minor: 1500 }],
      p_idempotency_key: crypto.randomUUID(),
      p_marketplace: 'Finn.no',
    })
    if (sale.error) throw new Error(sale.error.message)

    // 6. Tags / custom collections / memberships (definitions AND membership rows).
    const tag = await service
      .from('tags')
      .insert({ user_id: userA.id, name: 'p43-tag' })
      .select('id')
      .single<{ id: string }>()
    const collection = await service
      .from('custom_collections')
      .insert({ user_id: userA.id, name: 'p43-collection' })
      .select('id')
      .single<{ id: string }>()
    await service
      .from('holding_tags')
      .insert({ holding_id: quickAddHoldingId, tag_id: tag.data!.id, user_id: userA.id })
    await service.from('custom_collection_members').insert({
      collection_id: collection.data!.id,
      holding_id: gradedHoldingId,
      user_id: userA.id,
    })

    // 7. Reusable setup metadata of every preserved class.
    await service.from('retailers').insert({ user_id: userA.id, name: 'p43 retailer' })
    await service
      .from('storage_locations')
      .insert({ user_id: userA.id, name: 'p43 binder', kind: 'binder' })
    await service.from('manual_card_definitions').insert({
      user_id: userA.id,
      name: 'p43 manual card',
      set_name: 'Test Set',
    })
    await service.from('sealed_products').insert({
      product_type: 'booster_box',
      name: 'p43 custom sealed',
      language: 'en',
      created_by_user_id: userA.id,
    })

    // 8. M12 derived state: one stale snapshot row plus a pending queue row.
    await service.from('portfolio_snapshots').upsert({
      user_id: userA.id,
      snapshot_date: today,
      market_value_nok_minor: 999999,
      attributed_value_nok_minor: 999999,
      cost_basis_nok_minor: 900,
      collectible_spend_to_date_nok_minor: 900,
      sales_proceeds_to_date_nok_minor: 0,
      open_lot_count: 4,
      unvalued_lot_count: 1,
    })
    await service.from('portfolio_recompute_queue').upsert({
      user_id: userA.id,
      dirty_from: today,
    })

    // 9. One corrected mistake for the history toggle: a second quick-add whose lot was voided
    //    through the canonical correction lifecycle (auto-voiding its sole purchase).
    const mistake = await clientA.rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 50,
      p_quantity: 1,
      p_acquired_on: today,
    })
    if (mistake.error) throw new Error(mistake.error.message)
    await clientA.rpc('void_acquisition_lot', {
      p_lot_id: (mistake.data as { lot_id: string }).lot_id,
      p_reason: 'test mistake',
    })
  }

  it('seeds cleanly and History shows every expected event kind', async () => {
    await seedEverything()

    expect(await count('holdings', userA.id)).toBe(5) // quick-add, pikachu, graded, sealed, energy
    expect(await count('purchases', userA.id)).toBe(3)

    const events = await historyEvents({})
    const kinds = new Set(events.map((e) => e.event_kind))
    expect(kinds).toEqual(new Set(['purchase', 'sale', 'acquisition', 'valuation']))

    // Voided entries are hidden by default: the energy quick-add was corrected away.
    expect(events.every((e) => e.status === 'active')).toBe(true)
    // The quick-add's PURCHASE-origin lot is not double-reported as an acquisition event.
    expect(
      events.some((e) => e.event_kind === 'acquisition' && e.primary_id === quickAddLotId),
    ).toBe(false)
    // Non-purchase acquisitions ARE present, labelled by origin and linked to their holding.
    expect(events.some((e) => e.event_kind === 'acquisition' && /gift/i.test(e.subtitle))).toBe(
      true,
    )
    const acqEvent = events.find((e) => e.event_kind === 'acquisition')!
    expect(acqEvent.href).toMatch(/^\/portfolio\//)
    expect(acqEvent.secondary_id).not.toBeNull()
  })

  it('kind filters narrow the feed', async () => {
    const sales = await historyEvents({ p_kind: 'sale' })
    expect(sales.length).toBeGreaterThan(0)
    expect(sales.every((e) => e.event_kind === 'sale')).toBe(true)

    const valuations = await historyEvents({ p_kind: 'valuation' })
    expect(valuations).toHaveLength(1)
    expect(valuations[0]!.amount_nok_minor).toBe('123456')
    expect(valuations[0]!.href).toBe(`/portfolio/${valuations[0]!.secondary_id}`)
  })

  it('show-corrections reveals the voided entry without changing anything else', async () => {
    const withVoided = await historyEvents({ p_include_voided: true })
    const voided = withVoided.filter((e) => e.status === 'voided')
    expect(voided.length).toBeGreaterThanOrEqual(1) // the corrected energy purchase + its lot
    expect(withVoided.some((e) => e.event_kind === 'purchase' && e.status === 'voided')).toBe(true)

    const hidden = await historyEvents({})
    expect(hidden.every((e) => e.status === 'active')).toBe(true)
  })

  it('keyset pagination returns every event exactly once across pages', async () => {
    const all = await historyEvents({ p_include_voided: true, p_limit: 200 })
    const pageSize = 3
    const seen: string[] = []
    let cursor: { recorded_at: string; primary_id: string } | undefined
    for (;;) {
      const page = await historyEvents({
        p_include_voided: true,
        p_limit: pageSize,
        ...(cursor ? { p_before_at: cursor.recorded_at, p_before_id: cursor.primary_id } : {}),
      })
      seen.push(...page.map((e) => `${e.event_kind}:${e.primary_id}`))
      if (page.length < pageSize) break
      cursor = {
        recorded_at: page[page.length - 1]!.recorded_at,
        primary_id: page[page.length - 1]!.primary_id,
      }
    }
    const expected = all.map((e) => `${e.event_kind}:${e.primary_id}`)
    expect(seen.sort()).toEqual(expected.sort())
    // And strictly ordered newest-first within each page.
    for (let i = 1; i < all.length; i += 1) {
      const prev = all[i - 1]!
      const curr = all[i]!
      const newer =
        prev.recorded_at > curr.recorded_at ||
        (prev.recorded_at === curr.recorded_at && prev.primary_id > curr.primary_id)
      expect(newer).toBe(true)
    }
  })

  it('reset clears owned data, keeps the account and preserved metadata, and leaves B untouched', async () => {
    // User B holds independent state that must survive byte-for-byte in shape.
    const bAdded = await signInAs(userB).then(async (clientB) => {
      const result = await clientB.rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'gift',
        p_cost_basis_state: 'not_paid',
        p_quantity: 1,
        p_acquired_on: today,
      })
      if (result.error) throw new Error(result.error.message)
      return result.data as { holding_id: string }
    })
    const beforeB = {
      holdings: await count('holdings', userB.id),
      lots: await count('acquisition_lots', userB.id),
      purchases: await count('purchases', userB.id),
    }

    const profileBefore = await service
      .from('profiles')
      .select('display_name, theme')
      .eq('id', userA.id)
      .single<{ display_name: string | null; theme: string }>()

    // THE RESET — one authenticated call, no arguments at all.
    const { data, error } = await clientA.rpc('reset_my_portfolio_data')
    if (error) throw new Error(error.message)
    const counts = (data as ResetCounts[])[0]!

    expect(counts.holdings_deleted).toBe(5)
    expect(counts.acquisition_lots_deleted).toBe(5)
    expect(counts.purchases_deleted).toBe(3)
    // quick-add (1) + multi-line card & accessory (2) + the corrected energy quick-add (1).
    expect(counts.purchase_lines_deleted).toBe(4)
    expect(counts.sales_deleted).toBe(1)
    expect(counts.sale_lines_deleted).toBe(1)
    expect(counts.lot_disposals_deleted).toBe(1)
    expect(counts.manual_valuations_deleted).toBe(1)
    expect(counts.snapshots_deleted).toBe(1)

    // A: genuinely empty — no live inventory, ledger, valuation or derived state.
    expect(await count('holdings', userA.id)).toBe(0)
    expect(await count('acquisition_lots', userA.id)).toBe(0)
    expect(await count('purchases', userA.id)).toBe(0)
    expect(await count('purchase_lines', userA.id)).toBe(0)
    expect(await count('sales', userA.id)).toBe(0)
    expect(await count('sale_lines', userA.id)).toBe(0)
    expect(await count('lot_disposals', userA.id)).toBe(0)
    expect(await count('manual_valuations', userA.id)).toBe(0)
    expect(await count('holding_tags', userA.id)).toBe(0)
    expect(await count('custom_collection_members', userA.id)).toBe(0)
    expect(await count('lot_cost_adjustments', userA.id)).toBe(0)
    expect(await count('portfolio_snapshots', userA.id)).toBe(0)
    expect(await queueCount(userA.id)).toBe(0)

    // The dashboard reads honestly empty: no snapshot, nothing pending, zero counts.
    const summary = await clientA.rpc('get_dashboard_summary').single<{
      latest_snapshot_date: string | null
      physical_card_count: string
      gpo_nok_minor: string
      pending_recompute: boolean
    }>()
    if (summary.error) throw new Error(summary.error.message)
    expect(summary.data.latest_snapshot_date).toBeNull()
    expect(summary.data.physical_card_count).toBe('0')
    expect(summary.data.gpo_nok_minor).toBe('0')
    expect(summary.data.pending_recompute).toBe(false)

    // History is empty too.
    expect(await historyEvents({ p_include_voided: true })).toEqual([])

    // The account and its preferences survive.
    const profileAfter = await service
      .from('profiles')
      .select('display_name, theme')
      .eq('id', userA.id)
      .single<{ display_name: string | null; theme: string }>()
    if (profileAfter.error) throw new Error(profileAfter.error.message)
    if (profileBefore.data === null) throw new Error('profile row missing before reset')
    expect(profileAfter.data.theme).toBe(profileBefore.data.theme)

    // Preserved setup metadata, by class.
    expect(await count('retailers', userA.id)).toBe(1)
    expect(await count('storage_locations', userA.id)).toBe(1)
    expect(await count('tags', userA.id)).toBe(1)
    expect(await count('custom_collections', userA.id)).toBe(1)
    expect(await count('manual_card_definitions', userA.id)).toBe(1)
    const { data: ownSealed } = await service
      .from('sealed_products')
      .select('id')
      .eq('created_by_user_id', userA.id)
    expect((ownSealed ?? []).length).toBe(1)

    // B: byte-identical in shape to before the reset.
    expect(await count('holdings', userB.id)).toBe(beforeB.holdings)
    expect(await count('acquisition_lots', userB.id)).toBe(beforeB.lots)
    expect(await count('purchases', userB.id)).toBe(beforeB.purchases)
    const { data: bHolding } = await service
      .from('holdings')
      .select('id')
      .eq('id', bAdded.holding_id)
      .maybeSingle()
    expect(bHolding).not.toBeNull()
  })

  it('a second reset on an already-empty account succeeds with zero counts (idempotent)', async () => {
    const { data, error } = await clientA.rpc('reset_my_portfolio_data')
    if (error) throw new Error(error.message)
    const counts = (data as ResetCounts[])[0]!
    expect(Object.values(counts).every((n) => n === 0)).toBe(true)
  })

  it('History after re-seeding reflects only fresh canonical data', async () => {
    const added = await clientA.rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 700,
      p_quantity: 1,
      p_acquired_on: today,
    })
    if (added.error) throw new Error(added.error.message)

    const events = await historyEvents({})
    expect(events).toHaveLength(1)
    expect(events[0]!.event_kind).toBe('purchase')
    expect(events[0]!.amount_nok_minor).toBe('700')

    // The prompt §12 worked example end-to-end: correct the accidental entry through the
    // canonical lifecycle — no hard deletion anywhere — and watch History stop showing it.
    await clientA.rpc('void_acquisition_lot', {
      p_lot_id: (added.data as { lot_id: string }).lot_id,
      p_reason: 'accidental quick-add',
    })
    const active = await historyEvents({})
    expect(active).toEqual([])
    const corrections = await historyEvents({ p_include_voided: true })
    expect(corrections.some((e) => e.event_kind === 'purchase' && e.status === 'voided')).toBe(true)
    // void_acquisition_lot voids the lot itself AND its sole parent purchase, so both events
    // surface under the toggle — the correction is visible, never hard-deleted.
    expect(corrections.some((e) => e.event_kind === 'acquisition' && e.status === 'voided')).toBe(
      true,
    )
  })
})
