import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import { connectDb } from './lib/account-deletion-deps'
import { USER_OWNED_TABLES } from './lib/account-ledger-fixture'

/**
 * P152: the ownership graph, read from the catalog rather than trusted from documentation.
 *
 * SECURITY.md §8 claimed account deletion cascaded "all user-private data" and was wrong for five
 * tables for weeks; nothing failed. This suite is the thing that fails next time. It derives, from
 * pg_constraint and pg_class, every table that references auth.users and every table that exists at
 * all, and demands that each one is either (a) covered by the purge and the write guard, or
 * (b) explicitly declared shared/system data. A table added by a future milestone therefore cannot
 * be forgotten by account deletion — it fails here until someone decides.
 */

let db: pg.Client

beforeAll(async () => {
  db = await connectDb()
})
afterAll(async () => {
  await db.end()
})

/** Tables that reference auth.users but are not "user-owned data": handled on their own terms. */
const IDENTITY_SUPPORT: Record<string, { column: string; rule: 'CASCADE' | 'SET NULL' }> = {
  invitation_claims: { column: 'consumed_user_id', rule: 'CASCADE' },
  // An invitation is an audit record of an administrative action: it outlives its issuer.
  invitations: { column: 'created_by', rule: 'SET NULL' },
  account_deletion_requests: { column: 'user_id', rule: 'CASCADE' },
}

/** Public tables that hold no per-user data. Anything not listed here or above must be owned. */
const SHARED_OR_SYSTEM_TABLES = [
  'card_series',
  'card_sets',
  'cards',
  'card_variants',
  'catalog_sync_runs',
  'environment_ingest_config',
  'fx_rates',
  'portfolio_recompute_runs',
  'price_snapshots',
  'price_sync_runs',
]

/** Owned, but system-derived: not guarded against inserts (see the migration), swept by cascade. */
const NOT_INSERT_GUARDED = new Set([
  'portfolio_snapshots',
  'portfolio_recompute_queue',
  'invitation_redemptions',
  'profiles',
])

/** Rows that legitimately remain after the purge and leave with the auth user. */
const SHELL_TABLES = new Set(['profiles', 'invitation_redemptions'])

const ruleName: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
}

async function authUserForeignKeys() {
  const res = await db.query<{ tbl: string; col: string; rule: string }>(`
    select rel.relname as tbl, att.attname as col, con.confdeltype as rule
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid = 'auth.users'::regclass
       and nsp.nspname = 'public'
     order by 1, 2`)
  return res.rows.map((r) => ({ table: r.tbl, column: r.col, rule: ruleName[r.rule]! }))
}

describe('every reference to auth.users is accounted for and cascades', () => {
  it('the set of tables referencing auth.users is exactly the declared set', async () => {
    const actual = (await authUserForeignKeys()).map((f) => `${f.table}.${f.column}`).sort()
    const declared = [
      ...USER_OWNED_TABLES.map((t) => `${t.table}.${t.column}`),
      ...Object.entries(IDENTITY_SUPPORT).map(([table, v]) => `${table}.${v.column}`),
    ].sort()
    expect(actual).toEqual(declared)
  })

  it('every one of them cascades on delete, except the audit-record exception', async () => {
    const offenders = (await authUserForeignKeys()).filter((f) => {
      const exception = IDENTITY_SUPPORT[f.table]
      const expected = exception && exception.column === f.column ? exception.rule : 'CASCADE'
      return f.rule !== expected
    })
    expect(offenders).toEqual([])
  })

  it('no public table exists that is neither owned, identity support, nor declared shared', async () => {
    const res = await db.query<{ relname: string }>(`
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       order by 1`)
    const known = new Set([
      ...USER_OWNED_TABLES.map((t) => t.table),
      ...Object.keys(IDENTITY_SUPPORT),
      ...SHARED_OR_SYSTEM_TABLES,
    ])
    const unclassified = res.rows.map((r) => r.relname).filter((t) => !known.has(t))
    expect(
      unclassified,
      'a new table must be added to USER_OWNED_TABLES (and to purge_account_data + the write ' +
        'guard) or declared shared here, deliberately',
    ).toEqual([])
  })

  it('shared tables really have no column referencing auth.users', async () => {
    const owned = new Set((await authUserForeignKeys()).map((f) => f.table))
    for (const t of SHARED_OR_SYSTEM_TABLES) expect(owned.has(t), t).toBe(false)
  })
})

describe('the purge and the write guard cover the same graph', () => {
  it('purge_account_data names every owned table it is responsible for deleting', async () => {
    const res = await db.query<{ prosrc: string }>(
      `select prosrc from pg_proc where proname = 'purge_account_data' and pronamespace = 'public'::regnamespace`,
    )
    const source = res.rows[0]!.prosrc
    for (const { table } of USER_OWNED_TABLES) {
      if (SHELL_TABLES.has(table)) continue
      expect(source, `purge_account_data must have a step for public.${table}`).toMatch(
        new RegExp(`\\(\\d+,\\s*'${table}',`),
      )
    }
  })

  it('every guarded table carries the insert guard, and only those', async () => {
    const res = await db.query<{ relname: string }>(`
      select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'account_deletion_guard' and not t.tgisinternal
       order by 1`)
    const actual = res.rows.map((r) => r.relname)
    const expected = USER_OWNED_TABLES.map((t) => t.table)
      .filter((t) => !NOT_INSERT_GUARDED.has(t))
      .sort()
    expect(actual).toEqual(expected)
  })

  it('the guard is a statement-level AFTER INSERT trigger using a transition table', async () => {
    const res = await db.query<{ def: string }>(`
      select pg_get_triggerdef(t.oid) as def from pg_trigger t
       where t.tgname = 'account_deletion_guard' and not t.tgisinternal`)
    for (const { def } of res.rows) {
      expect(def).toMatch(/AFTER INSERT/)
      expect(def).toMatch(/REFERENCING NEW TABLE AS new_rows/)
      expect(def).toMatch(/FOR EACH STATEMENT/)
    }
  })

  it('holdings.manual_card_id is indexed, so deleting manual cards is not a scan per card', async () => {
    const res = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_indexes
        where schemaname = 'public' and tablename = 'holdings' and indexname = 'holdings_manual_card_id_idx'`,
    )
    expect(res.rows[0]?.n).toBe(1)
  })

  it('requests are keyed to auth.users with a cascade: no tombstone can outlive a deletion', async () => {
    const fks = await authUserForeignKeys()
    expect(fks.find((f) => f.table === 'account_deletion_requests')).toEqual({
      table: 'account_deletion_requests',
      column: 'user_id',
      rule: 'CASCADE',
    })
  })
})
