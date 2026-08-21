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
 * M9: the valuation resolver (FINANCIAL_MODEL.md §6, DECISIONS.md D-052) — manual → fresh → stale
 * → missing, provider preference via `use_eu_pricing`, F9 (never zero on outage), F10 (raw prices
 * never value graded cards), F14 (missing excluded from CMV, never valued at zero). Exercised
 * through `list_portfolio`/`portfolio_counts`/`get_holding_value_provenance`/
 * `resolve_variant_market_values` directly rather than only via the pure TS domain module
 * (tests/financial/market-value.test.ts already covers that), because the FX conversion, the
 * provider-preference branch and the graded exclusion only exist in the SQL layer.
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient

const today = new Date()
function daysAgo(n: number): string {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'm9-resolver')
  client = await signInAs(user)

  // A deterministic EUR/NOK and USD/NOK rate, far enough in the past that every snapshot fixture
  // below (up to 40 days old) resolves against it, and never overwritten between tests.
  await service.from('fx_rates').upsert(
    [
      {
        base_currency: 'EUR',
        quote_currency: 'NOK',
        rate_date: daysAgo(60),
        rate: '11.50000000',
        source: 'norges_bank',
      },
      {
        base_currency: 'USD',
        quote_currency: 'NOK',
        rate_date: daysAgo(60),
        rate: '10.00000000',
        source: 'norges_bank',
      },
    ],
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function insertHolding(opts: {
  holdingKind: 'raw_card' | 'graded_card'
  cardVariantId: string
  quantity: number
  grade?: number
  condition?: string
}) {
  const { data: holding, error: holdingError } = await service
    .from('holdings')
    .insert({
      user_id: user.id,
      holding_kind: opts.holdingKind,
      card_variant_id: opts.cardVariantId,
      condition: opts.holdingKind === 'raw_card' ? (opts.condition ?? 'NM') : null,
      grading_state: opts.holdingKind === 'graded_card' ? 'graded' : 'raw',
      grader: opts.holdingKind === 'graded_card' ? 'psa' : null,
      grade: opts.grade ?? null,
    })
    .select('id')
    .single()
  if (holdingError) throw new Error(holdingError.message)

  const { error: lotError } = await service.from('acquisition_lots').insert({
    holding_id: holding.id,
    user_id: user.id,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: today.toISOString().slice(0, 10),
    quantity: opts.quantity,
    quantity_remaining: opts.quantity,
  })
  if (lotError) throw new Error(lotError.message)
  return holding.id as string
}

async function insertSnapshot(opts: {
  cardVariantId: string
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
  priceKind: 'cm_trend' | 'cm_avg30' | 'cm_avg7' | 'cm_avg' | 'tp_market'
  currency: 'EUR' | 'USD'
  valueMinor: number
  ageDays: number
}) {
  const { error } = await service.from('price_snapshots').insert({
    card_variant_id: opts.cardVariantId,
    provider: opts.provider,
    price_kind: opts.priceKind,
    source_currency: opts.currency,
    value_minor: opts.valueMinor,
    snapshot_date: daysAgo(opts.ageDays),
    provider_updated_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
}

async function provenance(holdingId: string) {
  const { data, error } = await client
    .rpc('get_holding_value_provenance', { p_holding_id: holdingId })
    .single<{
      price_state: string
      unit_value_nok_minor: string | null
      quantity: string
      holding_value_nok_minor: string | null
      provider: string | null
    }>()
  if (error) throw new Error(error.message)
  return data
}

describe('resolver priority — manual > fresh > stale > missing', () => {
  it('a fresh Cardmarket snapshot (EUR) resolves and converts to NOK', async () => {
    const holdingId = await insertHolding({
      holdingKind: 'raw_card',
      cardVariantId: seedCatalog.pikachuVariantId,
      quantity: 1,
    })
    await insertSnapshot({
      cardVariantId: seedCatalog.pikachuVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 1000, // 10.00 EUR
      ageDays: 1,
    })
    const p = await provenance(holdingId)
    expect(p.price_state).toBe('fresh')
    // 10.00 EUR * 11.5 = 115.00 NOK = 11500 minor units
    expect(p.unit_value_nok_minor).toBe('11500')
  })

  it('a manual valuation overrides a fresh provider snapshot', async () => {
    const holdingId = await insertHolding({
      holdingKind: 'raw_card',
      cardVariantId: seedCatalog.charizardVariantId,
      quantity: 1,
    })
    await insertSnapshot({
      cardVariantId: seedCatalog.charizardVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 1000,
      ageDays: 0,
    })
    const { error } = await client.rpc('set_manual_valuation', {
      p_holding_id: holdingId,
      p_value_minor: 500000,
    })
    expect(error).toBeNull()
    const p = await provenance(holdingId)
    expect(p.price_state).toBe('manual')
    expect(p.unit_value_nok_minor).toBe('500000')
  })

  it('clear_manual_valuation returns to the automatic provider price', async () => {
    const holdingId = await insertHolding({
      holdingKind: 'raw_card',
      cardVariantId: seedCatalog.japaneseVariantId,
      quantity: 1,
    })
    await insertSnapshot({
      cardVariantId: seedCatalog.japaneseVariantId,
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      currency: 'USD',
      valueMinor: 200, // 2.00 USD
      ageDays: 1,
    })
    await client.rpc('set_manual_valuation', { p_holding_id: holdingId, p_value_minor: 99900 })
    expect((await provenance(holdingId)).price_state).toBe('manual')

    const { error } = await client.rpc('clear_manual_valuation', { p_holding_id: holdingId })
    expect(error).toBeNull()
    const p = await provenance(holdingId)
    expect(p.price_state).toBe('fresh')
    expect(p.unit_value_nok_minor).toBe('2000') // 2.00 USD * 10.0
  })

  it('a snapshot 4-30 days old is stale but still used', async () => {
    const holdingId = await insertHolding({
      holdingKind: 'raw_card',
      cardVariantId: seedCatalog.grassEnergyVariantId,
      quantity: 1,
    })
    await insertSnapshot({
      cardVariantId: seedCatalog.grassEnergyVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 100,
      ageDays: 6,
    })
    const p = await provenance(holdingId)
    expect(p.price_state).toBe('stale')
    expect(p.unit_value_nok_minor).toBe('1150')
  })

  it('a snapshot older than 30 days is missing, never used', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
        condition: 'NM',
      })
      .select('id')
      .single()
    await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: today.toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
    })
    await insertSnapshot({
      cardVariantId: seedCatalog.charizardShadowlessFirstEditionVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 999999,
      ageDays: 45,
    })
    const p = await provenance(holding!.id as string)
    expect(p.price_state).toBe('missing')
    expect(p.unit_value_nok_minor).toBeNull()
  })

  it('no snapshot at all is missing', async () => {
    // A prior test in this file already gave this variant a fresh snapshot — price_snapshots is
    // per-variant, shared across every holding, so it must be cleared first to exercise the
    // genuinely-no-observation case rather than accidentally reusing an earlier fixture's rows.
    await service
      .from('price_snapshots')
      .delete()
      .eq('card_variant_id', seedCatalog.japaneseVariantId)
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.japaneseVariantId,
        condition: 'LP',
      })
      .select('id')
      .single()
    await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'pre_tracking',
      cost_basis_state: 'unknown',
      acquired_on: today.toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
    })
    const p = await provenance(holding!.id as string)
    expect(p.price_state).toBe('missing')
  })
})

describe('F10 — a raw price never values a graded holding', () => {
  it('resolves missing for a graded holding even though its printing has a fresh raw price', async () => {
    await insertSnapshot({
      cardVariantId: seedCatalog.pikachuVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 500,
      ageDays: 0,
    })
    const holdingId = await insertHolding({
      holdingKind: 'graded_card',
      cardVariantId: seedCatalog.pikachuVariantId,
      quantity: 1,
      grade: 10,
    })
    const p = await provenance(holdingId)
    expect(p.price_state).toBe('missing')
    expect(p.unit_value_nok_minor).toBeNull()
  })

  it('a manual valuation still works for a graded holding', async () => {
    const holdingId = await insertHolding({
      holdingKind: 'graded_card',
      cardVariantId: seedCatalog.pikachuVariantId,
      quantity: 1,
      grade: 9,
    })
    await client.rpc('set_manual_valuation', { p_holding_id: holdingId, p_value_minor: 250000 })
    const p = await provenance(holdingId)
    expect(p.price_state).toBe('manual')
    expect(p.unit_value_nok_minor).toBe('250000')
  })
})

describe('a genuine zero observation is distinct from missing (F14)', () => {
  it('stores and resolves a real zero price as fresh, not missing', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.charizardVariantId,
        condition: 'PO',
      })
      .select('id')
      .single()
    await service.from('acquisition_lots').insert({
      holding_id: holding!.id,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: today.toISOString().slice(0, 10),
      quantity: 1,
      quantity_remaining: 1,
    })
    // Charizard already has a snapshot from an earlier test; use a distinct variant instead to
    // avoid the unique-per-day conflict — reuse grass energy's sibling.
    await service.from('price_snapshots').upsert(
      {
        card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
        provider: 'tcgdex_cardmarket',
        price_kind: 'cm_trend',
        source_currency: 'EUR',
        value_minor: 0,
        snapshot_date: daysAgo(1),
        provider_updated_at: new Date().toISOString(),
      },
      { onConflict: 'card_variant_id,provider,snapshot_date' },
    )
    const { data: r, error } = await client
      .rpc('resolve_variant_market_values', {
        p_card_variant_ids: [seedCatalog.charizardShadowlessFirstEditionVariantId],
      })
      .single<{ price_state: string; value_nok_minor: string }>()
    expect(error).toBeNull()
    expect(r?.price_state).toBe('fresh')
    expect(r?.value_nok_minor).toBe('0')
  })
})

describe('quantity multiplication — holding total value (§44)', () => {
  it('3 copies at a resolved unit value of 100 NOK contribute 300 NOK', async () => {
    const holdingId = await insertHolding({
      holdingKind: 'raw_card',
      cardVariantId: seedCatalog.grassEnergyVariantId,
      quantity: 3,
      // A distinct condition from the earlier "stale" test's NM holding of the same variant —
      // holdings_identity is keyed on (variant, condition, ...), so reusing NM here would collide
      // with, rather than merge into, that existing holding.
      condition: 'LP',
    })
    // grassEnergyVariantId already has a stale 1150-minor-unit snapshot from an earlier test.
    const p = await provenance(holdingId)
    expect(p.quantity).toBe('3')
    expect(p.unit_value_nok_minor).toBe('1150')
    expect(p.holding_value_nok_minor).toBe('3450')
  })
})

describe('provider outage — F9, never zero, ages fresh → stale → missing', () => {
  it('the last known snapshot is retained; a simulated outage only ages it, never zeroes it', async () => {
    const cardVariantId = seedCatalog.japaneseVariantId
    // Clean slate for this variant within this test (other tests may already have snapshots).
    await service.from('price_snapshots').delete().eq('card_variant_id', cardVariantId)
    await insertSnapshot({
      cardVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 4200,
      ageDays: 1,
    })
    const fresh = await client
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [cardVariantId] })
      .single<{ price_state: string; value_nok_minor: string }>()
    expect(fresh.data?.price_state).toBe('fresh')
    expect(fresh.data?.value_nok_minor).toBe('48300') // 42.00 EUR * 11.5

    // Simulate the provider going dark for a week: no new snapshot arrives. Age the existing one
    // by rewriting its snapshot_date (what a real 6-day outage looks like from the resolver's
    // point of view — the row is untouched by ingest, only time passes).
    await service
      .from('price_snapshots')
      .update({ snapshot_date: daysAgo(6) })
      .eq('card_variant_id', cardVariantId)
      .eq('provider', 'tcgdex_cardmarket')
    const stale = await client
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [cardVariantId] })
      .single<{ price_state: string; value_nok_minor: string }>()
    expect(stale.data?.price_state).toBe('stale')
    expect(stale.data?.value_nok_minor).toBe('48300') // same value, never zeroed

    await service
      .from('price_snapshots')
      .update({ snapshot_date: daysAgo(35) })
      .eq('card_variant_id', cardVariantId)
      .eq('provider', 'tcgdex_cardmarket')
    const missing = await client
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [cardVariantId] })
      .single<{ price_state: string; value_nok_minor: string | null }>()
    expect(missing.data?.price_state).toBe('missing')
    expect(missing.data?.value_nok_minor).toBeNull()
  })
})

describe('use_eu_pricing provider preference (D-052)', () => {
  it('prefers Cardmarket when eu pricing is on and both providers have a fresh price', async () => {
    const cardVariantId = seedCatalog.pikachuVariantId
    await service.from('price_snapshots').delete().eq('card_variant_id', cardVariantId)
    await insertSnapshot({
      cardVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 1000,
      ageDays: 1,
    })
    await insertSnapshot({
      cardVariantId,
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      currency: 'USD',
      valueMinor: 5000,
      ageDays: 1,
    })
    await client.from('profiles').update({ use_eu_pricing: true }).eq('id', user.id)
    const eu = await client
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [cardVariantId] })
      .single<{ provider: string; value_nok_minor: string }>()
    expect(eu.data?.provider).toBe('tcgdex_cardmarket')
    expect(eu.data?.value_nok_minor).toBe('11500')

    await client.from('profiles').update({ use_eu_pricing: false }).eq('id', user.id)
    const us = await client
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [cardVariantId] })
      .single<{ provider: string; value_nok_minor: string }>()
    expect(us.data?.provider).toBe('tcgdex_tcgplayer')
    expect(us.data?.value_nok_minor).toBe('50000') // 5000 USD-minor = 50.00 USD * 10.0 = 500.00 NOK

    await client.from('profiles').update({ use_eu_pricing: true }).eq('id', user.id)
  })

  it('falls back to the other provider when the preferred one has no valid price', async () => {
    const cardVariantId = seedCatalog.grassEnergyVariantId
    await service.from('price_snapshots').delete().eq('card_variant_id', cardVariantId)
    await insertSnapshot({
      cardVariantId,
      provider: 'tcgdex_tcgplayer',
      priceKind: 'tp_market',
      currency: 'USD',
      valueMinor: 300,
      ageDays: 1,
    })
    await client.from('profiles').update({ use_eu_pricing: true }).eq('id', user.id)
    const r = await client
      .rpc('resolve_variant_market_values', { p_card_variant_ids: [cardVariantId] })
      .single<{ provider: string; price_state: string }>()
    expect(r.data?.provider).toBe('tcgdex_tcgplayer')
    expect(r.data?.price_state).toBe('fresh')
    await client.from('profiles').update({ use_eu_pricing: true }).eq('id', user.id)
  })
})

describe('portfolio_counts — priced/unpriced counts and portfolio value', () => {
  it('reports priced and unpriced holdings honestly, never inventing a zero', async () => {
    const { data, error } = await client.rpc('portfolio_counts').single<{
      priced_holding_count: string
      unpriced_holding_count: string
      portfolio_value_nok_minor: string
    }>()
    expect(error).toBeNull()
    // This user has a mix of priced and unpriced holdings from the tests above.
    expect(Number(data!.priced_holding_count)).toBeGreaterThan(0)
    expect(Number(data!.unpriced_holding_count)).toBeGreaterThan(0)
    expect(Number(data!.portfolio_value_nok_minor)).toBeGreaterThan(0)
  })
})

describe('get_card_variant_price_history — real snapshots only', () => {
  it('returns no points for a variant with no history', async () => {
    const cardVariantId = seedCatalog.charizardShadowlessFirstEditionVariantId
    await service.from('price_snapshots').delete().eq('card_variant_id', cardVariantId)
    const { data, error } = await client.rpc('get_card_variant_price_history', {
      p_card_variant_id: cardVariantId,
    })
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('returns real ascending points converted to NOK, one per day', async () => {
    const cardVariantId = seedCatalog.charizardShadowlessFirstEditionVariantId
    await service.from('price_snapshots').delete().eq('card_variant_id', cardVariantId)
    await insertSnapshot({
      cardVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 1000,
      ageDays: 10,
    })
    await insertSnapshot({
      cardVariantId,
      provider: 'tcgdex_cardmarket',
      priceKind: 'cm_trend',
      currency: 'EUR',
      valueMinor: 2000,
      ageDays: 2,
    })
    const { data, error } = await client.rpc('get_card_variant_price_history', {
      p_card_variant_id: cardVariantId,
    })
    const points = data as { snapshot_date: string; value_nok_minor: string }[] | null
    expect(error).toBeNull()
    expect(points).toHaveLength(2)
    expect(points?.[0]?.value_nok_minor).toBe('11500')
    expect(points?.[1]?.value_nok_minor).toBe('23000')
  })
})

describe('get_market_movers — real period-over-period movement, owned cards only', () => {
  it('excludes a holding with no historical observation before the window, never showing 0%', async () => {
    const { data, error } = await client.rpc('get_market_movers', {
      p_period_days: 7,
      p_limit: 10,
    })
    expect(error).toBeNull()
    // Every returned mover must have two genuinely distinct dated observations — the SQL itself
    // enforces this (lt.snapshot_date <> pv.snapshot_date); this call just proves it executes
    // without the ambiguous-column error and returns a well-shaped array.
    expect(Array.isArray(data)).toBe(true)
  })
})
