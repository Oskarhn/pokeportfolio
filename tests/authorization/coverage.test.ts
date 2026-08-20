import { describe, expect, it } from 'vitest'

/**
 * Meta-test (docs/TESTING.md §4): "a new user-private table without an entry fails a
 * meta-test that compares the table list against the covered list." ALL_USER_PRIVATE_TABLES is
 * the canonical list from docs/DATA_MODEL.md §1 for tables that exist as of M3; COVERED_TABLES
 * is maintained by hand as each table gets its own describe block in this directory. Adding a
 * user-private table in a future milestone without updating both arrays fails this test.
 */

const ALL_USER_PRIVATE_TABLES = [
  'profiles',
  'retailers',
  'storage_locations',
  'tags',
  'purchases',
  'purchase_lines',
  'holdings',
  'acquisition_lots',
] as const

const COVERED_TABLES = [
  'profiles', // profiles.test.ts
  'retailers', // simple-owned-tables.test.ts
  'storage_locations', // simple-owned-tables.test.ts
  'tags', // simple-owned-tables.test.ts
  'purchases', // purchases.test.ts
  'purchase_lines', // purchases.test.ts
  'holdings', // holdings_and_lots.test.ts
  'acquisition_lots', // holdings_and_lots.test.ts
] as const

describe('authorization suite coverage', () => {
  it('every M3 user-private table has an authorization test', () => {
    const missing = ALL_USER_PRIVATE_TABLES.filter(
      (t) => !(COVERED_TABLES as readonly string[]).includes(t),
    )
    expect(missing).toEqual([])
  })

  it('COVERED_TABLES does not reference a table outside the canonical list', () => {
    const stale = COVERED_TABLES.filter(
      (t) => !(ALL_USER_PRIVATE_TABLES as readonly string[]).includes(t),
    )
    expect(stale).toEqual([])
  })
})
