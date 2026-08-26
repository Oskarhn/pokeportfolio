import { describe, expect, it } from 'vitest'
import {
  BACKUP_DATA_KEYS,
  BACKUP_FORMAT_ID,
  isMinorUnitsString,
  minorUnits,
} from '../../src/domain/export/backup-format'
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../src/domain/export/build-backup'
import {
  assertBackupEnvelope,
  validateBackupEnvelope,
} from '../../src/domain/export/backup-validate'
import { FIXED_EXPORTED_AT, FIXTURE_IDS, FIXTURE_IDS_M16, fixtureSnapshot } from './export-fixtures'

const envelope = () =>
  buildBackupEnvelope(fixtureSnapshot(), { exportedAt: FIXED_EXPORTED_AT, appVersion: 'test' })

describe('versioned envelope (M13 gate: version envelope present)', () => {
  it('carries format identifier, schema version, export timestamp and app version', () => {
    const e = envelope()
    expect(e.format).toBe(BACKUP_FORMAT_ID)
    expect(e.schema_version).toBe(2)
    expect(e.exported_at).toBe(FIXED_EXPORTED_AT)
    expect(e.app.version).toBe('test')
    expect(e.exported_at.endsWith('Z')).toBe(true)
  })

  it('contains exactly the canonical data keys — no derived cache, no operator tables', () => {
    const e = envelope()
    expect(Object.keys(e.data).sort()).toEqual([...BACKUP_DATA_KEYS].sort())
    // Explicit absence of every excluded surface, spelled out so a future key addition that
    // quietly reintroduces one fails here rather than shipping.
    const excluded = [
      'portfolio_snapshots',
      'portfolio_recompute_queue',
      'portfolio_recompute_runs',
      'price_snapshots',
      'fx_rates',
      'price_sync_runs',
      'catalog_sync_runs',
      'invitations',
      'invitation_claims',
      'invitation_redemptions',
      'card_series',
      'card_sets',
      'cards',
      'card_variants',
      // NB: sealed_products IS a canonical section since D-076 — it carries ONLY the
      // owner-created subset; curated rows travel exclusively via the identity manifest.
      'watched_card_variants',
    ]
    for (const key of excluded) {
      expect(Object.keys(e.data)).not.toContain(key)
    }
  })

  it('counts reconcile with the sections they describe', () => {
    const e = envelope()
    expect(e.counts['holdings']).toBe(e.data.holdings.length)
    expect(e.counts['profiles']).toBe(1)
    expect(e.counts['identity_manifest.card_variants']).toBe(
      e.identity_manifest.card_variants.length,
    )
    for (const key of BACKUP_DATA_KEYS) {
      expect(typeof e.counts[key]).toBe('number')
    }
  })
})

describe('determinism and money/null semantics in serialization', () => {
  it('is byte-identical for identical data and timestamp', () => {
    const a = serializeBackupEnvelope(envelope())
    const b = serializeBackupEnvelope(envelope())
    expect(a).toBe(b)
  })

  it('changes only exported_at when the clock moves', () => {
    const a = serializeBackupEnvelope(envelope())
    const b = serializeBackupEnvelope(
      buildBackupEnvelope(fixtureSnapshot(), {
        exportedAt: '2026-08-24T10:00:01.000Z',
        appVersion: 'test',
      }),
    )
    expect(a).not.toBe(b)
    expect(a.replace(FIXED_EXPORTED_AT, '')).toBe(b.replace('2026-08-24T10:00:01.000Z', ''))
  })

  it('preserves null as null and zero as zero — never conflates them', () => {
    const e = envelope()
    const giftLot = e.data.acquisition_lots.find((l) => l.cost_basis_state === 'not_paid')
    expect(giftLot?.unit_cost_basis_minor).toBeNull()
    const knownLot = e.data.acquisition_lots.find((l) => l.cost_basis_state === 'known')
    expect(knownLot?.residual_minor).toBe('0') // genuine zero survives as zero
    const uncostedLine = e.data.sale_lines.find((l) => l.id.startsWith('y2'))
    expect(uncostedLine?.cost_basis_at_sale_nok_minor).toBeNull()
    expect(uncostedLine?.realized_result_nok_minor).toBeNull()
  })

  it('carries exact integer minor units past 2^53 untouched', () => {
    const raw = serializeBackupEnvelope(envelope())
    expect(raw).toContain('"9007199254740993"')
  })

  it('keeps the frozen FX triple verbatim on transactions (F11)', () => {
    const eurPurchase = envelope().data.purchases.find((p) => p.currency === 'EUR')
    expect(eurPurchase?.fx_rate_to_nok).toBe('11.54000000')
    expect(eurPurchase?.fx_rate_date).toBe('2026-01-08')
    expect(eurPurchase?.fx_source).toBe('manual')
    expect(eurPurchase?.total_nok_minor).toBe('5193')
  })
})

describe('minor-units branding boundary', () => {
  it('accepts exact integer decimal strings, including negatives and huge magnitudes', () => {
    expect(isMinorUnitsString('0')).toBe(true)
    expect(isMinorUnitsString('-455')).toBe(true)
    expect(isMinorUnitsString('9007199254740993')).toBe(true)
  })

  it('rejects anything a float could have touched', () => {
    for (const bad of ['', '1.50', '1e3', ' 1', '1 ', 'NaN', 'Infinity', '+5']) {
      expect(isMinorUnitsString(bad)).toBe(false)
    }
    expect(() => minorUnits('1.5')).toThrow()
  })
})

describe('envelope validator / type guard', () => {
  it('accepts a freshly built envelope', () => {
    expect(validateBackupEnvelope(JSON.parse(serializeBackupEnvelope(envelope()))).valid).toBe(true)
    expect(() => {
      assertBackupEnvelope(JSON.parse(serializeBackupEnvelope(envelope())))
    }).not.toThrow()
  })

  const broken = (mutate: (e: ReturnType<typeof envelope>) => unknown): unknown => {
    const e = envelope()
    return mutate(e)
  }

  it('rejects wrong format id', () => {
    const result = validateBackupEnvelope(broken((e) => ({ ...e, format: 'other' })))
    expect(result.valid).toBe(false)
    expect(result.failure?.path).toBe('format')
  })

  it('rejects an unknown schema version (compatibility policy) — v1 included, post-M16', () => {
    // v2 is the only version this reader understands: v1 files are pre-Openings artifacts, and a
    // generated backup claiming v1 while canonical openings exist is a release blocker (P53 §22).
    for (const stale of [1, 3]) {
      const result = validateBackupEnvelope(broken((e) => ({ ...e, schema_version: stale })))
      expect(result.valid).toBe(false)
      expect(result.failure?.path).toBe('schema_version')
    }
  })

  it('v2 policy (D-076 as extended by M16): an unknown future section is refused at the current version', () => {
    // Distinguishing test for the adjudicated version policy: within-version forward tolerance
    // was REJECTED. A future canonical section is only legitimate alongside a schema_version
    // bump, which the next reader then owns wholesale.
    const e = envelope() as unknown as Record<string, unknown>
    const withNewSection = {
      ...e,
      data: { ...(e['data'] as Record<string, unknown>), some_future_section: [] },
    }
    expect(validateBackupEnvelope(withNewSection).valid).toBe(false)
  })

  it('carries the canonical openings section with its relationship fields (P53 §20/§22)', () => {
    const e = envelope()
    expect(e.data.openings).toEqual([])
    expect(BACKUP_DATA_KEYS.indexOf('openings')).toBeGreaterThan(-1)
    // Every lot/disposal row exposes the opening linkage column — null when unrelated.
    for (const lot of e.data.acquisition_lots) {
      expect('opening_id' in lot).toBe(true)
    }
    for (const disposal of e.data.lot_disposals) {
      expect('opening_id' in disposal).toBe(true)
    }
  })

  it('a generated post-M16 backup with openings is v2, counts them, and preserves linkage + exact money (I13)', () => {
    const opening = {
      id: 'o1000000-0000-4000-8000-000000000001',
      user_id: FIXTURE_IDS.profileUserId,
      opened_on: '2026-08-01',
      source_lot_id: FIXTURE_IDS_M16.lotSealed,
      sealed_product_id: FIXTURE_IDS.sealedUserCreated,
      quantity_opened: 3,
      cost_source: 'from_lot',
      cost_nok_minor: minorUnits('29995'),
      tracking_completeness: 'all_cards',
      bulk_remainder_estimate_nok_minor: null,
      bulk_remainder_count: null,
      provisional_purchase_id: FIXTURE_IDS_M16.purchaseProvisional,
      reconciled_at: null,
      reconciled_to_purchase_id: null,
      idempotency_key: FIXTURE_IDS_M16.openingIdempotencyKey,
      notes: null,
      created_at: '2026-08-01T10:00:00+00:00',
      voided_at: null,
    }
    const pullLot = {
      ...fixtureSnapshot().acquisition_lots[0]!,
      id: FIXTURE_IDS_M16.lotSealed,
      origin: 'opening',
      opening_id: opening.id,
    }
    const snapshot = {
      ...fixtureSnapshot(),
      openings: [opening],
      acquisition_lots: [...fixtureSnapshot().acquisition_lots, pullLot],
    }
    const raw = serializeBackupEnvelope(
      buildBackupEnvelope(snapshot, { exportedAt: FIXED_EXPORTED_AT, appVersion: 'test' }),
    )
    expect(raw).toContain('"schema_version":2')
    const parsed = JSON.parse(raw) as {
      counts: Record<string, number>
      data: Record<string, Record<string, unknown>[]>
    }
    expect(parsed.counts['openings']).toBe(1)
    const serializedOpenings = parsed.data['openings'] ?? []
    expect(serializedOpenings[0]?.['cost_nok_minor']).toBe('29995') // exact text money
    // The serialized pull lot carries its opening relationship.
    const lots = parsed.data['acquisition_lots'] ?? []
    const serializedPull = lots.find((l) => l['id'] === FIXTURE_IDS_M16.lotSealed)
    expect(serializedPull?.['opening_id']).toBe(opening.id)
    // Round-trips through the v2 validator.
    expect(validateBackupEnvelope(parsed).valid).toBe(true)
  })

  it('rejects a non-UTC export timestamp', () => {
    const result = validateBackupEnvelope(
      broken((e) => ({ ...e, exported_at: '2026-08-24T12:00:00+02:00' })),
    )
    expect(result.valid).toBe(false)
  })

  it('rejects negative or fractional counts and missing counts', () => {
    expect(
      validateBackupEnvelope(broken((e) => ({ ...e, counts: { ...e.counts, holdings: -1 } })))
        .valid,
    ).toBe(false)
    expect(
      validateBackupEnvelope(broken((e) => ({ ...e, counts: { ...e.counts, sales: 1.5 } }))).valid,
    ).toBe(false)
    const missing = envelope()
    const countsWithoutSales: Record<string, number> = { ...missing.counts }
    delete countsWithoutSales['sales']
    expect(validateBackupEnvelope({ ...missing, counts: countsWithoutSales }).failure?.path).toBe(
      'counts.sales',
    )
  })

  it('rejects unknown data keys (a v1 reader refuses what it cannot name)', () => {
    const e = envelope() as unknown as Record<string, unknown>
    const data = { ...(e['data'] as Record<string, unknown>), future_table: [] }
    const result = validateBackupEnvelope({ ...e, data })
    expect(result.valid).toBe(false)
    expect(result.failure?.path).toBe('data.future_table')
  })

  it('rejects non-array row sections and a malformed manifest', () => {
    const e = envelope() as unknown as Record<string, unknown>
    const data = { ...(e['data'] as Record<string, unknown>), tags: { oops: true } }
    expect(validateBackupEnvelope({ ...e, data }).failure?.path).toBe('data.tags')

    const manifest = { card_variants: [], curated_sealed_products: null }
    expect(
      validateBackupEnvelope({ ...(e as object), identity_manifest: manifest }).failure?.path,
    ).toBe('identity_manifest.curated_sealed_products')
  })

  it('rejects an unknown manifest section (strict v1, same rule as data keys)', () => {
    const e = envelope() as unknown as Record<string, unknown>
    const manifest = {
      ...(e['identity_manifest'] as Record<string, unknown>),
      curated_cards: [],
    }
    const result = validateBackupEnvelope({ ...e, identity_manifest: manifest })
    expect(result.valid).toBe(false)
    expect(result.failure?.path).toBe('identity_manifest.curated_cards')
  })

  it('counts are integrity metadata: they must equal the arrays they name', () => {
    // The P39 corruption probe: a declared count over an empty array must NOT validate.
    const inflated = envelope() as unknown as Record<string, unknown>
    const counts = { ...(inflated['counts'] as Record<string, number>), tags: 100 }
    const data = { ...(inflated['data'] as Record<string, unknown>), tags: [] }
    let result = validateBackupEnvelope({ ...inflated, counts, data })
    expect(result.valid).toBe(false)
    expect(result.failure?.path).toBe('counts.tags')

    // Same rule for the manifest sections.
    const manifestCounts = envelope()
    const badManifestCounts = { ...manifestCounts.counts, 'identity_manifest.card_sets': 7 }
    result = validateBackupEnvelope({
      ...envelope(),
      counts: badManifestCounts,
    })
    expect(result.valid).toBe(false)
    expect(result.failure?.path).toBe('counts.identity_manifest.card_sets')
  })

  it('rejects counts for sections this schema_version does not carry', () => {
    const e = envelope() as unknown as Record<string, unknown>
    const counts = {
      ...(e['counts'] as Record<string, number>),
      future_table: 3,
    }
    const result = validateBackupEnvelope({ ...e, counts })
    expect(result.valid).toBe(false)
    expect(result.failure?.path).toBe('counts.future_table')
  })
})
