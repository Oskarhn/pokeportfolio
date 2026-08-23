import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * M12 queue and invalidation mechanics (prompt Part C/§120).
 *
 * Covered against the real triggers, not by calling helpers directly: which business events
 * enqueue, with WHICH dirty boundary (LEAST coalescing never moves it later), that a drain
 * clears exactly what it successfully rebuilt and stays idempotent, that concurrent drains
 * cannot process the same user destructively (SKIP LOCKED), that future-dated work waits, and
 * that shared market-data writes fan out to affected owners without leaking anything anywhere.
 */

let service: TestClient
let user: SyntheticUser
let sealedOnlyUser: SyntheticUser

const today = new Date()
function daysAgo(n: number): string {
  const d = new Date(today)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function queueFor(userId: string): Promise<string | null> {
  const { data } = await service
    .from('portfolio_recompute_queue')
    .select('dirty_from')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.dirty_from ?? null
}

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'm12-queue')
  sealedOnlyUser = await createSyntheticUser(service, 'm12-queue-sealed')

  // A holding for the primary user so shared-data triggers have an owner to find.
  await service.from('holdings').insert({
    user_id: user.id,
    holding_kind: 'raw_card',
    card_variant_id: seedCatalog.charizardVariantId,
    condition: 'NM',
    grading_state: 'raw',
  })
  const { data: holding } = await service
    .from('holdings')
    .select('id')
    .eq('user_id', user.id)
    .single()
  await service.from('acquisition_lots').insert({
    holding_id: holding!.id as string,
    user_id: user.id,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: daysAgo(30),
    quantity: 1,
    quantity_remaining: 1,
  })

  // A sealed-only user: FX-driven market revaluation can never affect them.
  await service.from('holdings').insert({
    user_id: sealedOnlyUser.id,
    holding_kind: 'sealed',
    sealed_product_id: seedCatalog.sealedProductId,
    grading_state: 'raw',
  })
  const { data: sealedHolding } = await service
    .from('holdings')
    .select('id')
    .eq('user_id', sealedOnlyUser.id)
    .single()
  await service.from('acquisition_lots').insert({
    holding_id: sealedHolding!.id as string,
    user_id: sealedOnlyUser.id,
    origin: 'gift',
    cost_basis_state: 'not_paid',
    acquired_on: daysAgo(30),
    quantity: 1,
    quantity_remaining: 1,
  })
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
  await deleteSyntheticUser(service, sealedOnlyUser.id)
})

// Queue rows persist across tests for the same user by design (LEAST coalescing), so every test
// starts from a clean slate for ITS users — otherwise an earlier test's older dirty_from would
// legitimately survive and break the next test's boundary assertion.
beforeEach(async () => {
  await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)
  await service.from('portfolio_recompute_queue').delete().eq('user_id', sealedOnlyUser.id)
})

describe('M12 invalidation boundaries', () => {
  it('an acquisition insert enqueues from its own acquired_on; edits coalesce with LEAST', async () => {
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: seedCatalog.pikachuVariantId,
        condition: 'NM',
        grading_state: 'raw',
      })
      .select('id')
      .single()

    // Start from a clean queue for this user.
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)

    await service.from('acquisition_lots').insert({
      holding_id: holding!.id as string,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: daysAgo(20),
      quantity: 1,
      quantity_remaining: 1,
    })

    // Self-diagnosing on failure: confirm the lot actually stored the intended business date
    // before blaming the trigger for the queue state.
    const { data: insertedLot } = await service
      .from('acquisition_lots')
      .select('id, acquired_on')
      .eq('holding_id', holding!.id as string)
      .single()
    expect(insertedLot?.acquired_on).toBe(daysAgo(20))

    expect(await queueFor(user.id)).toBe(daysAgo(20))

    // An edit moving the date EARLIER pulls the boundary back through the trigger's own
    // least(old, new)...
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('holding_id', holding!.id as string)
      .single()
    await service
      .from('acquisition_lots')
      .update({ acquired_on: daysAgo(40) })
      .eq('id', lot!.id as string)
    expect(await queueFor(user.id)).toBe(daysAgo(20)) // least(day20, day40) — insert's 20 stands

    // ...and a genuinely earlier event pulls the boundary back (never skipped, prompt §15).
    await service
      .from('acquisition_lots')
      .update({ acquired_on: daysAgo(60) })
      .eq('id', lot!.id as string)
    expect(await queueFor(user.id)).toBe(daysAgo(60))

    // A LATER date must NOT move the boundary forward over older pending work (prompt §35's
    // exact trap): move Mar→Apr style — here day 60 → day 5 keeps dirty at day 60.
    await service
      .from('acquisition_lots')
      .update({ acquired_on: daysAgo(5) })
      .eq('id', lot!.id as string)
    expect(await queueFor(user.id)).toBe(daysAgo(60))
  })

  it('sealed-intent, storage and favourite changes dirty nothing (prompt §23/§44)', async () => {
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)

    // Favourite flip on the holding.
    await service.from('holdings').update({ is_favorite: true }).eq('user_id', user.id)
    expect(await queueFor(user.id)).toBeNull()

    // Notes on the lot — notes are not financial state.
    const { data: lotRow } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)
      .single()
    await service
      .from('acquisition_lots')
      .update({ notes: 'moved shelves' })
      .eq('id', lotRow!.id as string)
    expect(await queueFor(user.id)).toBeNull()

    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)
  })

  it('a purchase date move dirties the OLD date too (prompt §35)', async () => {
    const { data: purchase } = await service
      .from('purchases')
      .insert({
        user_id: user.id,
        purchased_on: daysAgo(45),
        currency: 'NOK',
        subtotal_minor: 1000,
        shipping_minor: 0,
        customs_minor: 0,
        discount_minor: 0,
        total_minor: 1000,
        fx_rate_to_nok: '1',
        fx_rate_date: daysAgo(45),
        fx_source: 'manual',
        total_nok_minor: 1000,
      })
      .select('id')
      .single()
    expect(await queueFor(user.id)).toBe(daysAgo(45))

    await service
      .from('purchases')
      .update({ purchased_on: daysAgo(10) })
      .eq('id', purchase!.id as string)
    expect(await queueFor(user.id)).toBe(daysAgo(45)) // March history must recompute too
  })

  it('a sale date move dirties from the earliest affected sold_on (prompt §38)', async () => {
    const { data: sale } = await service
      .from('sales')
      .insert({
        user_id: user.id,
        sold_on: daysAgo(25),
        currency: 'NOK',
        gross_minor: 100,
        net_proceeds_minor: 100,
        fx_rate_to_nok: '1',
        fx_rate_date: daysAgo(25),
        fx_source: 'manual',
        net_proceeds_nok_minor: 100,
        idempotency_key: crypto.randomUUID(),
      })
      .select('id')
      .single()
    expect(await queueFor(user.id)).toBe(daysAgo(25))

    await service
      .from('sales')
      .update({ sold_on: daysAgo(70) })
      .eq('id', sale!.id as string)
    expect(await queueFor(user.id)).toBe(daysAgo(70))
  })

  it('a manual-valuation set/clear dirties its interval boundary', async () => {
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)

    const { data: holding } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', user.id)
      .limit(1)
      .single()

    await service.from('manual_valuations').insert({
      user_id: user.id,
      holding_id: holding!.id as string,
      value_minor: 500,
      currency: 'NOK',
      value_nok_minor: 500,
      effective_from: daysAgo(12),
    })
    expect(await queueFor(user.id)).toBe(daysAgo(12))

    // Clearing ends coverage at the clear date — dirty from there.
    await service
      .from('manual_valuations')
      .update({ superseded_at: new Date(Date.now() - 3 * 86_400_000).toISOString() })
      .eq('holding_id', holding!.id as string)
      .is('superseded_at', null)
    expect(await queueFor(user.id)).toBe(daysAgo(3))
  })
})

describe('M12 shared market-data invalidation', () => {
  it('a price-snapshot write fans out to variant owners only, never to strangers', async () => {
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)
    await service.from('portfolio_recompute_queue').delete().eq('user_id', sealedOnlyUser.id)

    // Use a fresh variant owned by nobody, then give ONLY the primary user a lot on it.
    const cardId = crypto.randomUUID()
    const variantId = crypto.randomUUID()
    await service.from('cards').insert({
      id: cardId,
      set_id: seedCatalog.cardSetId,
      local_id: `m12q-${cardId.slice(0, 8)}`,
      name: 'M12 Queue Variant',
      language: 'en',
    })
    await service.from('card_variants').insert({ id: variantId, card_id: cardId, finish: 'normal' })
    const { data: holding } = await service
      .from('holdings')
      .insert({
        user_id: user.id,
        holding_kind: 'raw_card',
        card_variant_id: variantId,
        condition: 'NM',
        grading_state: 'raw',
      })
      .select('id')
      .single()
    await service.from('acquisition_lots').insert({
      holding_id: holding!.id as string,
      user_id: user.id,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: daysAgo(9),
      quantity: 1,
      quantity_remaining: 1,
    })
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)

    // The ingest path's write shape: a batch of observations under the service role.
    await service.from('price_snapshots').insert([
      {
        card_variant_id: variantId,
        provider: 'tcgdex_cardmarket',
        price_kind: 'cm_trend',
        source_currency: 'EUR',
        value_minor: 100,
        snapshot_date: daysAgo(2),
        provider_updated_at: new Date().toISOString(),
      },
      {
        card_variant_id: variantId,
        provider: 'tcgdex_tcgplayer',
        price_kind: 'tp_market',
        source_currency: 'USD',
        value_minor: 90,
        snapshot_date: daysAgo(2),
        provider_updated_at: new Date().toISOString(),
      },
    ])

    expect(await queueFor(user.id)).toBe(daysAgo(2))
    expect(await queueFor(sealedOnlyUser.id)).toBeNull() // sealed holdings are FX/manual only
  })

  it('an fx-rate write dirties raw-card owners but not sealed-only users (prompt §42)', async () => {
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)
    await service.from('portfolio_recompute_queue').delete().eq('user_id', sealedOnlyUser.id)

    // The DATE is what the assertion needs; the VALUE deliberately matches the rate every other
    // suite converts against, so this row can never shift another suite's as-of arithmetic even
    // though it is the most recent EUR observation on the shared stack.
    await service.from('fx_rates').upsert(
      [
        {
          base_currency: 'EUR',
          quote_currency: 'NOK',
          rate_date: daysAgo(1),
          rate: '11.50000000',
          source: 'norges_bank',
        },
      ],
      { onConflict: 'base_currency,quote_currency,rate_date,source' },
    )

    expect(await queueFor(user.id)).toBe(daysAgo(1))
    expect(await queueFor(sealedOnlyUser.id)).toBeNull()
  })
})

describe('M12 drain mechanics (prompt §120)', () => {
  // NOTE on scope: the ephemeral stack is shared by every db suite, and this milestone's
  // invalidation triggers enqueue users from OTHER suites' mutations too. Drain assertions are
  // therefore scoped to THIS file's users (their queue rows, their snapshots) — never to global
  // "processed" counts, which legitimately include whoever else is queued.
  it('drains due work, clears the row, and is idempotent on repeat', async () => {
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)
    // A same-value UPDATE of a watched column still fires the invalidation trigger — the cheap,
    // honest way to re-enqueue through the real path.
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id, quantity')
      .eq('user_id', user.id)
      .limit(1)
      .single()
    await service
      .from('acquisition_lots')
      .update({ quantity: lot!.quantity as number })
      .eq('id', lot!.id as string)
    expect(await queueFor(user.id)).not.toBeNull()

    const { error: firstError } = await service.rpc('drain_portfolio_recompute_queue')
    expect(firstError).toBeNull()
    expect(await queueFor(user.id)).toBeNull()

    const { data: snapshotBefore } = await service
      .from('portfolio_snapshots')
      .select('*')
      .eq('user_id', user.id)
    expect(snapshotBefore?.length ?? 0).toBeGreaterThan(0)

    const { error: secondError } = await service.rpc('drain_portfolio_recompute_queue')
    expect(secondError).toBeNull()
    expect(await queueFor(user.id)).toBeNull() // stays drained
    const { data: snapshotAfter } = await service
      .from('portfolio_snapshots')
      .select('*')
      .eq('user_id', user.id)
    expect(snapshotAfter?.length).toBe(snapshotBefore?.length)
  })

  it('future-dated work waits until due instead of being lost (prompt §53)', async () => {
    await service.from('portfolio_recompute_queue').upsert({
      user_id: user.id,
      dirty_from: daysAgo(-5), // five days in the future
    })
    await service.rpc('drain_portfolio_recompute_queue')
    expect(await queueFor(user.id)).toBe(daysAgo(-5)) // retained, not silently dropped

    // The daily sweep promotes it once due: LEAST(today, future) = today.
    const { error } = await service.rpc('enqueue_portfolio_daily_maintenance')
    expect(error).toBeNull()
    expect(await queueFor(user.id)).toBe(daysAgo(0))

    await service.rpc('drain_portfolio_recompute_queue')
    expect(await queueFor(user.id)).toBeNull()
  })

  it('two concurrent drains never double-process destructively (prompt §54)', async () => {
    await service.from('portfolio_recompute_queue').delete().eq('user_id', user.id)
    await service
      .from('acquisition_lots')
      .update({ acquired_on: daysAgo(28) })
      .eq('user_id', user.id)
    expect(await queueFor(user.id)).not.toBeNull()

    const [a, b] = await Promise.all([
      service.rpc('drain_portfolio_recompute_queue'),
      service.rpc('drain_portfolio_recompute_queue'),
    ])
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
    expect(Number(a.data) + Number(b.data)).toBeGreaterThanOrEqual(1) // work happened somewhere
    expect(await queueFor(user.id)).toBeNull() // this user processed exactly once

    const { data: rows } = await service
      .from('portfolio_snapshots')
      .select('snapshot_date')
      .eq('user_id', user.id)
    expect(new Set(rows?.map((r) => r.snapshot_date)).size).toBe(rows?.length) // no duplicates
  })
})
