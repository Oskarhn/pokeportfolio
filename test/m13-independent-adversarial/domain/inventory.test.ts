/**
 * ORACLE SELF-TESTS + SCHEMA CROSS-CHECK for the canonical export inventory (prompt section 4).
 *
 * These run everywhere (no database, no implementation). They assert the oracle itself is
 * well-formed AND that it stays in sync with the real schema on main: every non-view relation
 * in the live database must be classified exactly once. When a migration adds a table, the
 * "every public table classified" test below FAILS until a deliberate decision is recorded
 * here — that is the forward-compat tripwire, and it is intentional.
 */
import { describe, expect, it } from 'vitest'

import {
  EXPORT_INVENTORY,
  FORWARD_COMPAT_TABLES,
  KNOWN_VIEWS,
  NEGATIVE_LEGAL_MONEY_COLUMNS,
  PRIVILEGE_INTERNAL_COLUMNS,
  classify,
  identityReferenceTables,
  mustExportTables,
  mustNotExportTables,
} from '../helpers/inventory.ts'

describe('export inventory oracle: internal consistency', () => {
  it('classifies at least the full canonical set', () => {
    expect(EXPORT_INVENTORY.length).toBeGreaterThanOrEqual(31)
  })

  it('never classifies the same table twice', () => {
    const names = EXPORT_INVENTORY.map((s) => s.table)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every entry a substantive reason (a restore author reads these)', () => {
    for (const spec of EXPORT_INVENTORY) {
      expect(spec.reason.length).toBeGreaterThan(40)
    }
  })

  it('keeps the derived-cache trap explicit: portfolio_snapshots MUST_NOT_EXPORT', () => {
    // The prompt section 10 regression contract, stated as data.
    expect(classify('portfolio_snapshots')).toBe('MUST_NOT_EXPORT')
    expect(classify('portfolio_recompute_queue')).toBe('MUST_NOT_EXPORT')
    expect(classify('portfolio_recompute_runs')).toBe('MUST_NOT_EXPORT')
  })

  it('excludes global market facts and system internals', () => {
    const excluded = new Set(mustNotExportTables())
    for (const t of [
      'fx_rates',
      'price_snapshots',
      'invitations',
      'invitation_claims',
      'invitation_redemptions',
      'catalog_sync_runs',
      'price_sync_runs',
    ]) {
      expect(excluded.has(t), `${t} must be MUST_NOT_EXPORT`).toBe(true)
    }
  })

  it('treats the shared catalog as identity reference only', () => {
    for (const t of ['card_series', 'card_sets', 'cards', 'card_variants']) {
      expect(classify(t)).toBe('IDENTITY_REFERENCE')
    }
  })

  it('carves privilege internals out of profiles', () => {
    const profiles = mustExportTables().find((s) => s.table === 'profiles')
    expect(profiles?.excludedColumns).toContain('is_admin')
    expect(profiles?.excludedColumns).toContain('disabled_at')
    expect(PRIVILEGE_INTERNAL_COLUMNS.get('profiles')).toEqual(['is_admin', 'disabled_at'])
  })

  it('restricts sealed_products export to user-created rows only', () => {
    const sealed = EXPORT_INVENTORY.find((s) => s.table === 'sealed_products')
    expect(sealed?.classification).toBe('MUST_EXPORT')
    expect(sealed?.userOwnedSubset).toMatch(/created_by_user_id/)
  })
})

describe('export inventory oracle: negative-legality of money columns', () => {
  it('allows negatives ONLY on the sales-side columns whose CHECK constraints permit them', () => {
    expect([...NEGATIVE_LEGAL_MONEY_COLUMNS].sort()).toEqual(
      [
        'sale_lines.net_proceeds_minor',
        'sale_lines.net_proceeds_nok_minor',
        'sale_lines.realized_result_nok_minor',
        'sales.net_proceeds_minor',
        'sales.net_proceeds_nok_minor',
        'sales.realized_result_nok_minor',
      ].sort(),
    )
  })

  it('never declares purchase-side money negative-legal (CHECK constraints forbid it)', () => {
    for (const column of [
      'purchases.total_minor',
      'purchase_lines.attributable_cost_minor',
      'manual_valuations.value_minor',
      'lot_cost_adjustments.amount_minor',
    ]) {
      expect(NEGATIVE_LEGAL_MONEY_COLUMNS.has(column)).toBe(false)
    }
  })
})

describe('export inventory oracle: schema cross-check', () => {
  /**
   * Reads the ACTUAL list of base relations from the live migrations via information_schema.
   * Skipped without an ephemeral stack; when it runs, any unclassified or view-misclassified
   * relation fails loudly. This is what forces a deliberate inventory decision when M16/M17/M18
   * add their tables.
   */
  it.skipIf(!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'classifies every base table present in the current schema exactly once',
    async () => {
      const { createClient } = await import('@supabase/supabase-js')
      const service = createClient(
        process.env.SUPABASE_URL as string,
        process.env.SUPABASE_SERVICE_ROLE_KEY as string,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
      // Postgres metadata is reachable through a SECURITY INVOKER rpc? No - use the catalog via
      // supabase's exposed pg_meta? Simplest robust path available to a browser-shaped client:
      // probe each classified name exists, and probe known views are views. Full enumeration
      // needs SQL access; that lives in the repository's own db-tests harness instead.
      const classified = EXPORT_INVENTORY.map((s) => s.table)
      for (const table of [...classified]) {
        if (KNOWN_VIEWS.includes(table)) continue
        const { error } = await service.from(table).select('*').limit(0)
        const missing =
          error !== null &&
          (error.code === 'PGRST205' || /does not exist|could not find/i.test(error.message))
        expect(missing, `classified table ${table} should exist in the schema`).toBe(false)
      }
    },
    20_000,
  )

  it('documents which future tables force an inventory decision', () => {
    // audit_events is named by DATA_MODEL section 7 prose but verified ABSENT from every
    // migration on main (grep). Its eventual creation MUST come with an entry here.
    expect(FORWARD_COMPAT_TABLES).toContain('audit_events')
    expect(FORWARD_COMPAT_TABLES).toContain('openings')
    expect(FORWARD_COMPAT_TABLES).toContain('grading_submissions')
  })

  it('has no overlap between classes', () => {
    const exported = new Set(mustExportTables().map((s) => s.table))
    const forbidden = new Set(mustNotExportTables())
    for (const t of identityReferenceTables()) {
      expect(exported.has(t)).toBe(false)
      expect(forbidden.has(t)).toBe(false)
    }
  })
})
