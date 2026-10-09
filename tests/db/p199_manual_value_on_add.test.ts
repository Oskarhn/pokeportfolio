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
 * P199: a manual value typed while ADDING a graded or sealed copy (add_card_acquisition's
 * `p_manual_value_minor`, a purchase line's `manual_value_minor`) used to INSERT a manual valuation
 * unconditionally. A holding has at most one active valuation (`manual_valuations_one_active`), so
 * adding a second copy of a graded card or sealed product that was already valued failed with a raw
 * `23505 duplicate key value violates unique constraint` and rolled the whole acquisition (lot,
 * purchase, receipt) back - for the very action the form invites ("Add another copy").
 *
 * The value typed is the same fact as pressing "Update" on the holding: a new manual value for the
 * holding (per copy), superseding the active one atomically (FINANCIAL_MODEL.md section 6, D-062).
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient
const today = new Date().toISOString().slice(0, 10)

function daysAgo(n: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p199-manual-add')
  client = await signInAs(user)
})
afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

interface ValuationRow {
  id: string
  holding_id: string
  value_nok_minor: number
  effective_from: string
  superseded_at: string | null
  created_at: string
}

async function valuations(holdingId: string): Promise<ValuationRow[]> {
  const { data, error } = await service
    .from('manual_valuations')
    .select('id, holding_id, value_nok_minor, effective_from, superseded_at, created_at')
    .eq('holding_id', holdingId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data
}

async function addGraded(args: {
  variantId: string
  grade: number
  cost: number
  manual?: number
  acquiredOn?: string
}) {
  return client.rpc('add_card_acquisition', {
    p_card_variant_id: args.variantId,
    p_grading_state: 'graded',
    p_grader: 'psa',
    p_grade: args.grade,
    p_origin: 'purchase',
    p_cost_basis_state: 'known',
    p_unit_cost_basis_minor: args.cost,
    p_quantity: 1,
    p_acquired_on: args.acquiredOn ?? today,
    p_manual_value_minor: args.manual,
  })
}

describe('add_card_acquisition: a manual value on a holding that already has one', () => {
  it('replaces the active valuation atomically instead of failing with a raw unique violation', async () => {
    const first = await addGraded({
      variantId: seedCatalog.charizardVariantId,
      grade: 10,
      cost: 50000,
      manual: 250000,
    })
    expect(first.error).toBeNull()
    const holdingId = (first.data as { holding_id: string }[])[0]!.holding_id

    const second = await addGraded({
      variantId: seedCatalog.charizardVariantId,
      grade: 10,
      cost: 60000,
      manual: 300000,
    })
    expect(second.error).toBeNull() // was: 23505 manual_valuations_one_active, acquisition rolled back
    expect((second.data as { holding_id: string }[])[0]!.holding_id).toBe(holdingId)

    const rows = await valuations(holdingId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ value_nok_minor: 250000 })
    expect(rows[0]!.superseded_at).not.toBeNull()
    // atomic replacement: the old row ends exactly when the new one is created (D-062)
    expect(rows[0]!.superseded_at).toBe(rows[1]!.created_at)
    expect(rows[1]).toMatchObject({ value_nok_minor: 300000, superseded_at: null })

    // both copies are valued at the new per-copy value, and the two acquisitions both exist
    const dash = await client.rpc('get_dashboard_summary').single<{
      graded_value_nok_minor: string
      physical_card_count: string
      manual_valued_holding_count: string
    }>()
    expect(dash.data?.physical_card_count).toBe('2')
    expect(dash.data?.manual_valued_holding_count).toBe('1')
    expect(dash.data?.graded_value_nok_minor).toBe('600000')
  })

  it('leaves the active valuation untouched when the new copy carries no manual value', async () => {
    const first = await addGraded({
      variantId: seedCatalog.pikachuVariantId,
      grade: 9,
      cost: 1000,
      manual: 4000,
    })
    expect(first.error).toBeNull()
    const holdingId = (first.data as { holding_id: string }[])[0]!.holding_id
    const second = await addGraded({
      variantId: seedCatalog.pikachuVariantId,
      grade: 9,
      cost: 1200,
    })
    expect(second.error).toBeNull()
    const rows = await valuations(holdingId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ value_nok_minor: 4000, superseded_at: null })
  })

  it('a backdated copy never moves the new valuation before the one it replaces', async () => {
    // existing valuation effective today; a copy acquired 10 days ago with a new value
    const first = await addGraded({
      variantId: seedCatalog.japaneseVariantId,
      grade: 8,
      cost: 1000,
      manual: 5000,
    })
    expect(first.error).toBeNull()
    const holdingId = (first.data as { holding_id: string }[])[0]!.holding_id
    const second = await addGraded({
      variantId: seedCatalog.japaneseVariantId,
      grade: 8,
      cost: 1000,
      manual: 7000,
      acquiredOn: daysAgo(10),
    })
    expect(second.error).toBeNull()
    const rows = await valuations(holdingId)
    expect(rows).toHaveLength(2)
    // an earlier effective_from on the replacement would sort BEFORE the row it supersedes and make
    // the historical rebuild lose the active value for every day from the old row's start; the
    // replacement therefore starts no earlier than the valuation it replaces
    expect(rows[1]!.effective_from >= rows[0]!.effective_from).toBe(true)

    const rb = await service.rpc('rebuild_portfolio_snapshots', {
      p_user_id: user.id,
      p_from: daysAgo(10),
      p_through: today,
    })
    expect(rb.error).toBeNull()
    const { data: snap } = await service
      .from('portfolio_snapshots')
      .select('unvalued_lot_count')
      .eq('user_id', user.id)
      .eq('snapshot_date', today)
      .single<{ unvalued_lot_count: number }>()
    // every lot of this user is valued today (the graded holdings above and this one)
    expect(snap?.unvalued_lot_count).toBe(0)
  })

  it('still refuses a manual value on a raw card', async () => {
    const r = await client.rpc('add_card_acquisition', {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: 10,
      p_quantity: 1,
      p_manual_value_minor: 5,
    })
    expect(r.error?.message).toMatch(/only meaningful for a graded or sealed holding/)
  })
})

describe('create_purchase: a line manual value on a holding that already has one', () => {
  const gradedLine = (manual: number | undefined, unit = 10000) => ({
    line_type: 'card',
    card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
    grading_state: 'graded',
    grader: 'psa',
    grade: 10,
    quantity: 1,
    unit_price_minor: unit,
    manual_value_minor: manual,
  })

  it('a second receipt for the same graded card replaces the value and keeps the purchase', async () => {
    const first = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [gradedLine(90000)],
    })
    expect(first.error).toBeNull()
    const second = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [gradedLine(110000, 12000)],
    })
    expect(second.error).toBeNull() // was a raw 23505, the whole receipt rolled back
    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', user.id)
      .eq('card_variant_id', seedCatalog.charizardShadowlessFirstEditionVariantId)
      .single<{ id: string }>()
    const rows = await valuations(holding!.id)
    expect(rows.map((r) => [r.value_nok_minor, r.superseded_at === null])).toEqual([
      [90000, false],
      [110000, true],
    ])
  })

  it('two lines for the same graded card in ONE receipt: the later value wins, nothing fails', async () => {
    const r = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        { ...gradedLine(1000), card_variant_id: seedCatalog.grassEnergyVariantId, grade: 7 },
        { ...gradedLine(2000), card_variant_id: seedCatalog.grassEnergyVariantId, grade: 7 },
      ],
    })
    expect(r.error).toBeNull()
    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', user.id)
      .eq('card_variant_id', seedCatalog.grassEnergyVariantId)
      .eq('grading_state', 'graded')
      .single<{ id: string }>()
    const rows = await valuations(holding!.id)
    expect(rows.map((x) => x.value_nok_minor)).toEqual([1000, 2000])
    expect(rows.filter((x) => x.superseded_at === null)).toHaveLength(1)
  })

  it('a sealed product line replaces the value the same way', async () => {
    const line = (manual: number) => ({
      line_type: 'sealed',
      sealed_product_id: seedCatalog.sealedProductId,
      quantity: 1,
      unit_price_minor: 40000,
      manual_value_minor: manual,
    })
    const a = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [line(45000)],
    })
    expect(a.error).toBeNull()
    const b = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [line(52000)],
    })
    expect(b.error).toBeNull()
    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', user.id)
      .eq('sealed_product_id', seedCatalog.sealedProductId)
      .single<{ id: string }>()
    const rows = await valuations(holding!.id)
    expect(rows.map((x) => [x.value_nok_minor, x.superseded_at === null])).toEqual([
      [45000, false],
      [52000, true],
    ])
  })
})

describe('the replaced valuation never wins a day in the rebuilt history (D-062)', () => {
  it('a receipt with two lines for one holding values every day from the later value', async () => {
    const u = await createSyntheticUser(service, 'p199-manual-hist')
    const c = await signInAs(u)
    try {
      const line = (manual: number) => ({
        line_type: 'card',
        card_variant_id: seedCatalog.pikachuVariantId,
        grading_state: 'graded',
        grader: 'psa',
        grade: 10,
        quantity: 1,
        unit_price_minor: 100,
        manual_value_minor: manual,
      })
      const r = await c.rpc('create_purchase', {
        p_purchased_on: daysAgo(5),
        p_currency: 'NOK',
        p_lines: [line(1000), line(2000)],
      })
      expect(r.error).toBeNull()
      // a later add with a new value, effective from its own date
      const later = await c.rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.pikachuVariantId,
        p_grading_state: 'graded',
        p_grader: 'psa',
        p_grade: 10,
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 100,
        p_quantity: 1,
        p_acquired_on: daysAgo(2),
        p_manual_value_minor: 3000,
      })
      expect(later.error).toBeNull()
      const rb = await service.rpc('rebuild_portfolio_snapshots', {
        p_user_id: u.id,
        p_from: daysAgo(5),
        p_through: today,
      })
      expect(rb.error).toBeNull()
      const { data } = await service
        .from('portfolio_snapshots')
        .select('snapshot_date, market_value_nok_minor, unvalued_lot_count')
        .eq('user_id', u.id)
        .order('snapshot_date')
      const byDay = new Map((data ?? []).map((s) => [s.snapshot_date, s]))
      // days -5..-3: two copies at the receipt's later value 2000; from the add on (-2): three copies at 3000
      for (const n of [5, 4, 3]) expect(byDay.get(daysAgo(n))?.market_value_nok_minor).toBe(4000)
      for (const n of [2, 1, 0]) expect(byDay.get(daysAgo(n))?.market_value_nok_minor).toBe(9000)
      expect([...byDay.values()].every((s) => s.unvalued_lot_count === 0)).toBe(true)
    } finally {
      await deleteSyntheticUser(service, u.id)
    }
  })
})
