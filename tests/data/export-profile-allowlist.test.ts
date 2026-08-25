import { describe, expect, it } from 'vitest'

import { projectProfileRow } from '../../src/data/export/fetch-snapshot'

/**
 * The profile privilege allowlist (P39 finding 7): exclusion of is_admin / disabled_at must
 * not depend solely on the hand-written select string. If a future select ever widens (an
 * innocent `*`, a new column), anything not on the allowlist still cannot reach the backup.
 */
describe('profile allowlist projection', () => {
  it('projects exactly the allowlisted fields from a well-formed wire row', () => {
    const row = projectProfileRow({
      id: 'a0000000-0000-4000-8000-0000000000aa',
      display_name: 'Oskar',
      theme: 'dark',
      display_currency: 'NOK',
      locale: 'nb-NO',
      hide_values: false,
      hide_low_value_by_default: true,
      low_value_threshold_minor: '1000',
      use_eu_pricing: true,
      collection_grid_density: 3,
      collection_default_view: 'grid',
      collection_default_sort: 'name_asc',
      default_condition: 'NM',
      default_language: 'no',
      default_storage_location_id: null,
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-02T00:00:00+00:00',
    })
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'display_name',
        'theme',
        'display_currency',
        'locale',
        'hide_values',
        'hide_low_value_by_default',
        'low_value_threshold_minor',
        'use_eu_pricing',
        'collection_grid_density',
        'collection_default_view',
        'collection_default_sort',
        'default_condition',
        'default_language',
        'default_storage_location_id',
        'created_at',
        'updated_at',
      ].sort(),
    )
    expect(row.low_value_threshold_minor).toBe('1000')
  })

  it('a synthetic fetched row carrying extra privilege-looking keys has them stripped', () => {
    // What SELECT '*' (or any future widening) would hand back:
    const widenedWireRow = {
      id: 'a0000000-0000-4000-8000-0000000000aa',
      display_name: null,
      theme: 'dark',
      display_currency: 'NOK',
      locale: 'nb-NO',
      hide_values: false,
      hide_low_value_by_default: false,
      low_value_threshold_minor: '2500',
      use_eu_pricing: false,
      collection_grid_density: 2,
      collection_default_view: 'list',
      collection_default_sort: 'added_newest',
      default_condition: null,
      default_language: null,
      default_storage_location_id: null,
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00',
      // The privilege internals — must never survive the projection:
      is_admin: true,
      disabled_at: null,
      email: 'attacker@example.com',
      role: 'service_role',
    }
    const row = projectProfileRow(widenedWireRow)
    const serialized = JSON.stringify(row)
    for (const forbidden of ['is_admin', 'disabled_at', 'email', 'role']) {
      expect(serialized).not.toContain(`"${forbidden}"`)
      expect(Object.keys(row)).not.toContain(forbidden)
    }
  })

  it('a non-string where a required string is expected fails loudly instead of fabricating', () => {
    const validRow = {
      id: 'a0000000-0000-4000-8000-0000000000aa',
      display_name: null,
      theme: 'dark',
      display_currency: 'NOK',
      locale: 'nb-NO',
      hide_values: false,
      hide_low_value_by_default: false,
      low_value_threshold_minor: '1000',
      use_eu_pricing: false,
      collection_grid_density: 2,
      collection_default_view: 'grid',
      collection_default_sort: 'name_asc',
      default_condition: null,
      default_language: null,
      default_storage_location_id: null,
      created_at: '2026-01-01T00:00:00+00:00',
      updated_at: '2026-01-01T00:00:00+00:00',
    }
    expect(() => projectProfileRow({ ...validRow, id: null })).toThrow(/profiles\.id/)
    expect(() => projectProfileRow({ ...validRow, low_value_threshold_minor: null })).toThrow(
      /low_value_threshold_minor/,
    )
  })
})
