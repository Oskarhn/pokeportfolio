import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  deleteSyntheticUserRows,
} from './setup'
import type { SyntheticUser, TestClient } from './setup'

/**
 * Teardown helper contract (tests/db/setup.ts). The M13 export scale audit failed in CI only in its
 * afterAll: GoTrue's `deleteUser` timed out because 10,000 `manual_card_definitions` (plus
 * `purchases` and `storage_locations`) were still there for the auth cascade to remove in one
 * request, and it can also time out waiting on an M12 drain that is rebuilding the same user.
 * Timing that is nondeterministic, so this checks the deterministic part instead: the row-cleanup
 * phase removes those tables' rows and the recompute-queue row while the auth user still exists,
 * crosses a batch boundary, touches no other user's rows, and the full helper stays idempotent.
 */

// One more than setup.ts's CLEANUP_BATCH_SIZE, so the batch loop has to go around twice.
const ROWS_PAST_ONE_BATCH = 101

const COVERED: [table: string, column: string][] = [
  ['manual_card_definitions', 'user_id'],
  ['purchases', 'user_id'],
  ['storage_locations', 'user_id'],
  ['purchase_lines', 'user_id'],
  ['holdings', 'user_id'],
  ['acquisition_lots', 'user_id'],
  ['portfolio_recompute_queue', 'user_id'],
]

let service: TestClient
let owner: SyntheticUser
let control: SyntheticUser

async function insertReturningIds(
  table: string,
  rows: Record<string, unknown>[],
): Promise<string[]> {
  const { data, error } = await service.from(table).insert(rows).select('id')
  if (error) throw new Error(`seeding ${table}: ${error.message}`)
  return (data as { id: string }[]).map((row) => row.id)
}

async function seedUser(user: SyntheticUser): Promise<void> {
  const [locationId] = await insertReturningIds('storage_locations', [
    { user_id: user.id, name: 'Cleanup binder', kind: 'binder' },
  ])
  // Pointing the profile at the location exercises the SET NULL path when the location goes.
  const profile = await service
    .from('profiles')
    .update({ default_storage_location_id: locationId })
    .eq('id', user.id)
  if (profile.error) throw new Error(`seeding profile default: ${profile.error.message}`)

  const purchaseIds = await insertReturningIds(
    'purchases',
    Array.from({ length: ROWS_PAST_ONE_BATCH }, () => ({
      user_id: user.id,
      origin: 'manual',
      purchased_on: '2026-01-15',
      currency: 'NOK',
      subtotal_minor: 1_000,
      shipping_minor: 0,
      customs_minor: 0,
      discount_minor: 0,
      total_minor: 1_000,
      fx_rate_to_nok: 1,
      fx_rate_date: '2026-01-15',
      fx_source: 'manual',
      total_nok_minor: 1_000,
    })),
  )
  await insertReturningIds('purchase_lines', [
    {
      purchase_id: purchaseIds[0],
      user_id: user.id,
      line_type: 'card',
      spend_class: 'collectible',
      description: 'Cleanup line',
      condition: 'NM',
      quantity: 1,
      unit_price_minor: 1_000,
      line_total_minor: 1_000,
      allocated_shipping_minor: 0,
      attributable_cost_minor: 1_000,
      attributable_cost_nok_minor: 1_000,
    },
  ])

  const cardIds = await insertReturningIds(
    'manual_card_definitions',
    Array.from({ length: ROWS_PAST_ONE_BATCH }, (_, i) => ({
      user_id: user.id,
      name: `Cleanup Card ${String(i)}`,
      set_name: 'Cleanup Set',
      collector_number: String(i),
      language: 'en',
      finish: 'normal',
    })),
  )
  const holdingIds = await insertReturningIds(
    'holdings',
    cardIds.slice(0, 3).map((cardId) => ({
      user_id: user.id,
      holding_kind: 'raw_card',
      manual_card_id: cardId,
      grading_state: 'raw',
    })),
  )
  await insertReturningIds(
    'acquisition_lots',
    holdingIds.map((holdingId) => ({
      user_id: user.id,
      holding_id: holdingId,
      origin: 'gift',
      cost_basis_state: 'not_paid',
      acquired_on: '2026-01-20',
      quantity: 1,
      quantity_remaining: 1,
      residual_minor: 0,
      storage_location_id: locationId,
    })),
  )

  // The inserts above already queued the user for the M12 drain. Pushing dirty_from past
  // current_date keeps the every-minute cron drain from consuming the row mid-test, so its
  // presence is deterministic. Last seed step: a later ledger insert would pull the date back.
  const queued = await service
    .from('portfolio_recompute_queue')
    .upsert({ user_id: user.id, dirty_from: '2999-12-31' })
  if (queued.error) throw new Error(`seeding recompute queue: ${queued.error.message}`)
}

async function coveredCounts(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const [table, column] of COVERED) {
    const { count, error } = await service
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, userId)
    if (error || count === null) throw new Error(`counting ${table}: ${error?.message ?? 'null'}`)
    counts[table] = count
  }
  return counts
}

const SEEDED = {
  manual_card_definitions: ROWS_PAST_ONE_BATCH,
  purchases: ROWS_PAST_ONE_BATCH,
  storage_locations: 1,
  purchase_lines: 1,
  holdings: 3,
  acquisition_lots: 3,
  portfolio_recompute_queue: 1,
}
const EMPTY = Object.fromEntries(COVERED.map(([table]) => [table, 0]))

describe('synthetic-user teardown', () => {
  beforeAll(async () => {
    service = createServiceClient()
    owner = await createSyntheticUser(service, 'cleanup-owner')
    control = await createSyntheticUser(service, 'cleanup-control')
    await seedUser(owner)
    await seedUser(control)
  }, 60_000)

  afterAll(async () => {
    await deleteSyntheticUser(service, owner.id)
    await deleteSyntheticUser(service, control.id)
  }, 60_000)

  it('seeds both users identically', async () => {
    expect(await coveredCounts(owner.id)).toEqual(SEEDED)
    expect(await coveredCounts(control.id)).toEqual(SEEDED)
  })

  it('empties the high-volume tables before the auth user is deleted, and only for that user', async () => {
    await deleteSyntheticUserRows(service, owner.id)

    expect(await coveredCounts(owner.id)).toEqual(EMPTY)
    const stillThere = await service.auth.admin.getUserById(owner.id)
    expect(stillThere.error).toBeNull()
    const profile = await service
      .from('profiles')
      .select('default_storage_location_id')
      .eq('id', owner.id)
      .single()
    expect(profile.error).toBeNull()
    expect(profile.data?.default_storage_location_id).toBeNull()

    expect(await coveredCounts(control.id)).toEqual(SEEDED)
  }, 60_000)

  it('is idempotent and deletes the auth user without touching the control user', async () => {
    await deleteSyntheticUserRows(service, owner.id)
    await deleteSyntheticUser(service, owner.id)
    await deleteSyntheticUser(service, owner.id)

    const gone = await service.auth.admin.getUserById(owner.id)
    expect(gone.data.user).toBeNull()
    expect(gone.error?.status).toBe(404)
    expect(await coveredCounts(owner.id)).toEqual(EMPTY)

    expect(await coveredCounts(control.id)).toEqual(SEEDED)
    const controlUser = await service.auth.admin.getUserById(control.id)
    expect(controlUser.error).toBeNull()
  }, 60_000)
})
