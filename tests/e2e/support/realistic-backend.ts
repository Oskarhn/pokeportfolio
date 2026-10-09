import type { Page, Route } from '@playwright/test'
import { installFakeSession } from './fake-session'

/**
 * P210: a deterministic, network-boundary stand-in for the backend that answers with REALISTIC rows
 * — many holdings, long names, several lots, mixed currencies, very large amounts, missing and stale
 * prices, raw/graded/sealed — in exactly the wire shapes src/data/* parses (money as text, `.single()`
 * reads as an object, embeds as nested objects).
 *
 * P202's generic-backend answers only "empty", "error" and "expired". This one lets the same built
 * bundle render its data states without a database. It is a layout and accessibility fixture, not a
 * financial oracle: nothing here is asserted as a correct total, only that what the server said is
 * shown honestly and fits the screen.
 */

export type PriceState = 'manual' | 'fresh' | 'stale' | 'missing'
export type Kind = 'raw' | 'graded' | 'sealed'

export interface FixtureHolding {
  id: string
  kind: Kind
  name: string
  setName: string
  number: string
  quantity: number
  lotCount: number
  priceState: PriceState
  /** Minor units as a decimal string; null for a missing price. */
  unitValue: string | null
  holdingValue: string | null
  condition: string | null
  grader: string | null
  grade: number | null
  language: string
}

export interface Scenario {
  holdings: FixtureHolding[]
  displayCurrency?: 'NOK' | 'EUR' | 'USD'
  /** Per-endpoint latency in ms (key: rpc name, table name or "*"). */
  latencyMs?: Record<string, number>
  /** Endpoints that answer HTTP 500. */
  failing?: string[]
  /** Overrides for the dashboard summary (all values are decimal strings or null). */
  summary?: Record<string, string | number | boolean | null>
}

const NAMES = [
  'Charizard',
  'Pikachu',
  'Mewtwo',
  'Gengar',
  'Rayquaza',
  'Lugia',
  'Umbreon',
  'Eevee',
  'Snorlax',
  'Dragonite',
]

const LONG_SUFFIXES = [
  '',
  ' ex Special Illustration Rare',
  " — Trainer's Hidden Treasure Premium Collection Gallery Edition (Japanese Exclusive Reprint)",
  ' VMAX Alternate Art Secret Rare Gold Foil Stamped Tournament Prize Promotional Variant',
]

const SETS = [
  'Base Set',
  'Scarlet & Violet — Paldean Fates Special Edition Shiny Treasure Collection',
  '151',
  'Crown Zenith: Galarian Gallery',
  'Sword & Shield Black Star Promos',
]

/** Deterministic pseudo-random so every run renders the same pixels. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/**
 * `count` holdings with a fixed mix: ~60 % raw, ~25 % graded, ~15 % sealed; ~1 in 7 has no price,
 * ~1 in 6 a stale one, ~1 in 11 a manual value; every 9th has several lots; every 25th carries an
 * eight-figure NOK value (more than 2^53 minor units for every 200th).
 */
export function makeHoldings(count: number, seed = 7): FixtureHolding[] {
  const rnd = lcg(seed)
  const out: FixtureHolding[] = []
  for (let i = 1; i <= count; i += 1) {
    const kind: Kind = i % 20 < 12 ? 'raw' : i % 20 < 17 ? 'graded' : 'sealed'
    const priceState: PriceState =
      i % 7 === 0 ? 'missing' : i % 6 === 0 ? 'stale' : i % 11 === 0 ? 'manual' : 'fresh'
    const quantity = i % 13 === 0 ? 120 : 1 + Math.floor(rnd() * 4)
    let unit = BigInt(100 + Math.floor(rnd() * 250_000))
    if (i % 25 === 0) unit = 12_345_678_900n
    if (i % 200 === 0) unit = 9_007_199_254_740_993n // 2^53 + 1: not representable as a JS number
    const holdingValue = unit * BigInt(quantity)
    const base = `${NAMES[i % NAMES.length]}${LONG_SUFFIXES[i % LONG_SUFFIXES.length]}`
    out.push({
      id: uuid(i),
      kind,
      name: kind === 'sealed' ? `${base} Elite Trainer Box` : base,
      setName: SETS[i % SETS.length] ?? 'Base Set',
      number: kind === 'sealed' ? '' : String((i % 230) + 1).padStart(3, '0'),
      quantity,
      lotCount: i % 9 === 0 ? 7 : 1,
      priceState,
      unitValue: priceState === 'missing' ? null : unit.toString(),
      holdingValue: priceState === 'missing' ? null : holdingValue.toString(),
      condition: kind === 'raw' ? (['NM', 'LP', 'PL'][i % 3] ?? 'NM') : null,
      grader: kind === 'graded' ? (['psa', 'cgc', 'bgs'][i % 3] ?? 'psa') : null,
      grade: kind === 'graded' ? 7 + (i % 4) : null,
      language: ['en', 'ja', 'de'][i % 3] ?? 'en',
    })
  }
  return out
}

function tileRow(h: FixtureHolding): Record<string, unknown> {
  const graded = h.kind === 'graded'
  const sealed = h.kind === 'sealed'
  return {
    holding_id: h.id,
    holding_kind: h.kind === 'raw' ? 'raw_card' : h.kind === 'graded' ? 'graded_card' : 'sealed',
    card_variant_id: sealed ? null : uuid(10_000 + Number(h.id.slice(-12))),
    manual_card_id: null,
    condition: h.condition,
    grading_state: graded ? 'graded' : 'raw',
    grader: h.grader,
    grade: h.grade,
    cert_number: graded ? '12345678' : null,
    is_favorite: false,
    notes: null,
    created_at: '2026-09-01T10:00:00.000Z',
    quantity: h.quantity,
    lot_count: h.lotCount,
    variant_finish: 'holo',
    variant_stamp: null,
    variant_subtype: null,
    card_name: sealed ? null : h.name,
    card_local_id: sealed ? null : h.number,
    card_image_base_url: null,
    card_language: h.language,
    card_set_id: 'base1',
    card_set_name: sealed ? null : h.setName,
    manual_name: null,
    manual_set_name: null,
    manual_collector_number: null,
    manual_language: null,
    sealed_product_id: sealed ? uuid(20_000) : null,
    sealed_product_type: sealed ? 'elite_trainer_box' : null,
    sealed_product_name: sealed ? h.name : null,
    sealed_product_language: sealed ? h.language : null,
    sealed_pack_count: sealed ? 9 : null,
    sealed_image_url: null,
    sealed_set_id: sealed ? 'base1' : null,
    sealed_set_name: sealed ? h.setName : null,
    sealed_is_custom: false,
    qty_keep_sealed: sealed ? h.quantity : 0,
    qty_planned_to_open: 0,
    qty_undecided: 0,
    unit_value_nok_minor: h.unitValue,
    holding_value_nok_minor: h.holdingValue,
    price_state: h.priceState,
    acquired_on_min: '2025-11-02',
    acquired_on_max: '2026-08-30',
    has_multiple_storage_locations: h.lotCount > 1,
    number_sort_key: h.number,
  }
}

function sum(holdings: FixtureHolding[], pick: (h: FixtureHolding) => boolean): bigint {
  return holdings.reduce(
    (acc, h) => (h.holdingValue !== null && pick(h) ? acc + BigInt(h.holdingValue) : acc),
    0n,
  )
}

function countsRow(holdings: FixtureHolding[]): Record<string, string> {
  const priced = holdings.filter((h) => h.priceState !== 'missing')
  const sealed = holdings.filter((h) => h.kind === 'sealed')
  const total = sum(holdings, () => true)
  const sealedValue = sum(holdings, (h) => h.kind === 'sealed')
  return {
    physical_card_count: String(holdings.reduce((a, h) => a + h.quantity, 0)),
    unique_holding_count: String(holdings.length),
    graded_count: String(holdings.filter((h) => h.kind === 'graded').length),
    manual_count: String(holdings.filter((h) => h.priceState === 'manual').length),
    priced_holding_count: String(priced.length),
    unpriced_holding_count: String(holdings.length - priced.length),
    portfolio_value_nok_minor: total.toString(),
    cards_value_nok_minor: (total - sealedValue).toString(),
    sealed_value_nok_minor: sealedValue.toString(),
    sealed_holding_count: String(sealed.length),
    sealed_priced_holding_count: String(sealed.filter((h) => h.priceState !== 'missing').length),
    sealed_unpriced_holding_count: String(sealed.filter((h) => h.priceState === 'missing').length),
    sealed_unit_count: String(sealed.reduce((a, h) => a + h.quantity, 0)),
  }
}

function summaryRow(s: Scenario): Record<string, unknown> {
  const c = countsRow(s.holdings)
  const total = c.portfolio_value_nok_minor ?? '0'
  return {
    pending_recompute: false,
    latest_snapshot_date: '2026-10-08',
    first_tracked_date: '2026-01-02',
    market_value_nok_minor: total,
    market_value_has_coverage: true,
    attributed_value_nok_minor: total,
    cost_basis_nok_minor: '2500000000',
    unrealized_result_nok_minor: (BigInt(total) - 2_500_000_000n).toString(),
    collectible_spend_to_date_nok_minor: '3100000000',
    sales_proceeds_to_date_nok_minor: '420000000',
    ttep_nok_minor: '0',
    snapshot_open_lot_count: String(s.holdings.length),
    snapshot_unvalued_lot_count: c.unpriced_holding_count,
    physical_card_count: c.physical_card_count,
    unique_holding_count: c.unique_holding_count,
    graded_holding_count: c.graded_count,
    sealed_holding_count: c.sealed_holding_count,
    sealed_unit_count: c.sealed_unit_count,
    manual_entry_count: c.manual_count,
    priced_holding_count: c.priced_holding_count,
    unpriced_holding_count: c.unpriced_holding_count,
    manual_valued_holding_count: c.manual_count,
    auto_priced_holding_count: String(Number(c.priced_holding_count) - Number(c.manual_count)),
    raw_value_nok_minor: c.cards_value_nok_minor,
    graded_value_nok_minor: '0',
    sealed_value_nok_minor: c.sealed_value_nok_minor,
    uncosted_open_lot_count: '4',
    gpo_nok_minor: '3100000000',
    cs_nok_minor: '3000000000',
    hs_nok_minor: '100000000',
    nsp_nok_minor: '400000000',
    rrc_nok_minor: '310000000',
    pud_nok_minor: '0',
    ncco_nok_minor: '2500000000',
    thco_nok_minor: '2600000000',
    thp_nok_minor: total,
    ...(s.summary ?? {}),
  }
}

function historyEvents(): Record<string, unknown>[] {
  const kinds = ['purchase', 'sale', 'acquisition', 'valuation', 'opening'] as const
  return Array.from({ length: 24 }, (_, i) => {
    const kind = kinds[i % kinds.length] ?? 'purchase'
    return {
      event_kind: kind,
      primary_id: uuid(30_000 + i),
      secondary_id: kind === 'acquisition' || kind === 'valuation' ? uuid(1 + i) : null,
      occurred_on: `2026-0${1 + (i % 9)}-1${i % 9}`,
      recorded_at: `2026-0${1 + (i % 9)}-1${i % 9}T12:00:00.000Z`,
      title: `${NAMES[i % NAMES.length]} ex — Special Illustration Rare, Japanese Exclusive Edition, near mint, sleeved and toploaded`,
      subtitle:
        ['Cardmarket order 4821', 'Shipping ¥ 1 250 · customs € 14,90', 'Manual value', ''][
          i % 4
        ] ?? '',
      amount_nok_minor: i % 5 === 3 ? null : String(150_000 + i * 17_500),
      status: i % 8 === 7 ? 'voided' : 'active',
      href: `/purchases/${uuid(30_000 + i)}`,
    }
  })
}

function purchaseRows(): Record<string, unknown>[] {
  const currencies = ['NOK', 'EUR', 'USD', 'JPY'] as const
  return Array.from({ length: 18 }, (_, i) => {
    const currency = currencies[i % currencies.length] ?? 'NOK'
    const total = currency === 'JPY' ? 1_250_000 + i : 45_000 + i * 3_100
    return {
      id: uuid(30_000 + i),
      purchased_on: `2026-0${1 + (i % 9)}-0${1 + (i % 8)}`,
      retailer_id: null,
      currency,
      subtotal_minor: String(total),
      shipping_minor: '1500',
      customs_minor: '0',
      discount_minor: '0',
      total_minor: String(total + 1500),
      fx_rate_to_nok: currency === 'NOK' ? '1' : currency === 'JPY' ? '0.0712' : '11.4321',
      fx_rate_date: `2026-0${1 + (i % 9)}-0${1 + (i % 8)}`,
      fx_source: 'norges_bank',
      total_nok_minor: String(Math.round((total + 1500) * (currency === 'NOK' ? 1 : 11.4))),
      notes:
        i % 3 === 0 ? 'Bundle from a collector in Osaka: twelve cards, two sealed boxes' : null,
      voided_at: i % 9 === 8 ? '2026-09-02T10:00:00.000Z' : null,
      retailers: i % 2 === 0 ? { name: 'Cardmarket — Sammler-Shop Westfalen GmbH & Co. KG' } : null,
      purchase_lines: [
        { spend_class: 'collectible', attributable_cost_nok_minor: String(total * 10) },
        { spend_class: 'hobby', attributable_cost_nok_minor: '15000' },
      ],
    }
  })
}

/** A purchase with several lines in mixed classes, as get_purchase's embed returns it. */
function purchaseDetailRow(): Record<string, unknown> {
  const first = purchaseRows()[1] ?? {}
  const line = (i: number): Record<string, unknown> => ({
    id: uuid(50_000 + i),
    line_type: i === 2 ? 'accessory' : i === 1 ? 'sealed' : 'card',
    spend_class: i === 2 ? 'hobby' : 'collectible',
    description: i === 2 ? 'Penny sleeves and toploaders, 200 pack, Ultra PRO premium' : null,
    card_variant_id: i === 0 ? uuid(10_001) : null,
    sealed_product_id: i === 1 ? uuid(20_000) : null,
    condition: i === 0 ? 'NM' : null,
    quantity: 2 + i,
    unit_price_minor: '1250000',
    line_total_minor: String(1_250_000 * (2 + i)),
    allocated_shipping_minor: '500',
    allocated_customs_minor: '0',
    allocated_discount_minor: '0',
    attributable_cost_minor: String(1_250_000 * (2 + i) + 500),
    attributable_cost_nok_minor: String((1_250_000 * (2 + i) + 500) * 11),
    card_variants:
      i === 0
        ? { cards: { name: 'Charizard ex Special Illustration Rare', local_id: '199' } }
        : null,
    sealed_products: i === 1 ? { name: 'Elite Trainer Box — Paldean Fates Special Edition' } : null,
  })
  return { ...first, purchase_lines: [line(0), line(1), line(2)] }
}

function lotRows(holdingId: string, lots: number): Record<string, unknown>[] {
  const currencies = ['NOK', 'EUR', 'USD', 'JPY', 'GBP', 'NOK', 'EUR']
  return Array.from({ length: lots }, (_, i) => ({
    id: uuid(40_000 + i),
    origin: i % 3 === 0 ? 'purchase' : i % 3 === 1 ? 'gift' : 'opening',
    cost_basis_state: i % 4 === 3 ? 'unknown' : 'known',
    acquired_on: `2026-0${1 + (i % 9)}-1${i % 9}`,
    quantity: 3,
    quantity_remaining: i === 0 ? 0 : 3,
    unit_cost_basis_minor: i % 4 === 3 ? null : String(250_000 + i * 12_345),
    cost_basis_currency: i % 4 === 3 ? null : (currencies[i] ?? 'NOK'),
    storage_location_id: null,
    notes:
      i === 2 ? 'Bought at a convention; sleeve has a corner crease noted on the receipt' : null,
    voided_at: i === 5 ? '2026-09-10T10:00:00.000Z' : null,
    created_at: `2026-0${1 + (i % 9)}-1${i % 9}T10:00:00.000Z`,
    storage_locations: i % 2 === 0 ? { name: 'Binder A · page 14 (alt-art, toploaders)' } : null,
    sealed_intent: null,
    purchase_line_id: holdingId && i % 3 === 0 ? uuid(50_000 + i) : null,
    purchase_lines: i % 3 === 0 ? { purchase_id: uuid(30_000 + i) } : null,
  }))
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** `Accept: application/vnd.pgrst.object+json` marks a `.single()`/`.maybeSingle()` read. */
function wantsObject(route: Route): boolean {
  return (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
}

function profileRow(s: Scenario): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    display_name: 'Synthetic Collector With A Rather Long Display Name Indeed',
    is_admin: false,
    theme: 'system',
    collection_grid_density: 3,
    collection_default_view: 'grid',
    collection_default_sort: 'value_desc',
    low_value_threshold_minor: '5000',
    hide_low_value_by_default: false,
    display_currency: s.displayCurrency ?? 'NOK',
    default_language: null,
    default_condition: null,
    default_storage_location_id: null,
    hide_values: false,
    use_eu_pricing: false,
  }
}

export interface RequestLog {
  /** rpc name or table name, in arrival order. */
  endpoints: string[]
}

export async function installRealisticBackend(page: Page, scenario: Scenario): Promise<RequestLog> {
  const log: RequestLog = { endpoints: [] }
  await installFakeSession(page)

  // External card art must never reach the real network from a test.
  await page.route(
    /^https?:\/\/(?!127\.0\.0\.1|localhost)[^/]+\/.*\.(png|jpe?g|webp)(\?.*)?$/i,
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }),
  )

  await page.route(/\/(rest|functions|auth)\/v1\//, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const url = new URL(request.url())
    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })

    if (url.pathname.includes('/auth/v1/')) {
      return respond(400, { error: 'invalid_grant', error_description: 'refresh refused' })
    }
    if (url.pathname.includes('/functions/v1/')) return respond(200, {})

    const name = url.pathname.replace(/^.*\/rest\/v1\/(rpc\/)?/, '')
    log.endpoints.push(name)
    const delay = scenario.latencyMs?.[name] ?? scenario.latencyMs?.['*'] ?? 0
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    if (scenario.failing?.includes(name)) return respond(500, { message: 'synthetic failure' })

    const object = wantsObject(route)
    const body = request.postDataJSON() as Record<string, unknown> | null

    switch (name) {
      case 'profiles':
        return respond(200, object ? profileRow(scenario) : [profileRow(scenario)])
      case 'list_portfolio': {
        const limit = Number(body?.p_limit ?? 30)
        const cursorId = body?.p_cursor_holding_id as string | undefined
        let rows = scenario.holdings
        const query = body?.p_query as string | undefined
        if (query) rows = rows.filter((h) => h.name.toLowerCase().includes(query.toLowerCase()))
        const start = cursorId ? rows.findIndex((h) => h.id === cursorId) + 1 : 0
        return respond(200, rows.slice(start, start + limit).map(tileRow))
      }
      case 'portfolio_counts':
        return respond(200, object ? countsRow(scenario.holdings) : [countsRow(scenario.holdings)])
      case 'get_dashboard_summary':
        return respond(200, object ? summaryRow(scenario) : [summaryRow(scenario)])
      case 'get_portfolio_history':
        return respond(
          200,
          Array.from({ length: 60 }, (_, i) => ({
            snapshot_date: `2026-${i < 30 ? '08' : '09'}-${String((i % 30) + 1).padStart(2, '0')}`,
            market_value_nok_minor: String(900_000_000 + i * 9_000_000),
            has_coverage: i % 17 !== 0,
            open_lot_count: '300',
            unvalued_lot_count: i % 17 === 0 ? '12' : '0',
            display_value_minor: null,
          })),
        )
      case 'get_monthly_spend':
        return respond(
          200,
          Array.from({ length: 12 }, (_, i) => ({
            month: `2025-${String(((i + 9) % 12) + 1).padStart(2, '0')}-01`,
            collectible_nok_minor: String(120_000 + i * 31_000),
            hobby_nok_minor: String(9_000 * (i % 3)),
            total_nok_minor: String(129_000 + i * 31_000),
          })),
        )
      case 'get_recent_activity':
        return respond(
          200,
          historyEvents()
            .slice(0, 8)
            .map((e) => ({
              activity_type: e.event_kind,
              primary_id: e.primary_id,
              secondary_id: e.secondary_id,
              occurred_on: e.occurred_on,
              amount_nok_minor: e.amount_nok_minor,
            })),
        )
      case 'list_history_events':
        return respond(200, historyEvents())
      case 'purchases':
        if (url.searchParams.has('id')) {
          // get_purchase uses .maybeSingle(): a plain request answered with a one-element array.
          const detail = purchaseDetailRow()
          return respond(200, object ? detail : [detail])
        }
        return respond(200, purchaseRows())
      case 'purchase_spending_summary': {
        const row = {
          gpo_nok_minor: '3100000000',
          cs_nok_minor: '3000000000',
          hs_nok_minor: '100000000',
          purchase_count: '18',
        }
        return respond(200, object ? row : [row])
      }
      case 'holding_summaries': {
        const id = url.searchParams.get('holding_id')?.replace('eq.', '')
        const holding = scenario.holdings.find((h) => h.id === id) ?? scenario.holdings[0]
        if (!holding) return respond(object ? 406 : 200, object ? { code: 'PGRST116' } : [])
        const row = { ...tileRow(holding), holding_id: holding.id }
        return respond(200, object ? row : [row])
      }
      case 'acquisition_lots': {
        const id = url.searchParams.get('holding_id')?.replace('eq.', '') ?? ''
        const holding = scenario.holdings.find((h) => h.id === id)
        return respond(200, lotRows(id, holding?.lotCount ?? 1))
      }
      case 'get_holding_value_provenance': {
        const id = typeof body?.p_holding_id === 'string' ? body.p_holding_id : ''
        const holding = scenario.holdings.find((h) => h.id === id) ?? scenario.holdings[0]
        const state = holding?.priceState ?? 'missing'
        const row = {
          price_state: state,
          unit_value_nok_minor: holding?.unitValue ?? null,
          quantity: String(holding?.quantity ?? 1),
          holding_value_nok_minor: holding?.holdingValue ?? null,
          provider: state === 'fresh' || state === 'stale' ? 'tcgdex_cardmarket' : null,
          price_kind: state === 'fresh' || state === 'stale' ? 'trend' : null,
          source_currency: state === 'fresh' || state === 'stale' ? 'EUR' : null,
          source_value_minor: state === 'fresh' || state === 'stale' ? '4250' : null,
          fx_rate: state === 'fresh' || state === 'stale' ? 11.4321 : null,
          snapshot_date: state === 'stale' ? '2026-09-02' : '2026-10-08',
          provider_updated_at:
            state === 'stale' ? '2026-09-02T04:00:00.000Z' : '2026-10-08T04:00:00.000Z',
        }
        return respond(200, object ? row : [row])
      }
      case 'manual_valuations':
        return respond(object ? 406 : 200, object ? { code: 'PGRST116', message: 'no rows' } : [])
      default:
        // Anything not modelled answers empty, exactly like the P202 generic backend.
        return object
          ? respond(406, { code: 'PGRST116', message: 'no rows', details: '', hint: null })
          : respond(200, [])
    }
  })
  return log
}
