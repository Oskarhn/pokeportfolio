import { describe, expect, it } from 'vitest'

import { brandRow, MONEY_FIELDS, NULLABLE_MONEY_FIELDS } from '../../src/data/export/fetch-snapshot'
import { type BackupData } from '../../src/domain/export/backup-format'

/**
 * The runtime money guard (P39 finding 5): a listed money field that arrives as anything but an
 * exact decimal STRING — or null where the canonical row allows it — must FAIL the export
 * loudly. A NUMBER may already have been rounded past 2^53 at the JSON parse boundary, so it is
 * never coerced or trusted. This is what makes fetch-snapshot.ts's header claim true rather
 * than aspirational: "a column that ever lost its cast fails loudly".
 */

const PAST_2_53 = '9007199254740993'

/** Simulates exactly the corruption a lost ::text cast produces on the wire. */
function wire(row: object): never {
  return row as unknown as never
}

describe('money runtime guard — string values are branded', () => {
  it('brands exact integer strings across several sections', () => {
    const purchase = brandRow(
      wire({
        id: 'p1',
        user_id: 'u1',
        purchased_on: '2026-01-01',
        retailer_id: null,
        currency: 'NOK',
        subtotal_minor: PAST_2_53,
        shipping_minor: '0',
        customs_minor: '0',
        discount_minor: '0',
        total_minor: PAST_2_53,
        total_nok_minor: PAST_2_53,
        fx_rate_to_nok: '11.54000000',
        fx_rate_date: '2026-01-08',
        fx_source: 'manual',
        origin: 'manual',
        notes: null,
        voided_at: null,
        created_at: '2026-01-01T00:00:00+00:00',
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
      'purchases',
    )
    // Past 2^53, carried EXACTLY — a number pipeline would have delivered …992 here.
    expect(purchase.total_minor).toBe(PAST_2_53)
    expect(purchase.shipping_minor).toBe('0')
  })

  it('a negative amount survives branding', () => {
    const saleLine = brandRow(
      wire({
        id: 's1',
        user_id: 'u1',
        sale_id: 'x1',
        lot_id: 'l1',
        quantity: 1,
        unit_gross_minor: '-12050',
        line_gross_minor: '-12050',
        allocated_fees_minor: '0',
        allocated_shipping_minor: '0',
        allocated_shipping_charged_minor: '0',
        net_proceeds_minor: '-12050',
        net_proceeds_nok_minor: '-12050',
        cost_basis_at_sale_nok_minor: null,
        realized_result_nok_minor: null,
        created_at: '2026-01-01T00:00:00+00:00',
      }),
      'sale_lines',
    )
    expect(saleLine.net_proceeds_minor).toBe('-12050')
  })
})

describe('money runtime guard — numbers THROW (the P39 attack)', () => {
  it('a numeric wire value for a money field throws instead of passing through', () => {
    const corruptedNumber = Number(PAST_2_53) // 9007199254740992 — precision ALREADY destroyed
    expect(() =>
      brandRow(
        wire({
          id: 'p1',
          user_id: 'u1',
          purchased_on: '2026-01-01',
          retailer_id: null,
          currency: 'NOK',
          subtotal_minor: corruptedNumber,
          shipping_minor: '0',
          customs_minor: '0',
          discount_minor: '0',
          total_minor: '100',
          total_nok_minor: '100',
          fx_rate_to_nok: '1',
          fx_rate_date: '2026-01-08',
          fx_source: 'manual',
          origin: 'manual',
          notes: null,
          voided_at: null,
          created_at: '2026-01-01T00:00:00+00:00',
          updated_at: '2026-01-01T00:00:00+00:00',
        }),
        'purchases',
      ),
    ).toThrow(TypeError)
    expect(() =>
      brandRow(
        wire({
          id: 'p1',
          subtotal_minor: corruptedNumber,
        }),
        'purchases',
      ),
    ).toThrow(/subtotal_minor[\s\S]*::text cast was lost/)
  })

  it('numbers throw in every section that carries money fields', () => {
    for (const [section, fields] of Object.entries(MONEY_FIELDS)) {
      if ((fields as readonly string[]).length === 0) continue
      for (const field of fields as readonly string[]) {
        expect(
          () => brandRow(wire({ [field]: 12345 }), section as keyof BackupData),
          `${section}.${field} must refuse a numeric wire value`,
        ).toThrow(TypeError)
      }
    }
  })

  it('other unexpected shapes throw too', () => {
    expect(() =>
      brandRow(wire({ unit_cost_basis_minor: { nested: 'x' } }), 'acquisition_lots'),
    ).toThrow(TypeError)
    expect(() => brandRow(wire({ value_minor: undefined }), 'manual_valuations')).toThrow(TypeError)
    expect(() => brandRow(wire({ total_minor: ['9007199254740993'] }), 'purchases')).toThrow(
      TypeError,
    )
  })
})

describe('money runtime guard — null only where the canonical row allows it', () => {
  it('null passes on genuinely nullable money fields', () => {
    const lot = brandRow(
      wire({
        id: 'l1',
        user_id: 'u1',
        holding_id: 'h1',
        purchase_line_id: null,
        origin: 'gift',
        cost_basis_state: 'not_paid',
        cost_basis_currency: null,
        unit_cost_basis_minor: null,
        unit_cost_basis_nok_minor: null,
        residual_minor: '0',
        residual_nok_minor: '0',
        quantity: 1,
        quantity_remaining: 1,
        sealed_intent: 'keep_sealed',
        storage_location_id: null,
        acquired_on: '2026-01-01',
        voided_at: null,
        notes: null,
        created_at: '2026-01-01T00:00:00+00:00',
      }),
      'acquisition_lots',
    )
    expect(lot.unit_cost_basis_minor).toBeNull() // unknown basis stays unknown
    expect(lot.residual_minor).toBe('0')
  })

  it('null throws on non-nullable money fields', () => {
    const allFieldsNull = (section: keyof BackupData): Record<string, unknown> =>
      Object.fromEntries((MONEY_FIELDS[section] as readonly string[]).map((f) => [f, null]))
    expect(() => brandRow(wire(allFieldsNull('purchases')), 'purchases')).toThrow(
      /null where the canonical field forbids it/,
    )
    expect(() => brandRow(wire(allFieldsNull('manual_valuations')), 'manual_valuations')).toThrow(
      TypeError,
    )
    expect(() => brandRow(wire(allFieldsNull('profiles')), 'profiles')).toThrow(TypeError)
  })

  it('NULLABLE_MONEY_FIELDS stays inside MONEY_FIELDS and matches the format types', () => {
    for (const [section, fields] of Object.entries(NULLABLE_MONEY_FIELDS)) {
      const all = MONEY_FIELDS[section as keyof typeof MONEY_FIELDS] as readonly string[]
      for (const field of fields as readonly string[]) {
        expect(all, `${section}.${field} nullable-listed but not a money field`).toContain(field)
      }
    }
  })
})
