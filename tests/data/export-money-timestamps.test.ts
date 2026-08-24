import { describe, expect, it } from 'vitest'

import { emptyBackupData, type BackupTagRow } from '../../src/domain/export/backup-format'
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../src/domain/export/build-backup'
import { MONEY_FIELDS, EXPORT_SECTION_SELECTS } from '../../src/data/export/fetch-snapshot'

/**
 * §19 money-cast audit: a compile-time probe proves every money FIELD is listed in
 * MONEY_FIELDS; THIS test proves every listed field actually carries an explicit `::text`
 * cast in its section's select string — the half the compiler cannot see (the cast strings
 * are hand-written). One missing cast would let PostgREST deliver that column as a JSON
 * number and silently corrupt any amount past 2^53.
 */
describe('money select casts (§19 audit)', () => {
  it('every declared money field is selected through ::text in its own section', () => {
    for (const [section, fields] of Object.entries(MONEY_FIELDS)) {
      // Sections without money columns legitimately have empty lists.
      const select = EXPORT_SECTION_SELECTS[section as keyof typeof EXPORT_SECTION_SELECTS]
      for (const field of fields) {
        expect(select, `${section}.${field} must be selected as ${field}::text`).toContain(
          `${field}::text`,
        )
      }
    }
  })

  it('frozen FX rates travel verbatim as text on both transaction headers (F11)', () => {
    for (const section of ['purchases', 'sales'] as const) {
      expect(EXPORT_SECTION_SELECTS[section]).toContain('fx_rate_to_nok::text')
    }
  })

  it('the profile threshold is cast even though profile is not a paged array section', () => {
    expect(EXPORT_SECTION_SELECTS.profiles).toContain('low_value_threshold_minor::text')
  })
})

/**
 * §21 timestamp precision: canonical timestamps are wire strings and must never pass through
 * JS Date. PostgreSQL microseconds ("…T10:20:30.123456+00:00") lose their sub-millisecond
 * digits through `new Date(x).toISOString()`; only exporter-GENERATED instants (exported_at,
 * filename stamps) may be newly created.
 */
describe('timestamp precision (§21)', () => {
  it('a microsecond wire timestamp survives serialization byte-exactly', () => {
    const tag: BackupTagRow = {
      id: '0b6e4a2e-0000-4000-8000-000000000001',
      user_id: '0b6e4a2e-0000-4000-8000-000000000002',
      name: 'Microsecond',
      created_at: '2026-05-01T10:20:30.123456+00:00',
      updated_at: '2026-05-01T10:20:30.123456+00:00',
    }
    const data = { ...emptyBackupData(), tags: [tag] }
    const text = serializeBackupEnvelope(
      buildBackupEnvelope(
        { ...data, identity_manifest: { card_variants: [], curated_sealed_products: [] } },
        {
          exportedAt: '2026-08-24T12:00:00.000Z',
          appVersion: 'test',
        },
      ),
    )
    expect(text).toContain('"created_at":"2026-05-01T10:20:30.123456+00:00"')
    expect(text).toContain('"updated_at":"2026-05-01T10:20:30.123456+00:00"')
    // The corruption under guard, demonstrated: Date flattens microseconds to milliseconds.
    expect(new Date(tag.created_at).toISOString()).not.toBe(tag.created_at)
  })
})
