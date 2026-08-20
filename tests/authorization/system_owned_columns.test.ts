import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * Columns a session may not write, asserted one at a time.
 *
 * `profiles.is_admin` was the escalation M4 found, and it was found because someone thought to try
 * it. The generalisation is the point of this file: RLS decides *rows*, and every user-owned table
 * has columns where the row is the caller's own and the write is still wrong — the owner id, the
 * primary key, when the row was created, what created it. On those, the only control is the column
 * grant, and until M4.1 there was no column grant, because `UPDATE` was granted whole-table
 * everywhere except `profiles`.
 *
 * Probing with a filter that matches no rows is deliberate. PostgreSQL checks column privileges
 * when it plans the statement, not when it finds a row, so this asserts the privilege itself
 * rather than the interaction between a privilege and a fixture — and it needs no fixture, which
 * is why every table in the schema can be covered here instead of only the ones with cheap setup.
 * The behaviour on real rows is covered where those rows already exist: profiles.test.ts,
 * simple-owned-tables.test.ts, purchases.test.ts, holdings_and_lots.test.ts.
 */

const NOWHERE = '00000000-0000-0000-0000-000000000000'

interface TableCase {
  table: string
  /** A column the product legitimately edits. Proves a refusal below is about the column. */
  writable: [string, unknown]
  /** Columns that are the system's to set, with the reason they are. */
  systemOwned: Record<string, unknown>
}

const CASES: TableCase[] = [
  {
    table: 'profiles',
    writable: ['display_name', 'Ash'],
    systemOwned: {
      is_admin: true,
      disabled_at: '2026-01-01T00:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
      id: NOWHERE,
    },
  },
  {
    table: 'retailers',
    writable: ['name', 'renamed'],
    systemOwned: {
      user_id: NOWHERE,
      id: NOWHERE,
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
    },
  },
  {
    table: 'storage_locations',
    writable: ['name', 'renamed'],
    systemOwned: { user_id: NOWHERE, id: NOWHERE, created_at: '2020-01-01T00:00:00Z' },
  },
  {
    table: 'tags',
    writable: ['name', 'renamed'],
    systemOwned: { user_id: NOWHERE, id: NOWHERE, created_at: '2020-01-01T00:00:00Z' },
  },
  {
    table: 'sealed_products',
    writable: ['name', 'renamed'],
    // NULL created_by_user_id means "curated catalog row, readable by everyone". A session able to
    // write this column could push a private row into the shared catalog, or claim someone else's.
    systemOwned: { created_by_user_id: null, id: NOWHERE, created_at: '2020-01-01T00:00:00Z' },
  },
  {
    table: 'holdings',
    writable: ['is_favorite', true],
    systemOwned: {
      user_id: NOWHERE,
      id: NOWHERE,
      created_at: '2020-01-01T00:00:00Z',
      updated_at: '2020-01-01T00:00:00Z',
    },
  },
  {
    table: 'purchases',
    writable: ['notes', 'edited'],
    // `origin` records what created the purchase. D-021's provisional purchases are voided when
    // the real receipt arrives, and that only works if a manual purchase cannot relabel itself as
    // a provisional one after the fact.
    systemOwned: { user_id: NOWHERE, id: NOWHERE, origin: 'manual', created_at: '2020-01-01' },
  },
  {
    table: 'purchase_lines',
    writable: ['description', 'edited'],
    // Re-parenting a line moves money between purchases without either purchase changing.
    systemOwned: { user_id: NOWHERE, purchase_id: NOWHERE, id: NOWHERE },
  },
  {
    table: 'acquisition_lots',
    writable: ['notes', 'edited'],
    systemOwned: { user_id: NOWHERE, holding_id: NOWHERE, id: NOWHERE, origin: 'purchase' },
  },
]

let service: TestClient
let user: SyntheticUser
let authed: TestClient

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'sysowned')
  authed = await signInAs(user)
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

/**
 * Only PostgreSQL produces "permission denied for column"; nothing in this application raises it,
 * so matching on it cannot be satisfied by an RLS refusal or by a check constraint that happens to
 * fire first. That distinction is the whole assertion — a row-level refusal here would mean the
 * column is still writable and something else stopped this particular attempt.
 */
function isColumnPrivilegeRefusal(error: { message?: string } | null): boolean {
  return /permission denied for column/i.test(error?.message ?? '')
}

for (const { table, writable, systemOwned } of CASES) {
  describe(`${table}: system-owned columns`, () => {
    const [writableColumn, writableValue] = writable

    it(`${writableColumn} is writable, so a refusal below is about the column`, async () => {
      const { error } = await authed
        .from(table)
        .update({ [writableColumn]: writableValue })
        .eq('id', NOWHERE)
      expect(error, `${table}.${writableColumn} should still be editable`).toBeNull()
    })

    for (const [column, value] of Object.entries(systemOwned)) {
      it(`${column} is refused by column privilege`, async () => {
        const { error } = await authed
          .from(table)
          .update({ [column]: value })
          .eq('id', NOWHERE)
        expect(
          isColumnPrivilegeRefusal(error),
          `${table}.${column} was not refused by a column privilege: ${error?.message ?? 'no error'}`,
        ).toBe(true)
      })
    }
  })
}

describe('anon writes nothing at all', () => {
  it('holds no table privileges anywhere in the schema', async () => {
    // The baseline states this as an absence (scripts/grant-audit.sql expects no rows for anon).
    // Absences are easy to state and easy to stop being true, so it is also asserted from a client.
    const anon = createAnonClient()

    for (const { table } of CASES) {
      const { data, error } = await anon.from(table).select('id').limit(1)
      expect(error !== null || data.length === 0, `${table} leaked to anon`).toBe(true)
    }
  })
})
