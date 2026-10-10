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
 * P209 / D-211 (FINANCIAL_MODEL.md E9): the dashboard says what the live value is built from.
 *
 * Four kinds of holding must stay distinguishable, and none may become a zero:
 *   fresh price (<= 3 days)        valued, not counted as stale
 *   stale price (4-30 days)        valued, counted stale, and its date feeds oldest_price_date
 *   expired price (> 30 days)      no value: counted unpriced, never 0
 *   a value of exactly 0           a value: counted priced AND zero-valued
 * and graded / sealed holdings, which no provider price can value, are counted separately
 * (unpriced_manual_only) so Home can say "needs a manual value" instead of "no price".
 */

let service: TestClient
let user: SyntheticUser
let client: TestClient
let cardId = ''
const variants: string[] = []
const today = new Date()
const iso = (daysAgo: number) => {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}
const insertedFx: string[] = []

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p209-disclosure')
  client = await signInAs(user)

  // an EUR rate older than every observation below (kept if one already exists on that date)
  const fxDate = iso(220)
  const have = await service
    .from('fx_rates')
    .select('rate_date')
    .eq('base_currency', 'EUR')
    .eq('quote_currency', 'NOK')
    .eq('source', 'norges_bank')
    .eq('rate_date', fxDate)
  if ((have.data ?? []).length === 0) {
    const ins = await service.from('fx_rates').insert({
      base_currency: 'EUR',
      quote_currency: 'NOK',
      rate_date: fxDate,
      rate: '11.00000000',
      source: 'norges_bank',
    })
    if (ins.error) throw new Error(ins.error.message)
    insertedFx.push(fxDate)
  }

  const card = await service
    .from('cards')
    .insert({
      set_id: seedCatalog.cardSetId,
      local_id: 'p209-disclosure',
      name: 'P209 disclosure fixture',
      language: 'en',
    })
    .select('id')
    .single<{ id: string }>()
  if (card.error) throw new Error(card.error.message)
  cardId = card.data.id
  const vr = await service
    .from('card_variants')
    .insert(
      ['fresh', 'stale', 'expired', 'zero', 'none'].map((r) => ({
        card_id: cardId,
        finish: 'normal',
        stamp: '',
        subtype: `p209-${r}`,
        size: 'standard',
      })),
    )
    .select('id, subtype')
  if (vr.error) throw new Error(vr.error.message)
  const bySubtype = new Map(
    (vr.data as { id: string; subtype: string }[]).map((v) => [v.subtype, v.id]),
  )
  for (const r of ['fresh', 'stale', 'expired', 'zero', 'none'])
    variants.push(bySubtype.get(`p209-${r}`)!)

  const obs = (variant: string, daysAgo: number, value: number) => ({
    card_variant_id: variant,
    provider: 'tcgdex_cardmarket',
    price_kind: 'cm_trend',
    source_currency: 'EUR',
    value_minor: value,
    snapshot_date: iso(daysAgo),
  })
  const ins = await service.from('price_snapshots').insert([
    obs(variants[0]!, 1, 1000), // fresh
    obs(variants[1]!, 12, 2000), // stale
    obs(variants[2]!, 40, 3000), // expired: older than the 30-day window
    obs(variants[3]!, 2, 0), // a real zero
  ])
  if (ins.error) throw new Error(ins.error.message)
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
  await service.from('price_snapshots').delete().in('card_variant_id', variants)
  await service.from('card_variants').delete().eq('card_id', cardId)
  await service.from('cards').delete().eq('id', cardId)
  for (const d of insertedFx) {
    await service
      .from('fx_rates')
      .delete()
      .eq('base_currency', 'EUR')
      .eq('quote_currency', 'NOK')
      .eq('rate_date', d)
      .eq('source', 'norges_bank')
  }
})

async function summary() {
  const r = await client.rpc('get_dashboard_summary').single<Record<string, string | null>>()
  if (r.error) throw new Error(r.error.message)
  return r.data
}

async function buyRaw(variant: string) {
  const r = await client.rpc('create_purchase', {
    p_purchased_on: iso(0),
    p_currency: 'NOK',
    p_lines: [
      {
        line_type: 'card',
        card_variant_id: variant,
        condition: 'NM',
        quantity: 1,
        unit_price_minor: 100,
      },
    ],
  })
  if (r.error) throw new Error(r.error.message)
}

describe('D-211 the dashboard discloses stale, missing and zero values separately', () => {
  it('an account with nothing priced has no oldest date and no stale or zero counts', async () => {
    await buyRaw(variants[2]!) // expired price only
    await buyRaw(variants[4]!) // never priced
    const s = await summary()
    expect(s.priced_holding_count).toBe('0')
    expect(s.unpriced_holding_count).toBe('2')
    expect(s.stale_priced_holding_count).toBe('0')
    expect(s.oldest_price_date).toBeNull()
    expect(s.zero_valued_holding_count).toBe('0')
    // both are raw cards: they can be priced by a provider, so they are not "manual only"
    expect(s.unpriced_manual_only_holding_count).toBe('0')
  })

  it('fresh, stale and zero holdings are counted apart; the oldest date is the stale observation', async () => {
    await buyRaw(variants[0]!) // fresh
    await buyRaw(variants[1]!) // stale (12 days)
    await buyRaw(variants[3]!) // priced at exactly 0
    const s = await summary()
    expect(s.priced_holding_count).toBe('3')
    expect(s.unpriced_holding_count).toBe('2') // the expired and the never-priced raw cards
    expect(s.stale_priced_holding_count).toBe('1')
    expect(s.oldest_price_date).toBe(iso(12))
    expect(s.zero_valued_holding_count).toBe('1')
    // the zero holding adds nothing to the value, and the unpriced ones are not zeros
    // the dashboard's raw value is exactly the sum of the priced rows Portfolio shows
    const list = await client.rpc('list_portfolio')
    expect(list.error).toBeNull()
    const rows = list.data as { holding_value_nok_minor: string | null; price_state: string }[]
    const sum = rows.reduce((a, r) => a + BigInt(r.holding_value_nok_minor ?? '0'), 0n)
    expect(sum > 0n).toBe(true)
    expect(BigInt(s.raw_value_nok_minor!)).toBe(sum)
    expect(rows.filter((r) => r.price_state === 'missing')).toHaveLength(2)
  })

  it('graded and sealed holdings without a manual value are "manual only", a manual 0 is a zero value', async () => {
    const graded = await client
      .rpc('add_card_acquisition', {
        p_card_variant_id: variants[0]!, // the variant HAS a raw price; the graded copy must not use it
        p_grading_state: 'graded',
        p_grader: 'psa',
        p_grade: 9,
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 5000,
        p_quantity: 1,
        p_acquired_on: iso(0),
      })
      .single<{ holding_id: string }>()
    expect(graded.error).toBeNull()
    const before = await summary()
    expect(before.unpriced_manual_only_holding_count).toBe('1')
    expect(before.graded_value_nok_minor).toBe('0')

    const sealed = await client
      .rpc('add_card_acquisition', {
        p_sealed_product_id: seedCatalog.sealedProductId,
        p_grading_state: 'raw',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 7000,
        p_quantity: 1,
        p_acquired_on: iso(0),
      })
      .single<{ holding_id: string }>()
    expect(sealed.error).toBeNull()
    const afterSealed = await summary()
    expect(afterSealed.unpriced_manual_only_holding_count).toBe('2')

    // a manual value of exactly 0 on the sealed holding is a value, not a gap
    const holdingId = sealed.data!.holding_id
    const set = await client.rpc('set_manual_valuation', {
      p_holding_id: holdingId,
      p_value_minor: 0,
    })
    expect(set.error).toBeNull()
    const afterZero = await summary()
    expect(afterZero.unpriced_manual_only_holding_count).toBe('1')
    expect(afterZero.zero_valued_holding_count).toBe('2')
    expect(afterZero.sealed_value_nok_minor).toBe('0')
  })
})
