import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'

/**
 * P199 - cross-surface financial reconciliation, seeded and deterministic.
 *
 * Every scenario drives the REAL write RPCs (create_purchase, create_sale, void_sale, void_purchase,
 * set_manual_valuation) with a seeded pseudo-random ledger in four currencies, then compares the
 * database's three read surfaces - the live `get_dashboard_summary`, the rebuilt historical
 * `portfolio_snapshots`, and the frozen ledger rows - against an INDEPENDENT oracle written here
 * straight from FINANCIAL_MODEL.md (bigint arithmetic, no import from src/ or SQL). The oracle
 * never reads a figure the system computed except the frozen facts the model says are frozen
 * (purchase/sale NOK amounts, lot basis, disposals).
 *
 * Properties asserted (FINANCIAL_MODEL.md section 12 numbering):
 *   F1  GPO = CS + HS                      F5  RRC + PUD = NSP - sum(cost_basis_at_sale)
 *   F14 a holding with no resolvable value is excluded from CMV and counted, never valued at 0
 *   F10 graded/sealed never valued from raw prices (covered by the unit-level suites; raw only here)
 *   conservation: every krone of a lot's basis is either still on the lot or frozen on a live sale
 *   DCB(D) of a snapshot = sum over lots open on D of (the lot cost - what live disposals up to D froze)
 *   CMV(D) of a snapshot = the section 6 resolution applied AS OF D (age measured from D)
 *   the live resolver and the snapshot of today agree with each other and with the oracle
 */

const SEEDS = Array.from({ length: 56 }, (_, i) => 1000 + i)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const todayDate = new Date()
function isoDaysAgo(n: number): string {
  const d = new Date(
    Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), todayDate.getUTCDate()),
  )
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
const TODAY = isoDaysAgo(0)
function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000)
}
function addDaysIso(iso: string, n: number): string {
  return new Date((dayNumber(iso) + n) * 86_400_000).toISOString().slice(0, 10)
}

let service: TestClient

beforeAll(() => {
  service = createServiceClient()
})

// -- global FX facts used by the market-value oracle ---------------------------------------------
// Norges Bank EUR/USD rates on dates unlikely to be used by another suite. Existing rows are kept.
const FX_DAYS_AGO = [131, 117, 103, 89, 75, 43, 29, 13, 5]
const insertedFx: { base: string; date: string }[] = []

beforeAll(async () => {
  const rows: Record<string, unknown>[] = []
  FX_DAYS_AGO.forEach((k, i) => {
    rows.push({
      base_currency: 'EUR',
      quote_currency: 'NOK',
      rate_date: isoDaysAgo(k),
      rate: (11 + i * 0.137).toFixed(8),
      source: 'norges_bank',
    })
    rows.push({
      base_currency: 'USD',
      quote_currency: 'NOK',
      rate_date: isoDaysAgo(k),
      rate: (9.5 + i * 0.211).toFixed(8),
      source: 'norges_bank',
    })
  })
  const existing = await service
    .from('fx_rates')
    .select('base_currency, rate_date')
    .eq('quote_currency', 'NOK')
    .eq('source', 'norges_bank')
    .in(
      'rate_date',
      FX_DAYS_AGO.map((k) => isoDaysAgo(k)),
    )
  const have = new Set(
    (existing.data ?? []).map((r) => `${String(r.base_currency)}|${String(r.rate_date)}`),
  )
  const fresh = rows.filter((r) => !have.has(`${String(r.base_currency)}|${String(r.rate_date)}`))
  if (fresh.length > 0) {
    const ins = await service.from('fx_rates').insert(fresh)
    if (ins.error) throw new Error(ins.error.message)
    fresh.forEach((r) =>
      insertedFx.push({ base: String(r.base_currency), date: String(r.rate_date) }),
    )
  }
})

afterAll(async () => {
  for (const f of insertedFx) {
    await service
      .from('fx_rates')
      .delete()
      .eq('base_currency', f.base)
      .eq('quote_currency', 'NOK')
      .eq('rate_date', f.date)
      .eq('source', 'norges_bank')
  }
})

// -- oracle ---------------------------------------------------------------------------------------
interface Lot {
  id: string
  holding_id: string
  acquired_on: string
  quantity: number
  quantity_remaining: number
  unit_cost_basis_nok_minor: number | null
  residual_nok_minor: number
  cost_basis_state: string
  voided_at: string | null
  purchase_line_id: string | null
}
interface Disposal {
  lot_id: string
  sale_line_id: string | null
  quantity: number
  disposed_on: string
  voided_at: string | null
}
interface Snap {
  provider: string
  variant: string
  date: string
  currency: string
  value: bigint
}
interface FxRow {
  base: string
  date: string
  rate: string
}

/** value * rate (a decimal string with <= 8 fraction digits), rounded half away from zero (non-negative). */
function convert(value: bigint, rate: string): bigint {
  const [whole = '0', frac = ''] = rate.split('.')
  const scaled = BigInt(whole + frac.padEnd(8, '0'))
  const num = value * scaled
  const den = 100_000_000n
  return (num + den / 2n) / den
}

function fxAsOf(fx: FxRow[], base: string, date: string): string | null {
  let best: FxRow | null = null
  for (const r of fx) {
    if (r.base !== base || r.date > date) continue
    if (best === null || r.date > best.date) best = r
  }
  return best ? best.rate : null
}

/** Section 6 / 6.4: the unit value of a variant AS OF day `asOf`, or null when missing. */
function providerUnitValue(
  snaps: Snap[],
  fx: FxRow[],
  variant: string,
  asOf: string,
  useEu: boolean,
): bigint | null {
  const pick = (provider: string): bigint | null => {
    let latest: Snap | null = null
    for (const s of snaps) {
      if (s.variant !== variant || s.provider !== provider || s.date > asOf) continue
      if (latest === null || s.date > latest.date) latest = s
    }
    if (latest === null) return null
    const age = dayNumber(asOf) - dayNumber(latest.date)
    if (age > 30) return null
    if (latest.currency === 'NOK') return latest.value
    const rate = fxAsOf(fx, latest.currency, latest.date)
    if (rate === null) return null
    return convert(latest.value, rate)
  }
  const cm = pick('tcgdex_cardmarket')
  const tp = pick('tcgdex_tcgplayer')
  return useEu ? (cm ?? tp) : (tp ?? cm)
}

interface Scenario {
  seed: number
  user: SyntheticUser
  client: TestClient
  variants: string[]
  cardId: string
  useEu: boolean
  snaps: Snap[]
  manuals: Manual[]
  log: string[]
}

/** One manual valuation history on a holding: v1 from e1, optionally atomically replaced by v2 from e2 > e1. */
interface Manual {
  holdingId: string
  e1: string
  v1: bigint
  e2: string | null
  v2: bigint | null
}

/** The active manual unit value on a day under the D-062 economic-interval model, or null. */
function manualAt(manuals: Manual[], holdingId: string, day: string): bigint | null {
  const m = manuals.find((x) => x.holdingId === holdingId)
  if (!m) return null
  if (m.e2 !== null && m.v2 !== null && day >= m.e2) return m.v2
  return day >= m.e1 ? m.v1 : null
}

async function must<T>(
  label: string,
  p: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(`${label}: ${error.message}`)
  return data as T
}

async function buildScenario(seed: number): Promise<Scenario> {
  const rng = mulberry32(seed)
  const ri = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
  const user = await createSyntheticUser(service, `p199-recon-${String(seed)}`)
  const client = await signInAs(user)
  const log: string[] = []

  const card = await must(
    'card',
    service
      .from('cards')
      .insert({
        set_id: seedCatalog.cardSetId,
        local_id: `p199-recon-${String(seed)}`,
        name: `P199 reconciliation fixture ${String(seed)}`,
        language: 'en',
      })
      .select('id')
      .single<{ id: string }>(),
  )
  const roles = ['a', 'b', 'c', 'd']
  const variantRows = await must(
    'variants',
    service
      .from('card_variants')
      .insert(
        roles.map((r) => ({
          card_id: card.id,
          finish: 'normal',
          stamp: '',
          subtype: `p199-${r}`,
          size: 'standard',
        })),
      )
      .select('id'),
  )
  const variants = (variantRows as { id: string }[]).map((v) => v.id)

  const useEu = rng() < 0.6
  await must(
    'profile',
    service.from('profiles').update({ use_eu_pricing: useEu }).eq('id', user.id).select('id'),
  )

  // provider observations on private variants
  const snaps: Snap[] = []
  for (const v of variants) {
    for (const provider of ['tcgdex_cardmarket', 'tcgdex_tcgplayer'] as const) {
      const n = ri(0, 3)
      const days = new Set<number>()
      while (days.size < n) days.add(ri(0, 75))
      for (const d of days) {
        snaps.push({
          provider,
          variant: v,
          date: isoDaysAgo(d),
          currency: provider === 'tcgdex_cardmarket' ? 'EUR' : 'USD',
          value: rng() < 0.1 ? 0n : BigInt(ri(1, 40_000)),
        })
      }
    }
  }
  if (snaps.length > 0) {
    await must(
      'snapshots',
      service
        .from('price_snapshots')
        .insert(
          snaps.map((s) => ({
            card_variant_id: s.variant,
            provider: s.provider,
            price_kind: s.provider === 'tcgdex_cardmarket' ? 'cm_trend' : 'tp_market',
            source_currency: s.currency,
            value_minor: Number(s.value),
            snapshot_date: s.date,
          })),
        )
        .select('id'),
    )
  }

  // ledger operations
  const rates: Record<string, [number, number]> = {
    EUR: [10.5, 12.5],
    USD: [9, 11.5],
    JPY: [0.05, 0.08],
  }
  const opCount = ri(4, 9)
  for (let i = 0; i < opCount; i += 1) {
    // P209 (E): about one operation in ten is a gift - a lot whose cost is NOT KNOWN (never zero).
    if (rng() < 0.1) {
      const asGraded = rng() < 0.4
      const gift = await client
        .rpc('add_card_acquisition', {
          p_card_variant_id: variants[ri(0, 3)],
          ...(asGraded ? {} : { p_condition: 'NM' }),
          ...(asGraded ? { p_grading_state: 'graded', p_grader: 'psa', p_grade: ri(6, 10) } : {}),
          p_origin: 'gift',
          p_cost_basis_state: 'not_paid',
          p_quantity: ri(1, 3),
          p_acquired_on: isoDaysAgo(ri(0, 50)),
        })
        .single<{ holding_id: string }>()
      log.push(
        `gift ${asGraded ? 'graded ' : ''}${gift.error ? 'ERR ' + gift.error.message : 'ok'}`,
      )
      if (gift.error) throw new Error(`add_card_acquisition: ${gift.error.message}`)
      continue
    }
    const roll = rng()
    const lots = await must(
      'lots',
      service
        .from('acquisition_lots')
        .select('id, acquired_on, quantity_remaining, voided_at')
        .eq('user_id', user.id)
        .is('voided_at', null)
        .gt('quantity_remaining', 0),
    )
    const liveLots = lots as { id: string; acquired_on: string; quantity_remaining: number }[]
    if (roll < 0.4 || liveLots.length === 0) {
      const currency = (['NOK', 'NOK', 'EUR', 'USD', 'JPY'] as const)[ri(0, 4)]!
      const date = isoDaysAgo(ri(0, 60))
      const lineCount = ri(1, 3)
      // P209 (E): graded copies reuse the SAME variants that carry provider prices (the negative
      // control: a graded copy must never inherit the raw price), and sealed products have no
      // provider price at all. Both are valued by a manual valuation or not at all.
      const lines = Array.from({ length: lineCount }, () => {
        const kindRoll = rng()
        const unit = currency === 'JPY' ? ri(1, 90_000) : ri(1, 60_000)
        if (kindRoll < 0.25) {
          return {
            line_type: 'card',
            card_variant_id: variants[ri(0, 3)],
            condition: 'NM',
            grading_state: 'graded',
            grader: 'psa',
            grade: ri(6, 10),
            quantity: ri(1, 3),
            unit_price_minor: unit,
          }
        }
        if (kindRoll < 0.4) {
          return {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: ri(1, 4),
            unit_price_minor: unit,
          }
        }
        return {
          line_type: 'card',
          card_variant_id: variants[ri(0, 3)],
          condition: 'NM',
          quantity: ri(1, 5),
          unit_price_minor: unit,
        }
      })
      const subtotal = lines.reduce((s, l) => s + l.quantity * l.unit_price_minor, 0)
      const shipping = rng() < 0.6 ? ri(0, 3000) : 0
      const customs = rng() < 0.2 ? ri(0, 1500) : 0
      const discount = rng() < 0.3 ? ri(0, Math.min(subtotal, 5000)) : 0
      const args: Record<string, unknown> = {
        p_purchased_on: date,
        p_currency: currency,
        p_lines: lines,
        p_shipping_minor: shipping,
        p_customs_minor: customs,
        p_discount_minor: discount,
      }
      if (currency !== 'NOK') {
        const [lo, hi] = rates[currency]!
        args.p_fx_rate_to_nok = (lo + rng() * (hi - lo)).toFixed(8)
        args.p_fx_rate_date = date
        args.p_fx_source = 'manual'
      }
      const r = await client.rpc('create_purchase', args)
      log.push(`buy ${currency} ${date} ${r.error ? 'ERR ' + r.error.message : 'ok'}`)
      if (r.error)
        throw new Error(`create_purchase failed: ${r.error.message} ${JSON.stringify(args)}`)
    } else if (roll < 0.62) {
      const nLines = Math.min(ri(1, 2), liveLots.length)
      const picked = [...liveLots].sort(() => rng() - 0.5).slice(0, nLines)
      const earliest = picked
        .map((l) => l.acquired_on)
        .sort()
        .pop()!
      const span = dayNumber(TODAY) - dayNumber(earliest)
      const soldOn = addDaysIso(earliest, ri(0, span))
      const currency = (['NOK', 'EUR', 'USD'] as const)[ri(0, 2)]!
      const args: Record<string, unknown> = {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: soldOn,
        p_currency: currency,
        p_fees_minor: rng() < 0.7 ? ri(0, 4000) : 0,
        p_shipping_cost_minor: rng() < 0.5 ? ri(0, 2500) : 0,
        p_shipping_charged_minor: rng() < 0.4 ? ri(0, 2500) : 0,
        p_lines: picked.map((l) => ({
          lot_id: l.id,
          quantity: ri(1, l.quantity_remaining),
          unit_gross_minor: ri(0, 70_000),
        })),
      }
      if (currency !== 'NOK') {
        const [lo, hi] = rates[currency]!
        args.p_fx_rate_to_nok = (lo + rng() * (hi - lo)).toFixed(8)
        args.p_fx_rate_date = soldOn
        args.p_fx_source = 'manual'
      }
      const r = await client.rpc('create_sale', args)
      log.push(`sell ${currency} ${soldOn} ${r.error ? 'ERR ' + r.error.message : 'ok'}`)
      if (r.error) throw new Error(`create_sale failed: ${r.error.message} ${JSON.stringify(args)}`)
    } else if (roll < 0.72) {
      const sales = await must(
        'sales',
        service.from('sales').select('id').eq('user_id', user.id).is('voided_at', null),
      )
      const list = sales as { id: string }[]
      if (list.length > 0) {
        const s = list[ri(0, list.length - 1)]!
        // Any live sale may be voided, in any order (D-209: the residual is carried by exactly one
        // live disposal, so an out-of-order void conserves cost).
        const r = await client.rpc('void_sale', { p_sale_id: s.id, p_reason: 'p199' })
        log.push(`void_sale ${r.error ? 'ERR ' + r.error.message : 'ok'}`)
      }
    } else if (roll < 0.78) {
      const purchases = await must(
        'purchases',
        service.from('purchases').select('id').eq('user_id', user.id).is('voided_at', null),
      )
      const list = purchases as { id: string }[]
      if (list.length > 0) {
        const p = list[ri(0, list.length - 1)]!
        const r = await client.rpc('void_purchase', { p_purchase_id: p.id, p_reason: 'p199' })
        log.push(`void_purchase ${r.error ? 'ERR(expected if sold) ' + r.error.message : 'ok'}`)
      }
    } else if (roll < 0.9) {
      const purchases = await must(
        'purchases',
        service.from('purchases').select('id').eq('user_id', user.id).is('voided_at', null),
      )
      const list = purchases as { id: string }[]
      if (list.length > 0) {
        const p = list[ri(0, list.length - 1)]!
        const lines = (await must(
          'pl',
          service.from('purchase_lines').select('id').eq('purchase_id', p.id),
        )) as { id: string }[]
        const lotsOf = (await must(
          'lotsOf',
          service
            .from('acquisition_lots')
            .select('id, quantity, quantity_remaining, voided_at')
            .in(
              'purchase_line_id',
              lines.map((l) => l.id),
            ),
        )) as { quantity: number; quantity_remaining: number; voided_at: string | null }[]
        const untouched =
          lotsOf.length > 0 &&
          lotsOf.every((l) => l.voided_at === null && l.quantity_remaining === l.quantity)
        if (untouched) {
          const currency = (['NOK', 'NOK', 'EUR', 'USD', 'JPY'] as const)[ri(0, 4)]!
          const date = isoDaysAgo(ri(0, 60))
          const newLines = lines.map((l) => ({
            line_id: l.id,
            quantity: ri(1, 5),
            unit_price_minor: currency === 'JPY' ? ri(1, 90_000) : ri(1, 60_000),
          }))
          const subtotal = newLines.reduce((a, l) => a + l.quantity * l.unit_price_minor, 0)
          const args: Record<string, unknown> = {
            p_purchase_id: p.id,
            p_purchased_on: date,
            p_currency: currency,
            p_lines: newLines,
            p_shipping_minor: rng() < 0.6 ? ri(0, 3000) : 0,
            p_customs_minor: rng() < 0.2 ? ri(0, 1500) : 0,
            p_discount_minor: rng() < 0.3 ? ri(0, Math.min(subtotal, 5000)) : 0,
          }
          if (currency !== 'NOK') {
            const [lo, hi] = rates[currency]!
            args.p_fx_rate_to_nok = (lo + rng() * (hi - lo)).toFixed(8)
            args.p_fx_rate_date = date
            args.p_fx_source = 'manual'
          }
          const r = await client.rpc('update_purchase', args)
          log.push(`update_purchase ${currency} ${r.error ? 'ERR ' + r.error.message : 'ok'}`)
        }
      }
    } else {
      const sales = (await must(
        'sales',
        service.from('sales').select('id').eq('user_id', user.id).is('voided_at', null),
      )) as { id: string }[]
      if (sales.length > 0) {
        const sale = sales[ri(0, sales.length - 1)]!
        const sl = (await must(
          'sl',
          service.from('sale_lines').select('id, lot_id').eq('sale_id', sale.id),
        )) as { id: string; lot_id: string }[]
        const lotRows = (await must(
          'slots',
          service
            .from('acquisition_lots')
            .select('acquired_on')
            .in(
              'id',
              sl.map((x) => x.lot_id),
            ),
        )) as { acquired_on: string }[]
        const earliest = lotRows
          .map((l) => l.acquired_on)
          .sort()
          .pop()!
        const soldOn = addDaysIso(earliest, ri(0, dayNumber(TODAY) - dayNumber(earliest)))
        const currency = (['NOK', 'EUR', 'USD'] as const)[ri(0, 2)]!
        const args: Record<string, unknown> = {
          p_sale_id: sale.id,
          p_sold_on: soldOn,
          p_currency: currency,
          p_fees_minor: rng() < 0.7 ? ri(0, 4000) : 0,
          p_shipping_cost_minor: rng() < 0.5 ? ri(0, 2500) : 0,
          p_shipping_charged_minor: rng() < 0.4 ? ri(0, 2500) : 0,
          p_lines: sl.map((x) => ({ line_id: x.id, unit_gross_minor: ri(0, 70_000) })),
        }
        if (currency !== 'NOK') {
          const [lo, hi] = rates[currency]!
          args.p_fx_rate_to_nok = (lo + rng() * (hi - lo)).toFixed(8)
          args.p_fx_rate_date = soldOn
          args.p_fx_source = 'manual'
        }
        const r = await client.rpc('update_sale', args)
        log.push(`update_sale ${currency} ${r.error ? 'ERR ' + r.error.message : 'ok'}`)
      }
    }
  }

  // manual valuations: a first value from e1, sometimes atomically replaced by a second from e2 > e1
  const manuals: Manual[] = []
  if (rng() < 0.6) {
    const held = await must(
      'holdings',
      service.from('holdings').select('id').eq('user_id', user.id).is('deleted_at', null),
    )
    for (const h of (held as { id: string }[]).slice(0, 2)) {
      const e1Back = ri(10, 40)
      const m: Manual = {
        holdingId: h.id,
        e1: isoDaysAgo(e1Back),
        v1: BigInt(ri(0, 90_000)),
        e2: null,
        v2: null,
      }
      const first = await client.rpc('set_manual_valuation', {
        p_holding_id: h.id,
        p_value_minor: Number(m.v1),
        p_effective_from: m.e1,
      })
      if (first.error) throw new Error(`set_manual_valuation: ${first.error.message}`)
      if (rng() < 0.5) {
        m.e2 = isoDaysAgo(ri(0, e1Back - 1))
        m.v2 = BigInt(ri(0, 90_000))
        const second = await client.rpc('set_manual_valuation', {
          p_holding_id: h.id,
          p_value_minor: Number(m.v2),
          p_effective_from: m.e2,
        })
        if (second.error) throw new Error(`set_manual_valuation 2: ${second.error.message}`)
      }
      manuals.push(m)
    }
  }

  return { seed, user, client, variants, cardId: card.id, useEu, snaps, manuals, log }
}

async function dispose(sc: Scenario): Promise<void> {
  await deleteSyntheticUser(service, sc.user.id)
  await service.from('price_snapshots').delete().in('card_variant_id', sc.variants)
  await service.from('card_variants').delete().eq('card_id', sc.cardId)
  await service.from('cards').delete().eq('id', sc.cardId)
}

/** Guards against a vacuous oracle: the seeded scenarios must actually exercise every dimension. */
const coverage = {
  scenarios: 0,
  manualHoldings: 0,
  replacedManuals: 0,
  liveSales: 0,
  foreignPurchases: 0,
  jpyPurchases: 0,
  pricedHoldings: 0,
  unpricedHoldings: 0,
  zeroValuedSnapshots: 0,
  partlySoldLots: 0,
  residualLots: 0,
  editedPurchases: 0,
  editedSales: 0,
  voidedSales: 0,
  gradedHoldings: 0,
  sealedHoldings: 0,
  nonRawWithoutValue: 0,
  gradedWithRawPriceButNoValue: 0,
}

describe('P199 deterministic cross-surface reconciliation', () => {
  for (const seed of SEEDS) {
    it(`seed ${String(seed)}: dashboard, snapshots and frozen ledger agree with the oracle`, async () => {
      const sc = await buildScenario(seed)
      const problems: string[] = []
      try {
        const uid = sc.user.id
        const [lotsR, dispR, purchR, plR, salesR, slR, holdR, fxR] = await Promise.all([
          service.from('acquisition_lots').select('*').eq('user_id', uid),
          service
            .from('lot_disposals')
            .select('lot_id, quantity, disposed_on, voided_at, sale_line_id')
            .eq('user_id', uid),
          service.from('purchases').select('*').eq('user_id', uid),
          service.from('purchase_lines').select('*').eq('user_id', uid),
          service.from('sales').select('*').eq('user_id', uid),
          service.from('sale_lines').select('*').eq('user_id', uid),
          service
            .from('holdings')
            .select('id, card_variant_id, holding_kind, deleted_at')
            .eq('user_id', uid),
          service
            .from('fx_rates')
            .select('base_currency, rate_date, rate')
            .eq('quote_currency', 'NOK')
            .eq('source', 'norges_bank'),
        ])
        const lots = (lotsR.data ?? []) as unknown as Lot[]
        const disposals = (dispR.data ?? []) as unknown as Disposal[]
        const purchases = (purchR.data ?? []) as Record<string, unknown>[]
        const pLines = (plR.data ?? []) as Record<string, unknown>[]
        const sales = (salesR.data ?? []) as Record<string, unknown>[]
        const sLines = (slR.data ?? []) as Record<string, unknown>[]
        const holdings = (holdR.data ?? []) as { id: string; card_variant_id: string }[]
        const fx: FxRow[] = (
          (fxR.data ?? []) as { base_currency: string; rate_date: string; rate: string | number }[]
        ).map((r) => ({ base: r.base_currency, date: r.rate_date, rate: String(r.rate) }))

        const livePurchases = purchases.filter((p) => p.voided_at === null)
        const livePurchaseIds = new Set(livePurchases.map((p) => String(p.id)))
        const liveSales = sales.filter((s) => s.voided_at === null)
        const liveSaleIds = new Set(liveSales.map((s) => String(s.id)))
        const liveSaleLines = sLines.filter((l) => liveSaleIds.has(String(l.sale_id)))
        const liveLines = pLines.filter((l) => livePurchaseIds.has(String(l.purchase_id)))
        const big = (v: unknown) => BigInt(String(v))

        // ---- frozen-ledger oracle -------------------------------------------------------------
        const gpo = livePurchases.reduce((s, p) => s + big(p.total_nok_minor), 0n)
        const cs = liveLines
          .filter((l) => l.spend_class === 'collectible')
          .reduce((s, l) => s + big(l.attributable_cost_nok_minor), 0n)
        const hs = liveLines
          .filter((l) => l.spend_class === 'hobby')
          .reduce((s, l) => s + big(l.attributable_cost_nok_minor), 0n)
        const nsp = liveSales.reduce((s, x) => s + big(x.net_proceeds_nok_minor), 0n)
        const rrc = liveSaleLines
          .filter((l) => l.cost_basis_at_sale_nok_minor !== null)
          .reduce((s, l) => s + big(l.realized_result_nok_minor), 0n)
        const pud = liveSaleLines
          .filter((l) => l.cost_basis_at_sale_nok_minor === null)
          .reduce((s, l) => s + big(l.net_proceeds_nok_minor), 0n)
        const soldBasis = liveSaleLines
          .filter((l) => l.cost_basis_at_sale_nok_minor !== null)
          .reduce((s, l) => s + big(l.cost_basis_at_sale_nok_minor), 0n)

        if (gpo !== cs + hs) problems.push(`F1: gpo ${gpo} != cs ${cs} + hs ${hs}`)
        if (rrc + pud !== nsp - soldBasis)
          problems.push(`F5: rrc ${rrc} + pud ${pud} != nsp ${nsp} - basis ${soldBasis}`)

        // conservation per live lot: total basis = remaining + frozen on live sales
        const liveLotList = lots.filter((l) => l.voided_at === null)
        const lotLines = new Map<string, bigint>()
        for (const l of liveLines) lotLines.set(String(l.id), big(l.attributable_cost_nok_minor))
        for (const lot of liveLotList) {
          if (lot.cost_basis_state !== 'known' || lot.unit_cost_basis_nok_minor === null) continue
          const total =
            BigInt(lot.quantity) * BigInt(lot.unit_cost_basis_nok_minor) +
            BigInt(lot.residual_nok_minor)
          const frozen = liveSaleLines
            .filter((l) => String(l.lot_id) === lot.id)
            .reduce((s, l) => s + big(l.cost_basis_at_sale_nok_minor), 0n)
          // What is still on the lot is whatever the frozen sales did not take. A sold-out lot must
          // be fully frozen; a lot with units left holds at least their unit cost and at most that
          // plus its residual (the residual is on the lot or on exactly one live sale).
          const left = total - frozen
          const units = BigInt(lot.quantity_remaining) * BigInt(lot.unit_cost_basis_nok_minor)
          if (
            lot.quantity_remaining === 0
              ? left !== 0n
              : left < units || left > units + BigInt(lot.residual_nok_minor)
          ) {
            problems.push(
              `conservation lot ${lot.id}: total ${total} frozen ${frozen} left ${left} units ${units} residual ${lot.residual_nok_minor}`,
            )
          }
          const line = lot.purchase_line_id ? lotLines.get(lot.purchase_line_id) : undefined
          if (line !== undefined && line !== total) {
            problems.push(
              `lot ${lot.id}: lot basis total ${total} != purchase line attributable ${line}`,
            )
          }
        }

        // ---- live dashboard ------------------------------------------------------------------
        const dash = await sc.client
          .rpc('get_dashboard_summary')
          .single<Record<string, string | boolean | null>>()
        if (dash.error) throw new Error(dash.error.message)
        const d = dash.data
        const expectEq = (label: string, got: unknown, want: bigint | number | string) => {
          if (String(got) !== String(want))
            problems.push(`dashboard ${label}: got ${String(got)} want ${String(want)}`)
        }
        expectEq('gpo', d.gpo_nok_minor, gpo)
        expectEq('cs', d.cs_nok_minor, cs)
        expectEq('hs', d.hs_nok_minor, hs)
        expectEq('nsp', d.nsp_nok_minor, nsp)
        expectEq('rrc', d.rrc_nok_minor, rrc)
        expectEq('pud', d.pud_nok_minor, pud)

        const holdingVariant = new Map(holdings.map((h) => [h.id, h.card_variant_id]))
        const holdingKind = new Map(holdings.map((h) => [h.id, h.holding_kind]))
        /** F10: provider prices only ever value raw cards; graded and sealed are manual-or-missing. */
        const unitValue = (holdingId: string, day: string): bigint | null =>
          manualAt(sc.manuals, holdingId, day) ??
          (holdingKind.get(holdingId) === 'raw_card'
            ? providerUnitValue(sc.snaps, fx, holdingVariant.get(holdingId)!, day, sc.useEu)
            : null)
        const openByHolding = new Map<string, number>()
        for (const lot of liveLotList) {
          if (lot.quantity_remaining > 0) {
            openByHolding.set(
              lot.holding_id,
              (openByHolding.get(lot.holding_id) ?? 0) + lot.quantity_remaining,
            )
          }
        }
        let rawValue = 0n
        let gradedValue = 0n
        let sealedValue = 0n
        let priced = 0
        let unpriced = 0
        let cards = 0
        let manualValued = 0
        for (const [hid, qty] of openByHolding) {
          cards += qty
          const unit = unitValue(hid, TODAY)
          if (manualAt(sc.manuals, hid, TODAY) !== null) manualValued += 1
          if (unit === null) unpriced += 1
          else {
            priced += 1
            const kind = holdingKind.get(hid)
            if (kind === 'graded_card') gradedValue += unit * BigInt(qty)
            else if (kind === 'sealed') sealedValue += unit * BigInt(qty)
            else rawValue += unit * BigInt(qty)
          }
          const kind = holdingKind.get(hid)
          if (kind === 'graded_card') coverage.gradedHoldings += 1
          if (kind === 'sealed') coverage.sealedHoldings += 1
          if (kind !== 'raw_card' && unit === null) {
            coverage.nonRawWithoutValue += 1
            // negative control: the variant has a raw price, the graded copy still has no value
            const rawPrice =
              kind === 'graded_card'
                ? providerUnitValue(sc.snaps, fx, holdingVariant.get(hid)!, TODAY, sc.useEu)
                : null
            if (rawPrice !== null) coverage.gradedWithRawPriceButNoValue += 1
          }
        }
        expectEq('raw_value', d.raw_value_nok_minor, rawValue)
        expectEq('graded_value', d.graded_value_nok_minor, gradedValue)
        expectEq('sealed_value', d.sealed_value_nok_minor, sealedValue)
        expectEq('priced', d.priced_holding_count, priced)
        expectEq('unpriced', d.unpriced_holding_count, unpriced)
        expectEq('physical_card_count', d.physical_card_count, cards)
        coverage.scenarios += 1
        coverage.manualHoldings += sc.manuals.length
        coverage.replacedManuals += sc.manuals.filter((m) => m.e2 !== null).length
        coverage.liveSales += liveSales.length
        coverage.foreignPurchases += livePurchases.filter((x) => x.currency !== 'NOK').length
        coverage.jpyPurchases += livePurchases.filter((x) => x.currency === 'JPY').length
        coverage.pricedHoldings += priced
        coverage.unpricedHoldings += unpriced
        coverage.zeroValuedSnapshots += sc.snaps.filter((x) => x.value === 0n).length
        coverage.partlySoldLots += liveLotList.filter(
          (l) => l.quantity_remaining > 0 && l.quantity_remaining < l.quantity,
        ).length
        coverage.editedPurchases += sc.log.filter((l) =>
          /^update_purchase [A-Z]+ ok$/.test(l),
        ).length
        coverage.editedSales += sc.log.filter((l) => /^update_sale [A-Z]+ ok$/.test(l)).length
        coverage.voidedSales += sc.log.filter((l) => l === 'void_sale ok').length
        coverage.residualLots += liveLotList.filter((l) => l.residual_nok_minor > 0).length
        expectEq('manual_valued', d.manual_valued_holding_count, manualValued)
        expectEq('auto_priced', d.auto_priced_holding_count, priced - manualValued)

        // ---- historical snapshots ----------------------------------------------------------------
        const dates = [
          ...livePurchases.map((p) => String(p.purchased_on)),
          ...liveSales.map((s) => String(s.sold_on)),
          ...liveLotList.map((l) => l.acquired_on),
        ].sort()
        if (dates.length > 0) {
          const first = dates[0]!
          const rb = await service.rpc('rebuild_portfolio_snapshots', {
            p_user_id: uid,
            p_from: first,
            p_through: TODAY,
          })
          if (rb.error) throw new Error(`rebuild: ${rb.error.message}`)
          const snapR = await service
            .from('portfolio_snapshots')
            .select('*')
            .eq('user_id', uid)
            .order('snapshot_date')
          const snapRows = (snapR.data ?? []) as Record<string, unknown>[]
          const expectedDays = dayNumber(TODAY) - dayNumber(first) + 1
          if (snapRows.length !== expectedDays)
            problems.push(`snapshot rows ${snapRows.length} != ${expectedDays}`)
          for (const row of snapRows) {
            const day = String(row.snapshot_date)
            let mv = 0n
            let acmv = 0n
            let dcb = 0n
            let open = 0
            let unvalued = 0
            for (const lot of liveLotList) {
              if (lot.acquired_on > day) continue
              const sold = disposals
                .filter((x) => x.lot_id === lot.id && x.voided_at === null && x.disposed_on <= day)
                .reduce((s, x) => s + x.quantity, 0)
              const qtyOpen = lot.quantity - sold
              if (qtyOpen <= 0) {
                // Sold out on this day: live disposals up to the day must have frozen the whole lot.
                if (lot.cost_basis_state === 'known' && lot.unit_cost_basis_nok_minor !== null) {
                  const lotTotal =
                    BigInt(lot.quantity) * BigInt(lot.unit_cost_basis_nok_minor) +
                    BigInt(lot.residual_nok_minor)
                  const frozen = disposals
                    .filter(
                      (x) => x.lot_id === lot.id && x.voided_at === null && x.disposed_on <= day,
                    )
                    .reduce((acc, x) => {
                      const line = liveSaleLines.find((l) => String(l.id) === x.sale_line_id)
                      return acc + (line ? big(line.cost_basis_at_sale_nok_minor) : 0n)
                    }, 0n)
                  if (frozen !== lotTotal)
                    problems.push(
                      `${day}: lot ${lot.id} sold out, frozen ${frozen} != cost ${lotTotal}`,
                    )
                }
                continue
              }
              open += 1
              const unit = unitValue(lot.holding_id, day)
              if (unit === null) unvalued += 1
              else {
                mv += unit * BigInt(qtyOpen)
                if (lot.cost_basis_state === 'known') acmv += unit * BigInt(qtyOpen)
              }
              if (lot.cost_basis_state === 'known' && lot.unit_cost_basis_nok_minor !== null) {
                // F17 as of the day: what the lot cost minus what live disposals up to the day froze.
                const lotTotal =
                  BigInt(lot.quantity) * BigInt(lot.unit_cost_basis_nok_minor) +
                  BigInt(lot.residual_nok_minor)
                const frozenToDay = disposals
                  .filter(
                    (x) => x.lot_id === lot.id && x.voided_at === null && x.disposed_on <= day,
                  )
                  .reduce((acc, x) => {
                    const line = liveSaleLines.find((l) => String(l.id) === x.sale_line_id)
                    return acc + (line ? big(line.cost_basis_at_sale_nok_minor) : 0n)
                  }, 0n)
                dcb += lotTotal - frozenToDay
              }
            }
            const csD = liveLines
              .filter(
                (l) =>
                  l.spend_class === 'collectible' &&
                  String(purchases.find((p) => p.id === l.purchase_id)?.purchased_on) <= day,
              )
              .reduce((s, l) => s + big(l.attributable_cost_nok_minor), 0n)
            const nspD = liveSales
              .filter((s) => String(s.sold_on) <= day)
              .reduce((s, x) => s + big(x.net_proceeds_nok_minor), 0n)
            const cmp = (label: string, got: unknown, want: bigint | number) => {
              if (String(got) !== String(want))
                problems.push(`snapshot ${day} ${label}: got ${String(got)} want ${String(want)}`)
            }
            cmp('market_value', row.market_value_nok_minor, mv)
            cmp('attributed_value', row.attributed_value_nok_minor, acmv)
            cmp('cost_basis', row.cost_basis_nok_minor, dcb)
            cmp('cs_to_date', row.collectible_spend_to_date_nok_minor, csD)
            cmp('nsp_to_date', row.sales_proceeds_to_date_nok_minor, nspD)
            cmp('open_lots', row.open_lot_count, open)
            cmp('unvalued_lots', row.unvalued_lot_count, unvalued)
            if (day === TODAY) {
              // live resolver and today's snapshot are two implementations of the same section 6 rule
              if (
                String(row.market_value_nok_minor) !== String(rawValue + gradedValue + sealedValue)
              ) {
                problems.push(
                  `today: snapshot market value ${String(row.market_value_nok_minor)} != live total value ${rawValue + gradedValue + sealedValue}`,
                )
              }
            }
          }
        }
      } finally {
        await dispose(sc)
      }
      expect(problems, `seed ${String(seed)} log: ${sc.log.join(' | ')}`).toEqual([])
    }, 120_000)
  }

  it('the seeded scenarios exercised every dimension the oracle claims to cover', () => {
    expect(coverage.scenarios).toBe(SEEDS.length)
    expect(coverage.manualHoldings).toBeGreaterThanOrEqual(5)
    expect(coverage.replacedManuals).toBeGreaterThanOrEqual(2)
    expect(coverage.liveSales).toBeGreaterThanOrEqual(10)
    expect(coverage.foreignPurchases).toBeGreaterThanOrEqual(10)
    expect(coverage.jpyPurchases).toBeGreaterThanOrEqual(3)
    expect(coverage.pricedHoldings).toBeGreaterThanOrEqual(15)
    expect(coverage.unpricedHoldings).toBeGreaterThanOrEqual(5)
    expect(coverage.zeroValuedSnapshots).toBeGreaterThanOrEqual(1)
    expect(coverage.partlySoldLots).toBeGreaterThanOrEqual(3)
    expect(coverage.residualLots).toBeGreaterThanOrEqual(10)
    expect(coverage.editedPurchases).toBeGreaterThanOrEqual(8)
    expect(coverage.editedSales).toBeGreaterThanOrEqual(5)
    expect(coverage.voidedSales).toBeGreaterThanOrEqual(2)
    expect(coverage.gradedHoldings).toBeGreaterThanOrEqual(6)
    expect(coverage.sealedHoldings).toBeGreaterThanOrEqual(4)
    expect(coverage.nonRawWithoutValue).toBeGreaterThanOrEqual(3)
    expect(coverage.gradedWithRawPriceButNoValue).toBeGreaterThanOrEqual(1)
  })
})
