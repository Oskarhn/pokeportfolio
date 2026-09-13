import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  mustDelete,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M9.1 Market Movers gate (prompt §44) — the sort-mode/period screen's SQL layer
 * (`get_market_movers`, `20260827120000_m91_market_movers_sort.sql`). increase/decrease/most/least
 * movement sort correctly, insufficient-history and real-zero cases are handled honestly, quantity
 * never distorts the percentage ranking (§23's own decision), and results never cross users.
 *
 * Fixture isolation (P60 cluster F / P62): the suite owns a PRIVATE card and its five variants.
 * It never reads or deletes another suite's catalog rows, and it seeds EVERY ambient fact it
 * depends on itself — including the EUR→NOK fx_rates observation the conversion CTE requires
 * (a virgin database has none). Results are therefore identical alone on a fresh database and
 * inside the full suite, regardless of file order.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

const today = new Date().toISOString().slice(0, 10)
function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** Private fixture ids, resolved in beforeAll. */
let vIncrease = '' // +20%
let vDecrease = '' // -20%
let vLeast = '' // +5%
let vZero = '' // real zero current value (-100%)
let vNoHistory = '' // only a current-day observation

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm91-movers-a')
  userB = await createSyntheticUser(service, 'm91-movers-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)

  // Private card + variants: nothing shared is touched, so neither this suite nor any other
  // can pollute the other (the M10 shared-catalog collision class).
  const { data: card, error: cardError } = await service
    .from('cards')
    .insert({
      set_id: 'c0000000-0000-0000-0000-000000000101',
      local_id: 'm91-movers-fixture-card',
      name: 'M91 Market Movers Fixture (private test card)',
      language: 'en',
    })
    .select('id')
    .single<{ id: string }>()
  if (cardError) throw new Error(cardError.message)

  const subtypes = ['increase', 'decrease', 'least', 'zero', 'nohistory'] as const
  const inserted = await service
    .from('card_variants')
    .insert(
      subtypes.map((subtype) => ({
        card_id: card.id,
        finish: 'normal',
        stamp: '',
        subtype,
        size: 'standard',
      })),
    )
    .select('id, subtype')
  if (inserted.error) throw new Error(inserted.error.message)
  const rows = inserted.data as { id: string; subtype: string }[]
  const bySubtype = new Map(rows.map((r) => [r.subtype, r.id]))
  vIncrease = bySubtype.get('increase')!
  vDecrease = bySubtype.get('decrease')!
  vLeast = bySubtype.get('least')!
  vZero = bySubtype.get('zero')!
  vNoHistory = bySubtype.get('nohistory')!

  // The suite's OWN exchange-rate fallback (P60: a fresh database has NO EUR→NOK rate at all).
  // Dated far enough back that it never overrides a newer rate in populated environments —
  // there it only guarantees virgin-DB self-sufficiency. Parity (1.0) keeps arithmetic readable.
  const { error: fxFail } = await service.from('fx_rates').upsert(
    {
      base_currency: 'EUR',
      quote_currency: 'NOK',
      rate_date: daysAgo(400),
      source: 'norges_bank',
      rate: '1.00000000',
    },
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
  if (fxFail) throw new Error(fxFail.message)
})

afterAll(async () => {
  // The synthetic users' holdings must go FIRST: holdings.card_variant_id has no cascade
  // (ON DELETE NO ACTION), so deleting the private variants while a holding still points at one
  // fails silently on an unchecked client error and leaves the fixture card/variants behind —
  // the next run in the same database then collides on cards_set_id_local_id_key (P104 finding,
  // same defect class as the m9_valuation_resolver.test.ts fix it mirrors).
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)

  // Catalog-level fixtures outlive the users — removed explicitly, private ids only.
  const variantIds = [vIncrease, vDecrease, vLeast, vZero, vNoHistory].filter((id) => id !== '')
  if (variantIds.length > 0) {
    await mustDelete(
      service.from('price_snapshots').delete().in('card_variant_id', variantIds),
      'm91 fixture price_snapshots cleanup',
    )
    await mustDelete(
      service.from('card_variants').delete().in('id', variantIds),
      'm91 fixture card_variants cleanup',
    )
    await mustDelete(
      service.from('cards').delete().eq('local_id', 'm91-movers-fixture-card'),
      'm91 fixture cards cleanup',
    )
  }
})

async function insertHolding(
  userId: string,
  cardVariantId: string,
  condition: string,
  quantity = 1,
): Promise<string> {
  const { data: holding, error } = await service
    .from('holdings')
    .insert({
      user_id: userId,
      holding_kind: 'raw_card',
      card_variant_id: cardVariantId,
      condition,
      grading_state: 'raw',
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  await service.from('acquisition_lots').insert({
    holding_id: holding.id,
    user_id: userId,
    origin: 'pre_tracking',
    cost_basis_state: 'unknown',
    acquired_on: today,
    quantity,
    quantity_remaining: quantity,
  })
  return holding.id
}

async function snapshot(cardVariantId: string, valueMinor: number, ageDays: number) {
  const { error } = await service.from('price_snapshots').upsert(
    {
      card_variant_id: cardVariantId,
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: valueMinor,
      snapshot_date: daysAgo(ageDays),
      provider_updated_at: new Date().toISOString(),
    },
    { onConflict: 'card_variant_id,provider,snapshot_date' },
  )
  if (error) throw new Error(error.message)
}

describe('get_market_movers — sort modes, honesty, isolation (prompt §44)', () => {
  const period = 7
  // The legs STRADDLE the period window start: "previous" is the newest point at/before
  // today-7 (-8 qualifies; -7 would too, so current must sit strictly inside the window),
  // "current" is simply the newest point at all (-3). The closed interval between the legs,
  // (-8, -3], contains NO EUR rate any other suite seeds (their rows date -1d/-60d/-124d/
  // -280d/-400d/-500d/-600d), so BOTH legs always resolve to the SAME rate row and every
  // expected percentage stays exact regardless of execution order or environment.
  // Self-seeding the -400d parity rate keeps the suite green on a VIRGIN database too.
  const prevAge = 8
  const currAge = 3

  beforeAll(async () => {
    // increase: +20% (1000 -> 1200 EUR-minor). Holding A, small quantity.
    await snapshot(vIncrease, 1000, prevAge)
    await snapshot(vIncrease, 1200, currAge)

    // decrease: -20% (1000 -> 800).
    await snapshot(vDecrease, 1000, prevAge)
    await snapshot(vDecrease, 800, currAge)

    // least: small movement, +5% (1000 -> 1050) — "least movement" relative to +-20%.
    await snapshot(vLeast, 1000, prevAge)
    await snapshot(vLeast, 1050, currAge)

    // zero: a REAL zero current value (1000 -> 0), -100%.
    await snapshot(vZero, 1000, prevAge)
    await snapshot(vZero, 0, currAge)

    // nohistory: ONLY a current observation, nothing at/before the window start —
    // insufficient history / missing historical point. Must be excluded, never shown as 0%.
    await snapshot(vNoHistory, 500, currAge)

    await insertHolding(userA.id, vIncrease, 'NM', 1)
    await insertHolding(userA.id, vDecrease, 'NM', 1)
    await insertHolding(userA.id, vLeast, 'NM', 1)
    await insertHolding(userA.id, vZero, 'NM', 1)
    await insertHolding(userA.id, vNoHistory, 'NM', 1)
    // A second increase holding at a much larger quantity — same unit % movement (+20%), only the
    // holding-total impact differs. Ranking by change_pct must treat it identically to the qty-1
    // holding above.
    await insertHolding(userA.id, vIncrease, 'MT', 50)

    // userB: a huge, unrelated movement — must never appear in userA's results.
    await insertHolding(userB.id, vIncrease, 'NM', 1)
  })

  it('excludes a holding with no observation before the window (insufficient/missing history)', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const variantIds = (data as { card_variant_id: string }[]).map((r) => r.card_variant_id)
    expect(variantIds).not.toContain(vNoHistory)
  })

  it('a real zero current value is a genuine -100% mover, not excluded and not fabricated', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const row = (
      data as { card_variant_id: string; current_value_nok_minor: string; change_pct: number }[]
    ).find((r) => r.card_variant_id === vZero)
    expect(row).toBeDefined()
    expect(row?.current_value_nok_minor).toBe('0')
    expect(row?.change_pct).toBe(-100)
  })

  it('highest_increase ranks the largest positive % change first', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
      p_sort: 'highest_increase',
    })
    expect(error).toBeNull()
    const rows = data as { card_variant_id: string; change_pct: number }[]
    expect(rows[0]?.card_variant_id).toBe(vIncrease)
    expect(rows[0]?.change_pct).toBe(20)
  })

  it('largest_decrease ranks the most negative % change first', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
      p_sort: 'largest_decrease',
    })
    expect(error).toBeNull()
    const rows = data as { card_variant_id: string; change_pct: number }[]
    expect(rows[0]?.card_variant_id).toBe(vZero)
    expect(rows[0]?.change_pct).toBe(-100)
  })

  it('most_movement ranks by absolute % change, largest first', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
      p_sort: 'most_movement',
    })
    expect(error).toBeNull()
    const rows = data as { change_pct: number }[]
    const pcts = rows.map((r) => Math.abs(r.change_pct))
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a))
    expect(pcts[0]).toBe(100) // the -100% zero-value mover is the largest absolute movement
  })

  it('least_movement ranks by absolute % change, smallest first', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
      p_sort: 'least_movement',
    })
    expect(error).toBeNull()
    const rows = data as { card_variant_id: string; change_pct: number }[]
    expect(rows[0]?.card_variant_id).toBe(vLeast)
    expect(Math.abs(rows[0]?.change_pct ?? 999)).toBe(5)
  })

  it('quantity never distorts the percentage ranking — qty 1 and qty 50 of the same mover tie on change_pct', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const increaseRows = (
      data as {
        card_variant_id: string
        quantity: number
        change_pct: number
        holding_impact_nok_minor: string
      }[]
    ).filter((r) => r.card_variant_id === vIncrease)
    expect(increaseRows).toHaveLength(2)
    expect(increaseRows[0]?.change_pct).toBe(increaseRows[1]?.change_pct)
    // Holding-total IMPACT does scale with quantity — it is informational only, never the sort key.
    const byQty = new Map(increaseRows.map((r) => [r.quantity, r.holding_impact_nok_minor]))
    expect(Number(byQty.get(50))).toBe(Number(byQty.get(1)) * 50)
  })

  it("never returns another user's holdings", async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const holdingIds = (data as { holding_id: string }[]).map((r) => r.holding_id)

    const { data: dataB } = await clientB.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    const holdingIdsB = ((dataB ?? []) as { holding_id: string }[]).map((r) => r.holding_id)
    for (const id of holdingIdsB) expect(holdingIds).not.toContain(id)
  })
})
