/**
 * Synthetic M13 export fixtures shared by the domain-level export suites. Every value here is
 * invented; nothing resembles the owner's real data. The shape mirrors what the data layer's
 * fetchers produce so build-backup / csv-projections can be exercised without Supabase.
 */
import {
  emptyBackupData,
  minorUnits,
  type BackupEnvelope,
} from '../../src/domain/export/backup-format'
import { buildBackupEnvelope } from '../../src/domain/export/build-backup'
import type { ExportSnapshot } from '../../src/domain/export/snapshot-types'

export const FIXTURE_IDS = {
  profileUserId: 'a0000000-0000-4000-8000-0000000000aa',
  collection: 'c1000000-0000-4000-8000-000000000001',
  holdingMember: 'h0000000-0000-4000-8000-00000000000m',
  tagA: 't1000000-0000-4000-8000-00000000000a',
  tagB: 't2000000-0000-4000-8000-00000000000b',
  storageBinder: 's1000000-0000-4000-8000-000000000001',
  retailerShop: 'r1000000-0000-4000-8000-000000000001',
  holdingVariant: 'h1000000-0000-4000-8000-000000000001',
  holdingSealedCurated: 'h2000000-0000-4000-8000-000000000002',
  holdingManual: 'h3000000-0000-4000-8000-000000000003',
  holdingTombstoned: 'h4000000-0000-4000-8000-000000000004',
  variantHolo: 'v1000000-0000-4000-8000-000000000001',
  sealedCurated: 'c0000000-0000-4000-8000-00000000b001',
  setReferenced: 'k1000000-0000-4000-8000-000000000001',
  manualCard: 'm1000000-0000-4000-8000-000000000001',
  sealedUserCreated: 'u1000000-0000-4000-8000-000000000001',
  lotKnown: 'l1000000-0000-4000-8000-000000000001',
  lotNotPaid: 'l2000000-0000-4000-8000-000000000002',
  lotVoided: 'l3000000-0000-4000-8000-000000000003',
  valuationCurrent: 'w1000000-0000-4000-8000-000000000001',
  valuationSuperseded: 'w2000000-0000-4000-8000-000000000002',
  adjustment: 'j1000000-0000-4000-8000-000000000001',
  purchaseNok: 'p1000000-0000-4000-8000-000000000001',
  purchaseEur: 'p2000000-0000-4000-8000-000000000002',
  lineCard: 'q1000000-0000-4000-8000-000000000001',
  lineAccessory: 'q2000000-0000-4000-8000-000000000002',
  saleLive: 'x1000000-0000-4000-8000-000000000001',
  saleVoided: 'x2000000-0000-4000-8000-000000000002',
  saleLineCosted: 'y1000000-0000-4000-8000-000000000001',
  saleLineUncosted: 'y2000000-0000-4000-8000-000000000002',
  disposalSale: 'd1000000-0000-4000-8000-000000000001',
  disposalVoided: 'd2000000-0000-4000-8000-000000000002',
} as const

/**
 * A deliberately awkward dataset: tombstones, superseded history, unknown-vs-zero money,
 * a >2^53 minor-unit amount, formula-trigger free text, unicode, and a voided sale.
 */
export function fixtureSnapshot(): ExportSnapshot {
  const data = emptyBackupData()
  return {
    ...data,
    profiles: [
      {
        id: FIXTURE_IDS.profileUserId,
        display_name: '=HYPERLINK("http://evil.example")',
        theme: 'dark',
        display_currency: 'NOK',
        locale: 'nb-NO',
        hide_values: true,
        hide_low_value_by_default: false,
        low_value_threshold_minor: minorUnits('12000'),
        use_eu_pricing: true,
        collection_grid_density: 2,
        collection_default_view: 'grid',
        collection_default_sort: 'value_desc',
        default_condition: 'NM',
        default_language: 'en',
        default_storage_location_id: FIXTURE_IDS.storageBinder,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    custom_collections: [
      {
        id: FIXTURE_IDS.collection,
        user_id: FIXTURE_IDS.profileUserId,
        name: 'Binder 1, "core"',
        description: 'Line1\nLine2',
        color: '#ff0000',
        sort_order: 1,
        created_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    custom_collection_members: [
      {
        user_id: FIXTURE_IDS.profileUserId,
        collection_id: FIXTURE_IDS.collection,
        holding_id: FIXTURE_IDS.holdingVariant,
        sort_order: 0,
        added_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    tags: [
      {
        id: FIXTURE_IDS.tagA,
        user_id: FIXTURE_IDS.profileUserId,
        name: 'grail ＋bonus',
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
      {
        id: FIXTURE_IDS.tagB,
        user_id: FIXTURE_IDS.profileUserId,
        name: '@trades',
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    holding_tags: [
      {
        user_id: FIXTURE_IDS.profileUserId,
        holding_id: FIXTURE_IDS.holdingVariant,
        tag_id: FIXTURE_IDS.tagA,
        created_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    storage_locations: [
      {
        id: FIXTURE_IDS.storageBinder,
        user_id: FIXTURE_IDS.profileUserId,
        name: 'Binder α',
        kind: 'binder',
        sort_order: 0,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    retailers: [
      {
        id: FIXTURE_IDS.retailerShop,
        user_id: FIXTURE_IDS.profileUserId,
        name: '-Local Store',
        notes: null,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    holdings: [
      {
        id: FIXTURE_IDS.holdingVariant,
        user_id: FIXTURE_IDS.profileUserId,
        holding_kind: 'raw_card',
        card_variant_id: FIXTURE_IDS.variantHolo,
        sealed_product_id: null,
        manual_card_id: null,
        grading_state: 'raw',
        condition: 'NM',
        grader: null,
        grade: null,
        cert_number: null,
        is_favorite: true,
        notes: 'Card, with comma "and quotes"',
        deleted_at: null,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
      {
        id: FIXTURE_IDS.holdingSealedCurated,
        user_id: FIXTURE_IDS.profileUserId,
        holding_kind: 'sealed_product',
        card_variant_id: null,
        sealed_product_id: FIXTURE_IDS.sealedCurated,
        manual_card_id: null,
        grading_state: 'raw',
        condition: null,
        grader: null,
        grade: null,
        cert_number: null,
        is_favorite: false,
        notes: null,
        deleted_at: null,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
      {
        id: FIXTURE_IDS.holdingManual,
        user_id: FIXTURE_IDS.profileUserId,
        holding_kind: 'raw_card',
        card_variant_id: null,
        sealed_product_id: null,
        manual_card_id: FIXTURE_IDS.manualCard,
        grading_state: 'raw',
        condition: 'GOOD',
        grader: null,
        grade: null,
        cert_number: '\tTABSTART',
        is_favorite: false,
        notes: null,
        deleted_at: null,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
      {
        id: FIXTURE_IDS.holdingTombstoned,
        user_id: FIXTURE_IDS.profileUserId,
        holding_kind: 'raw_card',
        card_variant_id: FIXTURE_IDS.variantHolo,
        sealed_product_id: null,
        manual_card_id: null,
        grading_state: 'raw',
        condition: 'POOR',
        grader: null,
        grade: null,
        cert_number: null,
        is_favorite: false,
        notes: null,
        deleted_at: '2026-02-03T04:05:06+00:00',
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-02-03T04:05:06+00:00',
      },
    ],
    acquisition_lots: [
      {
        id: FIXTURE_IDS.lotKnown,
        user_id: FIXTURE_IDS.profileUserId,
        holding_id: FIXTURE_IDS.holdingVariant,
        purchase_line_id: FIXTURE_IDS.lineCard,
        origin: 'purchase',
        cost_basis_state: 'known',
        cost_basis_currency: 'NOK',
        // Beyond Number.MAX_SAFE_INTEGER — the whole point of string-carried money.
        unit_cost_basis_minor: minorUnits('9007199254740993'),
        unit_cost_basis_nok_minor: minorUnits('9007199254740993'),
        residual_minor: minorUnits('0'),
        residual_nok_minor: minorUnits('0'),
        quantity: 2,
        quantity_remaining: 1,
        sealed_intent: null,
        storage_location_id: FIXTURE_IDS.storageBinder,
        acquired_on: '2026-01-05',
        voided_at: null,
        notes: 'multi\nline note',
        created_at: '2026-01-02T03:04:05+00:00',
      },
      {
        id: FIXTURE_IDS.lotNotPaid,
        user_id: FIXTURE_IDS.profileUserId,
        holding_id: FIXTURE_IDS.holdingManual,
        purchase_line_id: null,
        origin: 'gift',
        cost_basis_state: 'not_paid',
        cost_basis_currency: null,
        unit_cost_basis_minor: null,
        unit_cost_basis_nok_minor: null,
        residual_minor: minorUnits('0'),
        residual_nok_minor: minorUnits('0'),
        quantity: 1,
        quantity_remaining: 1,
        sealed_intent: null,
        storage_location_id: null,
        acquired_on: '2026-01-06',
        voided_at: null,
        notes: null,
        created_at: '2026-01-02T03:04:05+00:00',
      },
      {
        id: FIXTURE_IDS.lotVoided,
        user_id: FIXTURE_IDS.profileUserId,
        holding_id: FIXTURE_IDS.holdingTombstoned,
        purchase_line_id: null,
        origin: 'pre_tracking',
        cost_basis_state: 'unknown',
        cost_basis_currency: null,
        unit_cost_basis_minor: null,
        unit_cost_basis_nok_minor: null,
        residual_minor: minorUnits('0'),
        residual_nok_minor: minorUnits('0'),
        quantity: 1,
        quantity_remaining: 0,
        sealed_intent: null,
        storage_location_id: null,
        acquired_on: '2026-01-07',
        voided_at: '2026-02-03T04:05:06+00:00',
        notes: null,
        created_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    manual_card_definitions: [
      {
        id: FIXTURE_IDS.manualCard,
        user_id: FIXTURE_IDS.profileUserId,
        name: 'Test-san プリズム',
        set_name: 'Home Set @Test',
        collector_number: '=1+1',
        language: 'ja',
        finish: 'holo',
        stamp: null,
        subtype: 'basic',
        size: 'standard',
        notes: null,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    sealed_products: [
      {
        id: FIXTURE_IDS.sealedUserCreated,
        created_by_user_id: FIXTURE_IDS.profileUserId,
        name: 'My custom box',
        product_type: 'booster_box',
        language: 'no',
        pack_count: 36,
        set_id: FIXTURE_IDS.setReferenced,
        image_url: null,
        cardmarket_product_id: null,
        tcgplayer_product_id: null,
        created_at: '2026-01-02T03:04:05+00:00',
        updated_at: '2026-01-02T03:04:05+00:00',
      },
    ],
    manual_valuations: [
      {
        id: FIXTURE_IDS.valuationSuperseded,
        user_id: FIXTURE_IDS.profileUserId,
        holding_id: FIXTURE_IDS.holdingSealedCurated,
        value_minor: minorUnits('100000'),
        currency: 'NOK',
        value_nok_minor: minorUnits('100000'),
        effective_from: '2026-01-10',
        note: null,
        superseded_at: '2026-01-20T10:00:00+00:00',
        created_at: '2026-01-10T09:00:00+00:00',
      },
      {
        id: FIXTURE_IDS.valuationCurrent,
        user_id: FIXTURE_IDS.profileUserId,
        holding_id: FIXTURE_IDS.holdingSealedCurated,
        value_minor: minorUnits('125000'),
        currency: 'NOK',
        value_nok_minor: minorUnits('125000'),
        effective_from: '2026-01-20',
        note: 'after market check',
        superseded_at: null,
        created_at: '2026-01-20T10:00:00+00:00',
      },
    ],
    lot_cost_adjustments: [
      {
        id: FIXTURE_IDS.adjustment,
        user_id: FIXTURE_IDS.profileUserId,
        lot_id: FIXTURE_IDS.lotKnown,
        purchase_line_id: FIXTURE_IDS.lineCard,
        kind: 'grading_fee',
        occurred_on: '2026-03-01',
        amount_minor: minorUnits('3000'),
        currency: 'NOK',
        amount_nok_minor: minorUnits('3000'),
        note: null,
        created_at: '2026-03-01T00:00:00+00:00',
      },
    ],
    purchases: [
      {
        id: FIXTURE_IDS.purchaseNok,
        user_id: FIXTURE_IDS.profileUserId,
        purchased_on: '2026-01-05',
        retailer_id: FIXTURE_IDS.retailerShop,
        currency: 'NOK',
        subtotal_minor: minorUnits('90000'),
        shipping_minor: minorUnits('9900'),
        customs_minor: minorUnits('0'),
        discount_minor: minorUnits('0'),
        total_minor: minorUnits('99900'),
        total_nok_minor: minorUnits('99900'),
        fx_rate_to_nok: '1.00000000',
        fx_rate_date: '2026-01-05',
        fx_source: 'norges_bank',
        origin: 'standard',
        notes: 'receipt in binder',
        voided_at: null,
        created_at: '2026-01-05T12:00:00+00:00',
        updated_at: '2026-01-05T12:00:00+00:00',
      },
      {
        id: FIXTURE_IDS.purchaseEur,
        user_id: FIXTURE_IDS.profileUserId,
        purchased_on: '2026-01-08',
        retailer_id: null,
        currency: 'EUR',
        subtotal_minor: minorUnits('500'),
        shipping_minor: minorUnits('0'),
        customs_minor: minorUnits('0'),
        discount_minor: minorUnits('50'),
        total_minor: minorUnits('450'),
        total_nok_minor: minorUnits('5193'),
        fx_rate_to_nok: '11.54000000',
        fx_rate_date: '2026-01-08',
        fx_source: 'manual',
        origin: 'standard',
        // Deliberate formula-injection attempt — CSV layer must neutralize, JSON preserves.
        notes: '=SUM(A1:A9)',
        voided_at: null,
        created_at: '2026-01-08T12:00:00+00:00',
        updated_at: '2026-01-08T12:00:00+00:00',
      },
    ],
    purchase_lines: [
      {
        id: FIXTURE_IDS.lineCard,
        user_id: FIXTURE_IDS.profileUserId,
        purchase_id: FIXTURE_IDS.purchaseNok,
        line_type: 'card',
        spend_class: 'collectible',
        description: null,
        card_variant_id: FIXTURE_IDS.variantHolo,
        sealed_product_id: null,
        condition: 'NM',
        quantity: 2,
        unit_price_minor: minorUnits('45000'),
        line_total_minor: minorUnits('90000'),
        allocated_shipping_minor: minorUnits('4950'),
        allocated_customs_minor: minorUnits('0'),
        allocated_discount_minor: minorUnits('0'),
        attributable_cost_minor: minorUnits('94950'),
        attributable_cost_nok_minor: minorUnits('94950'),
        created_at: '2026-01-05T12:00:00+00:00',
        updated_at: '2026-01-05T12:00:00+00:00',
      },
      {
        id: FIXTURE_IDS.lineAccessory,
        user_id: FIXTURE_IDS.profileUserId,
        purchase_id: FIXTURE_IDS.purchaseNok,
        line_type: 'accessory',
        spend_class: 'hobby_supplies',
        description: '+TOPLOADER bundle\t',
        card_variant_id: null,
        sealed_product_id: null,
        condition: null,
        quantity: 1,
        unit_price_minor: minorUnits('4500'),
        line_total_minor: minorUnits('4500'),
        allocated_shipping_minor: minorUnits('4950'),
        allocated_customs_minor: minorUnits('0'),
        allocated_discount_minor: minorUnits('0'),
        attributable_cost_minor: minorUnits('9450'),
        attributable_cost_nok_minor: minorUnits('9450'),
        created_at: '2026-01-05T12:00:00+00:00',
        updated_at: '2026-01-05T12:00:00+00:00',
      },
    ],
    sales: [
      {
        id: FIXTURE_IDS.saleLive,
        user_id: FIXTURE_IDS.profileUserId,
        sold_on: '2026-04-01',
        marketplace: '@Marketplace; "Finn"',
        currency: 'NOK',
        gross_minor: minorUnits('150000'),
        fees_minor: minorUnits('5000'),
        shipping_cost_minor: minorUnits('8900'),
        shipping_charged_minor: minorUnits('7900'),
        net_proceeds_minor: minorUnits('144000'),
        net_proceeds_nok_minor: minorUnits('144000'),
        realized_result_nok_minor: minorUnits('-123456'),
        proceeds_from_uncosted_nok_minor: minorUnits('0'),
        fx_rate_to_nok: '1.00000000',
        fx_rate_date: '2026-04-01',
        fx_source: 'norges_bank',
        notes: null,
        idempotency_key: '11111111-2222-4333-8444-555555555555',
        voided_at: null,
        created_at: '2026-04-01T12:00:00+00:00',
        updated_at: '2026-04-01T12:00:00+00:00',
      },
      {
        id: FIXTURE_IDS.saleVoided,
        user_id: FIXTURE_IDS.profileUserId,
        sold_on: '2026-04-02',
        marketplace: null,
        currency: 'NOK',
        gross_minor: minorUnits('2500'),
        fees_minor: minorUnits('0'),
        shipping_cost_minor: minorUnits('0'),
        shipping_charged_minor: minorUnits('0'),
        net_proceeds_minor: minorUnits('2500'),
        net_proceeds_nok_minor: minorUnits('2500'),
        realized_result_nok_minor: null,
        proceeds_from_uncosted_nok_minor: minorUnits('2500'),
        fx_rate_to_nok: '1.00000000',
        fx_rate_date: '2026-04-02',
        fx_source: 'norges_bank',
        notes: 'entered twice, voided',
        idempotency_key: '66666666-7777-4888-8999-000000000000',
        voided_at: '2026-04-03T08:00:00+00:00',
        created_at: '2026-04-02T12:00:00+00:00',
        updated_at: '2026-04-03T08:00:00+00:00',
      },
    ],
    sale_lines: [
      {
        id: FIXTURE_IDS.saleLineCosted,
        user_id: FIXTURE_IDS.profileUserId,
        sale_id: FIXTURE_IDS.saleLive,
        lot_id: FIXTURE_IDS.lotKnown,
        quantity: 1,
        unit_gross_minor: minorUnits('150000'),
        line_gross_minor: minorUnits('150000'),
        allocated_fees_minor: minorUnits('5000'),
        allocated_shipping_minor: minorUnits('8900'),
        allocated_shipping_charged_minor: minorUnits('7900'),
        net_proceeds_minor: minorUnits('144000'),
        net_proceeds_nok_minor: minorUnits('144000'),
        cost_basis_at_sale_nok_minor: minorUnits('267456'),
        realized_result_nok_minor: minorUnits('-123456'),
        created_at: '2026-04-01T12:00:00+00:00',
      },
      {
        id: FIXTURE_IDS.saleLineUncosted,
        user_id: FIXTURE_IDS.profileUserId,
        sale_id: FIXTURE_IDS.saleVoided,
        lot_id: FIXTURE_IDS.lotNotPaid,
        quantity: 1,
        unit_gross_minor: minorUnits('2500'),
        line_gross_minor: minorUnits('2500'),
        allocated_fees_minor: minorUnits('0'),
        allocated_shipping_minor: minorUnits('0'),
        allocated_shipping_charged_minor: minorUnits('0'),
        net_proceeds_minor: minorUnits('2500'),
        net_proceeds_nok_minor: minorUnits('2500'),
        // Unknown basis stays NULL — the honesty bar this suite exists to protect.
        cost_basis_at_sale_nok_minor: null,
        realized_result_nok_minor: null,
        created_at: '2026-04-02T12:00:00+00:00',
      },
    ],
    lot_disposals: [
      {
        id: FIXTURE_IDS.disposalSale,
        user_id: FIXTURE_IDS.profileUserId,
        lot_id: FIXTURE_IDS.lotKnown,
        sale_line_id: FIXTURE_IDS.saleLineCosted,
        kind: 'sale',
        disposed_on: '2026-04-01',
        quantity: 1,
        cost_basis_at_disposal_nok_minor: minorUnits('267456'),
        voided_at: null,
        created_at: '2026-04-01T12:00:00+00:00',
      },
      {
        id: FIXTURE_IDS.disposalVoided,
        user_id: FIXTURE_IDS.profileUserId,
        lot_id: FIXTURE_IDS.lotNotPaid,
        sale_line_id: FIXTURE_IDS.saleLineUncosted,
        kind: 'sale',
        disposed_on: '2026-04-02',
        quantity: 1,
        cost_basis_at_disposal_nok_minor: null,
        voided_at: '2026-04-03T08:00:00+00:00',
        created_at: '2026-04-02T12:00:00+00:00',
      },
    ],
    identity_manifest: {
      card_variants: [
        {
          id: FIXTURE_IDS.variantHolo,
          finish: 'holo',
          stamp: '',
          subtype: 'basic',
          size: 'standard',
          tcgdex_variant_id: null,
          cardmarket_product_id: '317925',
          tcgplayer_product_id: null,
          card_name: 'Alcremie ミラブリズム',
          card_local_id: '147',
          card_language: 'en',
          tcgdex_card_id: 'swsh4-147',
          set_slug: 'swsh4',
          set_name: 'Vivid Voltage',
        },
      ],
      curated_sealed_products: [
        {
          id: FIXTURE_IDS.sealedCurated,
          name: 'Curated ETB (fixture)',
          product_type: 'elite_trainer_box',
          language: 'en',
          pack_count: 8,
          cardmarket_product_id: null,
          tcgplayer_product_id: null,
          set_slug: null,
          set_name: null,
        },
      ],
      card_sets: [
        {
          id: FIXTURE_IDS.setReferenced,
          slug: 'swsh45-sv',
          name: 'Shiny Vault (fixture set)',
          language: 'no',
          tcgdex_set_id: 'swsh45sv',
        },
      ],
    },
  }
}

export const FIXED_EXPORTED_AT = '2026-08-24T10:00:00.000Z'

export function fixedEnvelope(): BackupEnvelope {
  return buildBackupEnvelope(fixtureSnapshot(), {
    exportedAt: FIXED_EXPORTED_AT,
    appVersion: 'test-0.0.0',
  })
}

// ---------------------------------------------------------------------------
// A minimal RFC 4180 reader, written independently of the writer under test so the property
// suite cross-checks two implementations instead of trusting one.
// ---------------------------------------------------------------------------

export function parseCsvRecord(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  let i = 0
  while (i < line.length) {
    const char = line.charAt(i)
    if (inQuotes) {
      if (char === '"') {
        if (line.charAt(i + 1) === '"') {
          current += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      current += char
      i += 1
      continue
    }
    if (char === '"' && current === '') {
      inQuotes = true
      i += 1
      continue
    }
    if (char === ',') {
      fields.push(current)
      current = ''
      i += 1
      continue
    }
    current += char
    i += 1
  }
  fields.push(current)
  return fields
}

/** Splits a full CSV body (CRLF-separated) into records and applies {@link parseCsvRecord}. */
export function parseCsvBody(body: string): string[][] {
  const BOM = String.fromCharCode(0xfeff)
  const withoutBom = body.startsWith(BOM) ? body.slice(1) : body
  const trimmed = withoutBom.endsWith('\r\n') ? withoutBom.slice(0, -2) : withoutBom
  if (trimmed.length === 0) return []
  return trimmed.split('\r\n').map(parseCsvRecord)
}
