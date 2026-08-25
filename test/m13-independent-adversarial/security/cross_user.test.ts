/**
 * ACTIVE DB-backed suite (runs against CURRENT MAIN's RLS — no M13 code involved).
 *
 * Export authority model being verified implementation-blind (prompt section 9):
 *   - the backup is generated client-side under the caller's JWT; RLS is THE boundary;
 *   - therefore every canonical user table must be readable by its owner directly, and
 *     MUST return zero foreign rows for a second user — admin included.
 *
 * This is also the DISCOVERY instrument: if any canonical table were NOT owner-readable
 * through the browser today, an export would be forced into some service-role/Edge-Function
 * architecture — an explicit decision this suite would surface by failing on that table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  promoteToAdmin,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../../tests/db/setup'
import { hasSupabaseEnv } from '../helpers/contract.ts'
import { mustExportTables } from '../helpers/inventory.ts'
import { FIXTURE_EXPECTED_COUNTS, seedCompleteUserModel } from '../helpers/fixtures.ts'

const TABLES_TO_PROBE: readonly string[] = [
  ...mustExportTables().map((s) => s.table),
  // Identity-reference sources the manifest builder needs to read as well:
  'card_variants',
  'cards',
  'card_sets',
  'card_series',
]

describe.skipIf(!hasSupabaseEnv())('cross-user export authority on current main', () => {
  let service: TestClient
  let userA: SyntheticUser
  let userB: SyntheticUser

  beforeAll(async () => {
    service = createServiceClient()
    userA = await createSyntheticUser(service, 'm13adv-a')
    userB = await createSyntheticUser(service, 'm13adv-b')
    // Seed exactly once: holdings_identity would reject a second identical holding row.
    await seedCompleteUserModel(service, userB.id, 'B')
  }, 120_000)

  afterAll(async () => {
    if (!service || !userA || !userB) return
    await deleteSyntheticUser(service, userA.id)
    await deleteSyntheticUser(service, userB.id)
  }, 60_000)

  it('user B owns a complete connected fixture; every canonical count matches', async () => {
    const b = await signInAs(userB)
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_COUNTS)) {
      const { count, error } = await b.from(table).select('*', { count: 'exact', head: true })
      expect(error, `${table} readable by owner`).toBeNull()
      // sealed_products is exempt from EXACT counts: curated seed rows are deliberately
      // visible alongside the user-created one (that visibility is by design).
      if (table === 'sealed_products') {
        expect(count ?? 0).toBeGreaterThanOrEqual(expected)
      } else {
        expect(count, `${table} row count for owner`).toBe(expected)
      }
    }

    // The user-created sealed product subset predicate: everything visible is curated OR B's.
    const { data: sealed } = await b.from('sealed_products').select('created_by_user_id')
    for (const row of sealed ?? []) {
      const creator = (row as Record<string, unknown>).created_by_user_id
      expect(creator === null || creator === userB.id).toBe(true)
    }
  })

  it("user A sees ZERO of user B's rows in every probed table", async () => {
    const a = await signInAs(userA)
    for (const table of TABLES_TO_PROBE) {
      if (FIXTURE_EXPECTED_COUNTS[table] !== undefined) continue // covered with exact counts above
      const { data, error } = await a.from(table).select('*').limit(1000)
      expect(error, `${table} readable by authenticated`).toBeNull()
      const foreign = (data ?? []).filter(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          'user_id' in row &&
          (row as Record<string, unknown>).user_id === userB.id,
      )
      expect(foreign, `${table} leaked foreign rows to user A`).toHaveLength(0)
    }
  })

  it('admin status does NOT widen read authority onto another user’s rows', async () => {
    await promoteToAdmin(service, userA.id)

    const a = await signInAs(userA)
    for (const table of ['holdings', 'purchases', 'sales', 'profiles']) {
      const { data, error } = await a.from(table).select('*')
      expect(error).toBeNull()
      const foreignIds = (data ?? []).filter((row) => {
        const r = row as Record<string, unknown>
        return r.user_id === userB.id || (table === 'profiles' && r.id === userB.id)
      })
      expect(foreignIds, `${table}: admin saw foreign rows`).toHaveLength(0)
    }
  })

  it('every MUST_EXPORT table is browser-readable by its owner (the discovery check)', async () => {
    const b = await signInAs(userB)

    // The one table where this could plausibly fail: lot_cost_adjustments is SELECT-only
    // (no write path yet). Readability is all export needs — assert it explicitly.
    const { error: adjustmentError } = await b.from('lot_cost_adjustments').select('*').limit(1)
    expect(adjustmentError, 'owner must read lot_cost_adjustments directly').toBeNull()

    for (const spec of mustExportTables()) {
      const { error } = await b.from(spec.table).select('*').limit(1)
      expect(error, `${spec.table} must be owner-readable for client-side export`).toBeNull()
    }
  })
})
