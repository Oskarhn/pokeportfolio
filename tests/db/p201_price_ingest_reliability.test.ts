import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  mustDelete,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P201 — the ingest work queue and the row-by-row, order-aware snapshot write
 * (supabase/migrations/20261009140000_p201_price_ingest_reliability.sql).
 *
 * Fixture isolation: the suite owns a PRIVATE card and its own variants and only ever asserts about
 * those ids. `select_price_sync_batch` is global (every user's watched variants), so it is called
 * with the maximum batch size and filtered to the fixture rather than assuming an otherwise-empty
 * database.
 */

let service: TestClient
let user: SyntheticUser
let userClient: TestClient

const ROLES = ['never', 'priced', 'unpriced', 'failed', 'bad'] as const
const variantIds = new Map<(typeof ROLES)[number], string>()
let cardId = ''

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

function v(role: (typeof ROLES)[number]): string {
  return variantIds.get(role)!
}

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p201-ingest')
  userClient = await signInAs(user)

  const { data: card, error } = await service
    .from('cards')
    .insert({
      set_id: seedCatalog.cardSetId,
      local_id: 'p201-ingest-fixture-card',
      name: 'P201 Ingest Fixture (private test card)',
      language: 'en',
      tcgdex_card_id: 'p201-fixture-1',
    })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(error.message)
  cardId = card.id

  const inserted = await service
    .from('card_variants')
    .insert(
      ROLES.map((role) => ({
        card_id: cardId,
        finish: 'normal',
        stamp: '',
        subtype: role,
        size: 'standard',
      })),
    )
    .select('id, subtype')
  if (inserted.error) throw new Error(inserted.error.message)
  for (const row of inserted.data as { id: string; subtype: (typeof ROLES)[number] }[]) {
    variantIds.set(row.subtype, row.id)
  }

  // Own every fixture variant, so each is in `watched_card_variants`.
  for (const role of ROLES) {
    const { data: holding, error: holdingError } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: v(role),
        condition: 'NM',
        grading_state: 'raw',
      })
      .select('id')
      .single()
    if (holdingError) throw new Error(holdingError.message)
    const { error: lotError } = await service.from('acquisition_lots').insert({
      holding_id: holding.id,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: day(0),
      quantity: 1,
      quantity_remaining: 1,
    })
    if (lotError) throw new Error(lotError.message)
  }
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
  const ids = [...variantIds.values()]
  if (ids.length > 0) {
    await mustDelete(
      service.from('price_snapshots').delete().in('card_variant_id', ids),
      'p201 snapshots cleanup',
    )
    await mustDelete(
      service.from('price_sync_attempts').delete().in('card_variant_id', ids),
      'p201 attempts cleanup',
    )
    await mustDelete(service.from('card_variants').delete().in('id', ids), 'p201 variants cleanup')
  }
  await mustDelete(
    service.from('cards').delete().eq('local_id', 'p201-ingest-fixture-card'),
    'p201 card cleanup',
  )
})

interface Counts {
  written: number
  unchanged: number
  superseded: number
  rejected: number
  attempts_recorded: number
}

async function ingest(observations: unknown[], attempts: unknown[] = []): Promise<Counts> {
  const { data, error } = await service
    .rpc('ingest_price_observations', { p_observations: observations, p_attempts: attempts })
    .single<Counts>()
  if (error) throw new Error(error.message)
  return data
}

function obs(
  role: (typeof ROLES)[number],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    card_variant_id: v(role),
    provider: 'tcgdex_cardmarket',
    price_kind: 'cm_trend',
    source_currency: 'EUR',
    value_minor: 500,
    snapshot_date: day(-1),
    provider_updated_at: iso(-3_600_000),
    ...over,
  }
}

async function snapshot(role: (typeof ROLES)[number], date = day(-1)) {
  const { data, error } = await service
    .from('price_snapshots')
    .select('value_minor, price_kind, provider_updated_at')
    .eq('card_variant_id', v(role))
    .eq('provider', 'tcgdex_cardmarket')
    .eq('snapshot_date', date)
    .maybeSingle<{ value_minor: number; price_kind: string; provider_updated_at: string | null }>()
  if (error) throw new Error(error.message)
  return data
}

async function queueOrder(): Promise<string[]> {
  const { data, error } = await service.rpc('select_price_sync_batch', { p_batch_size: 2000 })
  if (error) throw new Error(error.message)
  const mine = new Set(variantIds.values())
  return (data as { card_variant_id: string }[])
    .map((r) => r.card_variant_id)
    .filter((id) => mine.has(id))
}

async function setAttempt(
  role: (typeof ROLES)[number],
  outcome: 'priced' | 'no_price' | 'provider_failed',
  attemptedAgoMs: number,
  consecutiveUnpriced = 0,
) {
  const { error } = await service.from('price_sync_attempts').upsert({
    card_variant_id: v(role),
    last_attempt_at: iso(-attemptedAgoMs),
    last_outcome: outcome,
    consecutive_unpriced: consecutiveUnpriced,
    consecutive_failed: outcome === 'provider_failed' ? 1 : 0,
  })
  if (error) throw new Error(error.message)
}

describe('ingest_price_observations — one bad row never costs the valid ones their write', () => {
  it('writes the valid rows and counts every kind of bad row as rejected', async () => {
    const result = await ingest([
      obs('priced', { value_minor: 1234 }),
      obs('never', { value_minor: -5 }), // CHECK value_minor >= 0
      obs('failed', { snapshot_date: '2026-02-31' }), // a day that does not exist
      obs('bad', { snapshot_date: day(30) }), // refused by the future-date trigger
      obs('unpriced', { card_variant_id: '00000000-0000-4000-8000-0000000000ff' }), // no such variant
      obs('unpriced', { source_currency: 'USD' }), // pairing CHECK: Cardmarket must be EUR
      obs('unpriced', { provider: 'not_a_provider' }), // enum cast
      obs('unpriced', { card_variant_id: 'not-a-uuid' }),
    ])
    expect(result).toMatchObject({ written: 1, rejected: 7, unchanged: 0, superseded: 0 })
    expect((await snapshot('priced'))!.value_minor).toBe(1234)
    expect(await snapshot('never')).toBeNull()
    expect(await snapshot('failed')).toBeNull()
    expect(await snapshot('bad')).toBeNull()
  })

  it('writes a genuine zero (a real observation, not an absent one)', async () => {
    const result = await ingest([obs('never', { value_minor: 0 })])
    expect(result.written).toBe(1)
    expect((await snapshot('never'))!.value_minor).toBe(0)
    await service.from('price_snapshots').delete().eq('card_variant_id', v('never'))
  })

  it('rejects a payload that is not an array, loudly rather than as a zero', async () => {
    const { error } = await service.rpc('ingest_price_observations', {
      p_observations: { not: 'an array' },
    })
    expect(error?.message).toMatch(/arrays/)
  })
})

describe('ingest_price_observations — out-of-order and duplicate delivery', () => {
  const T2 = () => iso(-60_000)
  const T1 = () => iso(-7_200_000)

  it('an older observation of the same day never replaces a newer one', async () => {
    await service.from('price_snapshots').delete().eq('card_variant_id', v('failed'))
    const newer = T2()
    expect(
      (await ingest([obs('failed', { value_minor: 900, provider_updated_at: newer })])).written,
    ).toBe(1)
    const result = await ingest([obs('failed', { value_minor: 100, provider_updated_at: T1() })])
    expect(result).toMatchObject({ written: 0, superseded: 1, unchanged: 0 })
    const row = (await snapshot('failed'))!
    expect(row.value_minor).toBe(900)
    expect(new Date(row.provider_updated_at!).getTime()).toBe(new Date(newer).getTime())
  })

  it('a delivery with no provider timestamp does not replace one that has it', async () => {
    const result = await ingest([obs('failed', { value_minor: 1, provider_updated_at: null })])
    expect(result).toMatchObject({ written: 0, superseded: 1 })
    expect((await snapshot('failed'))!.value_minor).toBe(900)
  })

  it('a newer observation replaces an older one and refreshes the provenance fields', async () => {
    const result = await ingest([
      obs('failed', { value_minor: 950, price_kind: 'cm_avg30', provider_updated_at: iso(-1000) }),
    ])
    expect(result.written).toBe(1)
    expect(await snapshot('failed')).toMatchObject({ value_minor: 950, price_kind: 'cm_avg30' })
  })

  it('the identical delivery twice is counted as unchanged, not rewritten', async () => {
    const payload = [
      obs('failed', { value_minor: 950, price_kind: 'cm_avg30', provider_updated_at: iso(-1000) }),
    ]
    // the second call carries the exact same instant the first one stored
    const stored = (await snapshot('failed'))!.provider_updated_at
    const same = [{ ...payload[0], provider_updated_at: stored }]
    expect(await ingest(same)).toMatchObject({ written: 0, unchanged: 1, superseded: 0 })
  })

  it('a first observation with no timestamp is upgraded by a later one that has one', async () => {
    await service.from('price_snapshots').delete().eq('card_variant_id', v('bad'))
    expect((await ingest([obs('bad', { provider_updated_at: null })])).written).toBe(1)
    expect((await ingest([obs('bad', { value_minor: 777 })])).written).toBe(1)
    expect((await snapshot('bad'))!.value_minor).toBe(777)
  })

  it('two concurrent identical deliveries both succeed and leave exactly one row', async () => {
    await service.from('price_snapshots').delete().eq('card_variant_id', v('unpriced'))
    const payload = [obs('unpriced', { value_minor: 321, provider_updated_at: iso(-5000) })]
    const [a, b] = await Promise.all([ingest(payload), ingest(payload)])
    expect(a.written + b.written).toBeGreaterThanOrEqual(1)
    expect(a.rejected + b.rejected).toBe(0)
    const { count } = await service
      .from('price_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('card_variant_id', v('unpriced'))
    expect(count).toBe(1)
  })
})

describe('the future-date trigger', () => {
  it('refuses a direct insert more than a day ahead, whatever the caller', async () => {
    const { error } = await service.from('price_snapshots').insert({
      card_variant_id: v('never'),
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: 1,
      snapshot_date: day(40),
    })
    expect(error?.code).toBe('23514')
  })

  it('tolerates tomorrow (clock skew between the provider and the database)', async () => {
    const { error } = await service.from('price_snapshots').insert({
      card_variant_id: v('never'),
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: 1,
      snapshot_date: day(1),
    })
    expect(error).toBeNull()
    await service.from('price_snapshots').delete().eq('card_variant_id', v('never'))
  })
})

describe('select_price_sync_batch — the queue advances by attempt, not by provider date', () => {
  it('lists a never-attempted variant before one attempted earlier today', async () => {
    await service
      .from('price_sync_attempts')
      .delete()
      .in('card_variant_id', [...variantIds.values()])
    await setAttempt('priced', 'priced', 3_600_000)
    const order = await queueOrder()
    expect(order).toContain(v('never'))
    expect(order.indexOf(v('never'))).toBeLessThan(order.indexOf(v('priced')))
  })

  it('orders attempted variants least-recently-attempted first', async () => {
    await setAttempt('priced', 'priced', 1_000)
    await setAttempt('failed', 'provider_failed', 86_400_000)
    await setAttempt('never', 'priced', 3_600_000)
    const order = (await queueOrder()).filter((id) =>
      [v('priced'), v('failed'), v('never')].includes(id),
    )
    expect(order).toEqual([v('failed'), v('never'), v('priced')])
  })

  it('a variant with no price is NOT re-selected every tick — the starvation defect', async () => {
    await setAttempt('unpriced', 'no_price', 60_000, 1)
    expect(await queueOrder()).not.toContain(v('unpriced'))
  })

  it('backs off for as many days as it has come back unpriced, capped at a week', async () => {
    await setAttempt('unpriced', 'no_price', 1.5 * 86_400_000, 2)
    expect(await queueOrder()).not.toContain(v('unpriced'))
    await setAttempt('unpriced', 'no_price', 2.5 * 86_400_000, 2)
    expect(await queueOrder()).toContain(v('unpriced'))
    await setAttempt('unpriced', 'no_price', 8 * 86_400_000, 40)
    expect(await queueOrder()).toContain(v('unpriced'))
    await setAttempt('unpriced', 'no_price', 6 * 86_400_000, 40)
    expect(await queueOrder()).not.toContain(v('unpriced'))
  })

  it('keeps retrying a provider failure (the card may be fine; the provider was not)', async () => {
    await setAttempt('failed', 'provider_failed', 60_000)
    expect(await queueOrder()).toContain(v('failed'))
  })

  it('a variant with stale provider data does not jump the queue after a successful attempt', async () => {
    // old provider date, but attempted a moment ago: it must sort AFTER a variant attempted an hour ago
    await service.from('price_snapshots').delete().eq('card_variant_id', v('priced'))
    await ingest([
      obs('priced', { snapshot_date: day(-20), provider_updated_at: iso(-20 * 86_400_000) }),
    ])
    await setAttempt('priced', 'priced', 1_000)
    await setAttempt('never', 'priced', 3_600_000)
    const order = (await queueOrder()).filter((id) => [v('priced'), v('never')].includes(id))
    expect(order).toEqual([v('never'), v('priced')])
  })

  it('reports the newest snapshot date of each selected variant', async () => {
    const { data } = await service.rpc('select_price_sync_batch', { p_batch_size: 2000 })
    const row = (data as { card_variant_id: string; last_snapshot_date: string | null }[]).find(
      (r) => r.card_variant_id === v('priced'),
    )
    expect(row?.last_snapshot_date).toBe(day(-20))
  })

  it('respects the batch size bounds', async () => {
    const one = await service.rpc('select_price_sync_batch', { p_batch_size: 1 })
    expect(one.data).toHaveLength(1)
    const clamped = await service.rpc('select_price_sync_batch', { p_batch_size: -5 })
    expect(clamped.data).toHaveLength(1)
  })
})

describe('attempt recording', () => {
  it('counts consecutive unpriced attempts and resets on success', async () => {
    await service.from('price_sync_attempts').delete().eq('card_variant_id', v('never'))
    await ingest([], [{ card_variant_id: v('never'), outcome: 'no_price' }])
    await ingest([], [{ card_variant_id: v('never'), outcome: 'no_price' }])
    const two = await service
      .from('price_sync_attempts')
      .select('consecutive_unpriced, last_outcome')
      .eq('card_variant_id', v('never'))
      .single()
    expect(two.data).toMatchObject({ consecutive_unpriced: 2, last_outcome: 'no_price' })
    await ingest([], [{ card_variant_id: v('never'), outcome: 'priced' }])
    const reset = await service
      .from('price_sync_attempts')
      .select('consecutive_unpriced, last_outcome')
      .eq('card_variant_id', v('never'))
      .single()
    expect(reset.data).toMatchObject({ consecutive_unpriced: 0, last_outcome: 'priced' })
  })

  it('ignores an attempt with an unknown outcome or unknown variant instead of failing the call', async () => {
    const result = await ingest(
      [],
      [
        { card_variant_id: v('never'), outcome: 'exploded' },
        { card_variant_id: '00000000-0000-4000-8000-0000000000fe', outcome: 'priced' },
        { card_variant_id: v('never'), outcome: 'provider_failed' },
      ],
    )
    expect(result.attempts_recorded).toBe(1)
  })
})

describe('privileges — nothing here is reachable from a browser role', () => {
  it('a signed-in user cannot call the ingest RPC or the queue', async () => {
    const write = await userClient.rpc('ingest_price_observations', { p_observations: [] })
    expect(write.error).not.toBeNull()
    const queue = await userClient.rpc('select_price_sync_batch', { p_batch_size: 5 })
    expect(queue.error).not.toBeNull()
  })

  it('a signed-in user can neither read nor write the attempts table', async () => {
    const read = await userClient.from('price_sync_attempts').select('card_variant_id').limit(1)
    expect(read.error).not.toBeNull()
    const write = await userClient
      .from('price_sync_attempts')
      .insert({ card_variant_id: v('never'), last_outcome: 'priced' })
    expect(write.error).not.toBeNull()
  })
})
