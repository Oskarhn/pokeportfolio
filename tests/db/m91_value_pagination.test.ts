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
 * M9.1 pagination-correctness gate (prompt §31-32, mandatory — M9 changed what `value_desc` means
 * (D-052: holding TOTAL, not unit price) without adding the boundary tests the change called for).
 * Walks the complete `list_portfolio` result set with `p_limit=1` against a seeded dataset built
 * specifically to produce every edge case named in the prompt, and asserts the walk visits every
 * matching holding exactly once, in the same order a single large page returns — for both
 * value_desc and value_asc, and both the full portfolio and a custom-collection scope.
 *
 * The seeded values are constructed so a real tie group exists (5 holdings resolve to exactly the
 * same holding-total, via a genuine mix of manual/provider, fresh/stale, and multiple quantities of
 * a cheaper unit price landing on the same total) — a naive `ORDER BY value` with no deterministic
 * tiebreak would silently drop or duplicate rows inside a tie under keyset pagination, which is
 * exactly the defect class this test exists to catch.
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient

const today = new Date().toISOString().slice(0, 10)
function daysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

interface PortfolioRow {
  holding_id: string
  card_name: string | null
  holding_value_nok_minor: string | null
  price_state: string | null
}

async function listPortfolio(args: Record<string, unknown>): Promise<PortfolioRow[]> {
  const { data, error } = await client.rpc('list_portfolio', args)
  if (error) throw new Error(error.message)
  return data as PortfolioRow[]
}

/** Cursor fields for BOTH name-based sorts and value_desc/value_asc's own cursor shape — the SQL's
 *  cursor predicate needs all of them regardless of sort mode (unused fields are simply ignored by
 *  the branch that doesn't match p_sort). */
function cursorFrom(row: PortfolioRow) {
  return {
    p_cursor_holding_id: row.holding_id,
    p_cursor_name: row.card_name ?? '',
    p_cursor_value_minor:
      row.holding_value_nok_minor === null ? null : Number(row.holding_value_nok_minor),
    p_cursor_has_value: row.holding_value_nok_minor !== null,
  }
}

async function walkOneAtATime(
  sort: 'value_desc' | 'value_asc',
  extraArgs: Record<string, unknown> = {},
): Promise<string[]> {
  const fullPage = await listPortfolio({ p_sort: sort, p_limit: 100, ...extraArgs })
  const seen: string[] = []
  let cursor: Record<string, unknown> = {}
  // +2 guards against an infinite loop if a bug ever makes the walk never terminate.
  for (let i = 0; i < fullPage.length + 2; i += 1) {
    const page = await listPortfolio({ p_sort: sort, p_limit: 1, ...extraArgs, ...cursor })
    const first = page[0]
    if (!first) break
    seen.push(first.holding_id)
    cursor = cursorFrom(first)
  }
  return seen
}

async function insertHolding(opts: {
  cardVariantId: string
  condition: string
  quantity: number
}): Promise<string> {
  const { data: holding, error: holdingError } = await service
    .from('holdings')
    .insert({
      user_id: user.id,
      holding_kind: 'raw_card',
      card_variant_id: opts.cardVariantId,
      condition: opts.condition,
      grading_state: 'raw',
    })
    .select('id')
    .single()
  if (holdingError) throw new Error(holdingError.message)
  const { error: lotError } = await service.from('acquisition_lots').insert({
    holding_id: holding.id,
    user_id: user.id,
    origin: 'pre_tracking',
    cost_basis_state: 'unknown',
    acquired_on: today,
    quantity: opts.quantity,
    quantity_remaining: opts.quantity,
  })
  if (lotError) throw new Error(lotError.message)
  return holding.id as string
}

async function insertSnapshot(opts: {
  cardVariantId: string
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer'
  currency: 'EUR' | 'USD'
  valueMinor: number
  ageDays: number
}) {
  const { error } = await service.from('price_snapshots').upsert(
    {
      card_variant_id: opts.cardVariantId,
      provider: opts.provider,
      price_kind: opts.provider === 'tcgdex_cardmarket' ? 'cm_trend' : 'tp_market',
      source_currency: opts.currency,
      value_minor: opts.valueMinor,
      snapshot_date: daysAgo(opts.ageDays),
      provider_updated_at: new Date().toISOString(),
    },
    { onConflict: 'card_variant_id,provider,snapshot_date' },
  )
  if (error) throw new Error(error.message)
}

let h1: string, h2: string, h3: string, h4: string, h5: string, h6: string, h7: string, h8: string
let scopedCollectionId: string

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'm91-value-pagination')
  client = await signInAs(user)

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

  // pikachu: fresh EUR 10.00 -> unit 11500 NOK. H1 fresh-provider; H2 same variant/qty but a
  // MANUAL valuation of the identical total (manual vs provider, same total).
  await insertSnapshot({
    cardVariantId: seedCatalog.pikachuVariantId,
    provider: 'tcgdex_cardmarket',
    currency: 'EUR',
    valueMinor: 1000,
    ageDays: 1,
  })
  h1 = await insertHolding({
    cardVariantId: seedCatalog.pikachuVariantId,
    condition: 'NM',
    quantity: 1,
  })
  h2 = await insertHolding({
    cardVariantId: seedCatalog.pikachuVariantId,
    condition: 'MT',
    quantity: 1,
  })
  await client.rpc('set_manual_valuation', { p_holding_id: h2, p_value_minor: 11500 })

  // charizard: fresh EUR 5.00 -> unit 5750 NOK. H3 qty 2 -> total 11500 (different unit, same
  // total as H1/H2). H4 qty 1 -> total 5750 (same unit as H3, different quantity/total).
  await insertSnapshot({
    cardVariantId: seedCatalog.charizardVariantId,
    provider: 'tcgdex_cardmarket',
    currency: 'EUR',
    valueMinor: 500,
    ageDays: 1,
  })
  h3 = await insertHolding({
    cardVariantId: seedCatalog.charizardVariantId,
    condition: 'NM',
    quantity: 2,
  })
  h4 = await insertHolding({
    cardVariantId: seedCatalog.charizardVariantId,
    condition: 'MT',
    quantity: 1,
  })

  // japanese variant: a genuine zero observation (F14) -> unit 0, total 0. Real, valued, distinct
  // from "missing".
  await insertSnapshot({
    cardVariantId: seedCatalog.japaneseVariantId,
    provider: 'tcgdex_tcgplayer',
    currency: 'USD',
    valueMinor: 0,
    ageDays: 1,
  })
  h5 = await insertHolding({
    cardVariantId: seedCatalog.japaneseVariantId,
    condition: 'NM',
    quantity: 1,
  })

  // grass energy: no snapshot at all -> genuinely missing/unvalued.
  await service
    .from('price_snapshots')
    .delete()
    .eq('card_variant_id', seedCatalog.grassEnergyVariantId)
  h6 = await insertHolding({
    cardVariantId: seedCatalog.grassEnergyVariantId,
    condition: 'NM',
    quantity: 1,
  })

  // charizard shadowless/first-edition: STALE (6 days) EUR 10.00 -> unit 11500, same total as
  // H1/H2/H3 (fresh vs stale, same value) -> and a second holding of the same variant to build a
  // real 5-way tie group ("many equal-value holdings").
  await insertSnapshot({
    cardVariantId: seedCatalog.charizardShadowlessFirstEditionVariantId,
    provider: 'tcgdex_cardmarket',
    currency: 'EUR',
    valueMinor: 1000,
    ageDays: 6,
  })
  h7 = await insertHolding({
    cardVariantId: seedCatalog.charizardShadowlessFirstEditionVariantId,
    condition: 'NM',
    quantity: 1,
  })
  h8 = await insertHolding({
    cardVariantId: seedCatalog.charizardShadowlessFirstEditionVariantId,
    condition: 'GD',
    quantity: 1,
  })

  const { data: collection } = await service
    .from('custom_collections')
    .insert({ user_id: user.id, name: 'M9.1 pagination scope' })
    .select('id')
    .single()
  scopedCollectionId = collection!.id as string
  await service.from('custom_collection_members').insert(
    [h1, h3, h5, h6].map((holdingId) => ({
      collection_id: scopedCollectionId,
      holding_id: holdingId,
      user_id: user.id,
    })),
  )
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

describe('seeded fixture sanity', () => {
  it('produces the exact value shape the boundary tests below rely on', async () => {
    const rows = await listPortfolio({ p_sort: 'value_desc', p_limit: 100 })
    const byHolding = new Map(rows.map((r) => [r.holding_id, r]))
    expect(byHolding.get(h1)?.holding_value_nok_minor).toBe('11500')
    expect(byHolding.get(h2)?.holding_value_nok_minor).toBe('11500')
    expect(byHolding.get(h2)?.price_state).toBe('manual')
    expect(byHolding.get(h3)?.holding_value_nok_minor).toBe('11500')
    expect(byHolding.get(h4)?.holding_value_nok_minor).toBe('5750')
    expect(byHolding.get(h5)?.holding_value_nok_minor).toBe('0') // real zero, not missing
    expect(byHolding.get(h5)?.price_state).toBe('fresh')
    expect(byHolding.get(h6)?.holding_value_nok_minor).toBeNull() // genuinely missing
    expect(byHolding.get(h6)?.price_state).toBe('missing')
    expect(byHolding.get(h7)?.holding_value_nok_minor).toBe('11500')
    expect(byHolding.get(h7)?.price_state).toBe('stale')
    expect(byHolding.get(h8)?.holding_value_nok_minor).toBe('11500')
    // 5-way tie at 11500: h1, h2, h3, h7, h8.
    expect(rows.filter((r) => r.holding_value_nok_minor === '11500')).toHaveLength(5)
  })
})

describe('value_desc: complete, deterministic keyset walk (§31)', () => {
  it('one-row-at-a-time walk matches the single large page exactly — no duplicates, no omissions', async () => {
    const fullPage = await listPortfolio({ p_sort: 'value_desc', p_limit: 100 })
    const walked = await walkOneAtATime('value_desc')
    expect(walked).toEqual(fullPage.map((r) => r.holding_id))
    expect(new Set(walked).size).toBe(walked.length)
    // The valued -> unvalued boundary is crossed exactly once, and every unvalued row lands after
    // every valued row (value_desc: valued first, per list_portfolio's own ORDER BY precedence).
    const firstUnvaluedIndex = fullPage.findIndex((r) => r.holding_value_nok_minor === null)
    if (firstUnvaluedIndex !== -1) {
      expect(
        fullPage.slice(firstUnvaluedIndex).every((r) => r.holding_value_nok_minor === null),
      ).toBe(true)
    }
  })
})

describe('value_asc: complete, deterministic keyset walk (§31)', () => {
  it('one-row-at-a-time walk matches the single large page exactly — no duplicates, no omissions', async () => {
    const fullPage = await listPortfolio({ p_sort: 'value_asc', p_limit: 100 })
    const walked = await walkOneAtATime('value_asc')
    expect(walked).toEqual(fullPage.map((r) => r.holding_id))
    expect(new Set(walked).size).toBe(walked.length)
  })
})

describe('custom collection scope: keyset walk stays complete within the scope (§31)', () => {
  it('value_desc walk within a 4-holding custom collection visits exactly those 4, once each', async () => {
    const scopeArgs = { p_custom_collection_id: scopedCollectionId }
    const fullPage = await listPortfolio({ p_sort: 'value_desc', p_limit: 100, ...scopeArgs })
    expect(fullPage.map((r) => r.holding_id).sort()).toEqual([h1, h3, h5, h6].sort())

    const walked = await walkOneAtATime('value_desc', scopeArgs)
    expect(walked).toEqual(fullPage.map((r) => r.holding_id))
    expect(new Set(walked).size).toBe(4)
  })
})

describe('zero vs missing never collapse into each other (§32)', () => {
  it('a real zero-valued holding sorts among valued holdings, distinct from the missing bucket', async () => {
    const rows = await listPortfolio({ p_sort: 'value_asc', p_limit: 100 })
    const h5Index = rows.findIndex((r) => r.holding_id === h5)
    const h6Index = rows.findIndex((r) => r.holding_id === h6)
    expect(h5Index).toBeGreaterThanOrEqual(0)
    expect(h6Index).toBeGreaterThanOrEqual(0)
    // value_asc: valued ascending first (zero is the lowest real value), unvalued/missing last.
    expect(h5Index).toBeLessThan(h6Index)
    expect(rows[h5Index]?.holding_value_nok_minor).toBe('0')
    expect(rows[h6Index]?.holding_value_nok_minor).toBeNull()
  })
})
