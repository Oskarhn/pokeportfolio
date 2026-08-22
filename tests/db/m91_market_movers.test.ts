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
 * M9.1 Market Movers gate (prompt §44) — the sort-mode/period screen's SQL layer
 * (`get_market_movers`, `20260827120000_m91_market_movers_sort.sql`). increase/decrease/most/least
 * movement sort correctly, insufficient-history and real-zero cases are handled honestly, quantity
 * never distorts the percentage ranking (§23's own decision), and results never cross users.
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

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm91-movers-a')
  userB = await createSyntheticUser(service, 'm91-movers-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
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

  beforeAll(async () => {
    const variants = [
      seedCatalog.pikachuVariantId,
      seedCatalog.charizardVariantId,
      seedCatalog.grassEnergyVariantId,
      seedCatalog.japaneseVariantId,
      seedCatalog.charizardShadowlessFirstEditionVariantId,
    ]
    await service.from('price_snapshots').delete().in('card_variant_id', variants)

    // pikachu: +20% (1000 -> 1200 EUR-minor). Holding A, small quantity.
    await snapshot(seedCatalog.pikachuVariantId, 1000, period + 1)
    await snapshot(seedCatalog.pikachuVariantId, 1200, 0)

    // charizard: -20% (1000 -> 800).
    await snapshot(seedCatalog.charizardVariantId, 1000, period + 1)
    await snapshot(seedCatalog.charizardVariantId, 800, 0)

    // grass energy: small movement, +5% (1000 -> 1050) — "least movement" relative to +-20%.
    await snapshot(seedCatalog.grassEnergyVariantId, 1000, period + 1)
    await snapshot(seedCatalog.grassEnergyVariantId, 1050, 0)

    // charizard shadowless/first-ed: a REAL zero current value (1000 -> 0), -100%.
    await snapshot(seedCatalog.charizardShadowlessFirstEditionVariantId, 1000, period + 1)
    await snapshot(seedCatalog.charizardShadowlessFirstEditionVariantId, 0, 0)

    // japanese variant: ONLY a current-day observation, nothing before the window start —
    // insufficient history / missing historical point. Must be excluded, never shown as 0%.
    await snapshot(seedCatalog.japaneseVariantId, 500, 0)

    await insertHolding(userA.id, seedCatalog.pikachuVariantId, 'NM', 1)
    await insertHolding(userA.id, seedCatalog.charizardVariantId, 'NM', 1)
    await insertHolding(userA.id, seedCatalog.grassEnergyVariantId, 'NM', 1)
    await insertHolding(userA.id, seedCatalog.charizardShadowlessFirstEditionVariantId, 'NM', 1)
    await insertHolding(userA.id, seedCatalog.japaneseVariantId, 'NM', 1)
    // A second pikachu holding at a much larger quantity — same unit % movement (+20%), only the
    // holding-total impact differs. Ranking by change_pct must treat it identically to the qty-1
    // holding above.
    await insertHolding(userA.id, seedCatalog.pikachuVariantId, 'MT', 50)

    // userB: a huge, unrelated movement — must never appear in userA's results.
    await insertHolding(userB.id, seedCatalog.pikachuVariantId, 'NM', 1)
  })

  it('excludes a holding with no observation before the window (insufficient/missing history)', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const variantIds = (data as { card_variant_id: string }[]).map((r) => r.card_variant_id)
    expect(variantIds).not.toContain(seedCatalog.japaneseVariantId)
  })

  it('a real zero current value is a genuine -100% mover, not excluded and not fabricated', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const row = (
      data as { card_variant_id: string; current_value_nok_minor: string; change_pct: number }[]
    ).find((r) => r.card_variant_id === seedCatalog.charizardShadowlessFirstEditionVariantId)
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
    expect(rows[0]?.card_variant_id).toBe(seedCatalog.pikachuVariantId)
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
    expect(rows[0]?.card_variant_id).toBe(seedCatalog.charizardShadowlessFirstEditionVariantId)
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
    expect(rows[0]?.card_variant_id).toBe(seedCatalog.grassEnergyVariantId)
    expect(Math.abs(rows[0]?.change_pct ?? 999)).toBe(5)
  })

  it('quantity never distorts the percentage ranking — qty 1 and qty 50 of the same mover tie on change_pct', async () => {
    const { data, error } = await clientA.rpc('get_market_movers', {
      p_period_days: period,
      p_limit: 50,
    })
    expect(error).toBeNull()
    const pikachuRows = (
      data as {
        card_variant_id: string
        quantity: number
        change_pct: number
        holding_impact_nok_minor: string
      }[]
    ).filter((r) => r.card_variant_id === seedCatalog.pikachuVariantId)
    expect(pikachuRows).toHaveLength(2)
    expect(pikachuRows[0]?.change_pct).toBe(pikachuRows[1]?.change_pct)
    // Holding-total IMPACT does scale with quantity — it is informational only, never the sort key.
    const byQty = new Map(pikachuRows.map((r) => [r.quantity, r.holding_impact_nok_minor]))
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
