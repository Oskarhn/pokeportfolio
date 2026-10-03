import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { createAppSupabaseClient } from '../../src/data/supabase-factory'
import type { LeasedDb } from '../../src/data/leased-client'
import { leasedHarness } from './leased'

/**
 * P146 / P130-19 — the real data layer against the real stack, with money that does not fit in a
 * JavaScript number.
 *
 * JS client (src/data/*.ts, the SAME code the app runs)
 *   -> supabase-js -> PostgREST -> PostgreSQL -> PostgREST -> supabase-js -> JS
 *
 * Every assertion compares an exact `bigint` produced by the application with the exact `bigint`
 * the ledger arithmetic implies, using values above 2^53 (where a double silently changes the
 * number) and — because the P144 work made several results signed — well below -2^53 as well.
 * The only test doubles are the Supabase client handle (a signed-in client for a synthetic user)
 * and nothing else: no mocked responses, no stubbed RPCs.
 */

const transport = vi.hoisted(() => ({ client: null as unknown as object }))
vi.mock('../../src/data/supabase-client', () => ({
  supabase: new Proxy(
    {},
    {
      get(_target, property) {
        const target = transport.client as Record<PropertyKey, unknown>
        const value = target[property]
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value
      },
    },
  ),
}))

import {
  createPurchase,
  getPurchase,
  getSpendingSummary,
  listPurchases,
  updatePurchase,
} from '../../src/data/purchases'
import { createSale, getSale, getSalesSummary, updateSale } from '../../src/data/sales'
import {
  addCardAcquisition,
  getActiveManualValuation,
  getHoldingLots,
  getHoldingValueProvenance,
  setManualValuation,
} from '../../src/data/collection'
import { getMyProfile, updateMyProfile } from '../../src/data/profile'
import { getPortfolioCounts, listPortfolio } from '../../src/data/portfolio'
import { getDashboardSummary, getMonthlySpend, getRecentActivity } from '../../src/data/dashboard'
import { listHistoryEvents } from '../../src/data/history'
import { createProvisionalOpening, getOpening } from '../../src/data/opening'
import { normalizeDecimalText } from '../../src/data/money'
import { convert } from '../../src/domain/fx'
import { fromMinorUnits } from '../../src/domain/money'

const SAFE = BigInt(Number.MAX_SAFE_INTEGER) // 2^53 - 1
const A = SAFE + 2n // 2^53 + 1 — the first integer a double cannot hold
const B = 2n ** 58n + 3n // the 2^58 scale P144 saw drift by 2 minor units
const C = 2n ** 57n + 1n

const today = new Date().toISOString().slice(0, 10)

let service: TestClient
const users: SyntheticUser[] = []

/** Every unsafe integer the transport guard had to quote in a response. The contract is that no
 *  data path needs the net (money is text on the wire), so this must stay empty. */
const rewrites: string[] = []

/** The PRODUCTION leased client of the current synthetic user (identity lease + exact-transport
 *  guard on one client, P147). Every write below goes through it, as it does in the app. */
let db: LeasedDb

afterEach(() => {
  expect(rewrites, 'a response carried a JSON integer a double cannot hold').toEqual([])
})

/** A fresh synthetic user with its own signed-in client, installed as the app's `supabase`. */
async function freshUser(label: string): Promise<SyntheticUser> {
  const user = await createSyntheticUser(service, `p146-${label}`)
  users.push(user)
  // The client the APP builds (guarded fetch included), signed in as the synthetic user.
  const client = createAppSupabaseClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_ANON_KEY as string,
    { onResponseRewrite: (literals) => rewrites.push(...literals) },
  )
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  })
  if (error) throw new Error(error.message)
  transport.client = client
  db = leasedHarness(client, user.id, {
    onResponseRewrite: (literals) => rewrites.push(...literals),
  }).db
  return user
}

beforeAll(() => {
  service = createServiceClient()
})

afterAll(async () => {
  for (const user of users) await deleteSyntheticUser(service, user.id)
})

async function storedText(table: string, column: string, id: string): Promise<string> {
  const { data, error } = await service.from(table).select(`${column}::text`).eq('id', id).single()
  if (error) throw new Error(error.message)
  return (data as unknown as Record<string, string>)[column] as string
}

function accessory(unitPriceMinor: bigint, quantity = 1) {
  return {
    lineType: 'accessory' as const,
    description: 'p146 accessory',
    quantity,
    unitPriceMinor,
  }
}

async function cardLot(unitPriceMinor: bigint, variantId: string): Promise<string> {
  const purchase = await createPurchase(
    {
      purchasedOn: today,
      currency: 'NOK',
      lines: [
        {
          lineType: 'card' as const,
          cardVariantId: variantId,
          condition: 'NM',
          quantity: 1,
          unitPriceMinor,
        },
      ],
    },
    crypto.randomUUID(),
    db,
  )
  const { data: line } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  const { data: lot, error } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', (line as { id: string }).id)
    .single()
  if (error) throw new Error(error.message)
  return lot.id
}

async function unknownLot(variantId: string): Promise<string> {
  const { lotId } = await addCardAcquisition(
    {
      cardVariantId: variantId,
      gradingState: 'raw',
      condition: 'NM',
      origin: 'pre_tracking',
      costBasisState: 'unknown',
      quantity: 1,
      acquiredOn: today,
      clientRequestKey: crypto.randomUUID(),
    },
    db,
  )
  return lotId
}

describe('purchases: every money field round-trips exactly through the data layer', () => {
  it('createPurchase / getPurchase / listPurchases / updatePurchase above 2^53', async () => {
    await freshUser('purchase')
    const shipping = B
    const customs = C
    const discount = 7n
    const purchase = await createPurchase(
      {
        purchasedOn: today,
        currency: 'NOK',
        lines: [accessory(A)],
        shippingMinor: shipping,
        customsMinor: customs,
        discountMinor: discount,
      },
      crypto.randomUUID(),
      db,
    )
    const total = A + shipping + customs - discount

    expect(purchase.subtotalMinor).toBe(A)
    expect(purchase.shippingMinor).toBe(shipping)
    expect(purchase.customsMinor).toBe(customs)
    expect(purchase.discountMinor).toBe(discount)
    expect(purchase.totalMinor).toBe(total)
    expect(purchase.totalNokMinor).toBe(total)
    // The ledger itself holds the requested value — not merely a client that agrees with itself.
    expect(await storedText('purchases', 'subtotal_minor', purchase.id)).toBe(A.toString())
    expect(await storedText('purchases', 'shipping_minor', purchase.id)).toBe(shipping.toString())
    expect(await storedText('purchases', 'total_minor', purchase.id)).toBe(total.toString())

    const detail = await getPurchase(purchase.id)
    expect(detail).not.toBeNull()
    const line = detail!.lines[0]!
    expect(line.unitPriceMinor).toBe(A)
    expect(line.lineTotalMinor).toBe(A)
    expect(line.allocatedShippingMinor).toBe(shipping)
    expect(line.allocatedCustomsMinor).toBe(customs)
    expect(line.allocatedDiscountMinor).toBe(discount)
    expect(line.attributableCostMinor).toBe(total)
    expect(line.attributableCostNokMinor).toBe(total)

    const listed = (await listPurchases()).find((item) => item.purchase.id === purchase.id)
    expect(listed?.purchase.totalMinor).toBe(total)

    // An edit resends every field, so it exercises the write path a second time.
    const updated = await updatePurchase(
      purchase.id,
      {
        purchasedOn: today,
        currency: 'NOK',
        lines: [{ ...accessory(A + 2n), lineId: line.id }],
        shippingMinor: shipping + 2n,
        customsMinor: customs,
        discountMinor: discount,
      },
      db,
    )
    expect(updated.subtotalMinor).toBe(A + 2n)
    expect(updated.shippingMinor).toBe(shipping + 2n)
    expect(updated.totalMinor).toBe(total + 4n)
  })

  it('a quantity multiplies an unsafe unit price exactly (server product, exact echo)', async () => {
    await freshUser('quantity')
    const purchase = await createPurchase(
      { purchasedOn: today, currency: 'NOK', lines: [accessory(A, 3)] },
      crypto.randomUUID(),
      db,
    )
    expect(purchase.subtotalMinor).toBe(3n * A)
    expect(purchase.totalMinor).toBe(3n * A)
  })

  it.each([
    { currency: 'EUR', rate: '11.50000000', minor: A },
    { currency: 'USD', rate: '10.25000000', minor: A },
    // JPY has no minor unit: the same integer means 100x more money, and the rate is per ONE yen.
    { currency: 'JPY', rate: '0.06037500', minor: A },
  ])(
    '$currency: foreign amount and the frozen NOK conversion are exact (FX P136 contract)',
    async ({ currency, rate, minor }) => {
      await freshUser(`fx-${currency.toLowerCase()}`)
      const purchase = await createPurchase(
        {
          purchasedOn: today,
          currency,
          lines: [accessory(minor)],
          fxRateToNok: rate,
          fxRateDate: today,
          fxSource: 'manual',
        },
        crypto.randomUUID(),
        db,
      )
      expect(purchase.totalMinor).toBe(minor)
      // The domain twin of money_minor_to_nok_minor computes the expected NOK value with bigint
      // arithmetic only — it never sees a JavaScript number for the amount or the rate.
      const expectedNok = convert(
        fromMinorUnits(minor, currency as 'EUR' | 'USD' | 'JPY'),
        rate,
        'NOK',
      ).minorUnits
      expect(purchase.totalNokMinor).toBe(expectedNok)
      expect(await storedText('purchases', 'total_nok_minor', purchase.id)).toBe(
        expectedNok.toString(),
      )
      // The rate the ledger froze reads back with every digit.
      const detail = await getPurchase(purchase.id)
      expect(detail?.purchase.fxRateToNok).toBe(normalizeDecimalText(rate))
    },
  )
})

describe('aggregates: individually safe rows whose SUM exceeds 2^53 arrive exact', () => {
  it('purchase_spending_summary and the dashboard/monthly aggregates', async () => {
    await freshUser('aggregate')
    // Hobby: (2^53 - 1) + 2 = 2^53 + 1. Collectible: the same shape on card lines.
    await createPurchase(
      { purchasedOn: today, currency: 'NOK', lines: [accessory(SAFE)] },
      crypto.randomUUID(),
      db,
    )
    await createPurchase(
      { purchasedOn: today, currency: 'NOK', lines: [accessory(2n)] },
      crypto.randomUUID(),
      db,
    )
    await cardLot(SAFE, seedCatalog.pikachuVariantId)
    await cardLot(2n, seedCatalog.charizardVariantId)

    const hobby = SAFE + 2n
    const collectible = SAFE + 2n
    const summary = await getSpendingSummary()
    expect(summary.hsNokMinor).toBe(hobby)
    expect(summary.csNokMinor).toBe(collectible)
    expect(summary.gpoNokMinor).toBe(hobby + collectible)

    const dashboard = await getDashboardSummary()
    expect(dashboard.gpoMinor).toBe(hobby + collectible)
    expect(dashboard.csMinor).toBe(collectible)
    expect(dashboard.hsMinor).toBe(hobby)
    expect(dashboard.thcoMinor).toBe(hobby + collectible)

    const months = await getMonthlySpend(1)
    expect(months.at(-1)?.totalMinor).toBe(hobby + collectible)
    expect(months.at(-1)?.collectibleMinor).toBe(collectible)
    expect(months.at(-1)?.hobbyMinor).toBe(hobby)

    const activity = await getRecentActivity(10)
    const amounts = activity.filter((a) => a.type === 'purchase').map((a) => a.amountMinor)
    expect(amounts).toContain(SAFE)
    const history = await listHistoryEvents({ limit: 20 })
    expect(history.filter((e) => e.kind === 'purchase').map((e) => e.amountNokMinor)).toContain(
      SAFE,
    )
  })
})

describe('sales: signed results below -2^53 arrive exact and are never clamped', () => {
  it.each([
    { label: '-(2^53 + 1)', gross: 0n, fees: A },
    { label: '-2^58', gross: 0n, fees: 2n ** 58n },
    { label: '-(2^58 + 3) + 100 (mixed magnitude)', gross: 100n, fees: B + 100n },
  ])('uncosted sale with net proceeds $label', async ({ gross, fees }) => {
    await freshUser('sale-negative')
    const lotId = await unknownLot(seedCatalog.charizardVariantId)
    const sale = await createSale(
      [{ lotId, quantity: 1, unitGrossMinor: gross }],
      { soldOn: today, currency: 'NOK', feesMinor: fees },
      crypto.randomUUID(),
      db,
    )
    const net = gross - fees
    expect(net).toBeLessThan(-SAFE)
    expect(sale.netProceedsMinor).toBe(net)
    expect(sale.netProceedsNokMinor).toBe(net)
    // P144: the uncosted cash flow keeps its sign; the result of an uncosted sale stays unknown.
    expect(sale.proceedsFromUncostedNokMinor).toBe(net)
    expect(sale.realizedResultNokMinor).toBeNull()
    expect(await storedText('sales', 'net_proceeds_minor', sale.id)).toBe(net.toString())

    const detail = await getSale(sale.id)
    const line = detail!.lines[0]!
    expect(line.netProceedsMinor).toBe(net)
    expect(line.netProceedsNokMinor).toBe(net)
    expect(line.costBasisAtSaleNokMinor).toBeNull()
    expect(line.realizedResultNokMinor).toBeNull()

    const summary = await getSalesSummary()
    expect(summary.nspNokMinor).toBe(net)
    expect(summary.pudNokMinor).toBe(net)
    expect(summary.rrcNokMinor).toBe(0n)
    expect(summary.grossNokMinor).toBe(gross)
    expect(summary.feesNokMinor).toBe(fees)

    const dashboard = await getDashboardSummary()
    expect(dashboard.nspMinor).toBe(net)
    expect(dashboard.pudMinor).toBe(net)

    // Editing the price re-sends the whole sale through the write path once more.
    const edited = await updateSale(
      sale.id,
      [{ lineId: line.id, unitGrossMinor: gross + 1n }],
      {
        soldOn: today,
        currency: 'NOK',
        feesMinor: fees,
      },
      db,
    )
    expect(edited.netProceedsMinor).toBe(net + 1n)
  })

  it('known-basis sale: basis, net and realized result all exact; F5 holds in bigint', async () => {
    await freshUser('sale-costed')
    const basis = C // 2^57 + 1
    const lotId = await cardLot(basis, seedCatalog.pikachuVariantId)
    const gross = 3n
    const sale = await createSale(
      [{ lotId, quantity: 1, unitGrossMinor: gross }],
      { soldOn: today, currency: 'NOK' },
      crypto.randomUUID(),
      db,
    )
    const realized = gross - basis
    expect(realized).toBeLessThan(-SAFE)
    expect(sale.netProceedsMinor).toBe(gross)
    expect(sale.realizedResultNokMinor).toBe(realized)
    expect(sale.proceedsFromUncostedNokMinor).toBe(0n)

    const line = (await getSale(sale.id))!.lines[0]!
    expect(line.costBasisAtSaleNokMinor).toBe(basis)
    expect(line.realizedResultNokMinor).toBe(realized)

    const summary = await getSalesSummary()
    expect(summary.rrcNokMinor).toBe(realized)
    // F5: realized (costed) + uncosted proceeds = net proceeds - cost basis of the costed lines.
    expect(summary.rrcNokMinor + summary.pudNokMinor).toBe(summary.nspNokMinor - basis)
  })
})

describe('valuations, cost basis, thresholds and the portfolio cursor', () => {
  it('manual valuation, cost basis on acquisition, and the value read models', async () => {
    await freshUser('valuation')
    // A manual value is only meaningful for a graded or sealed holding (server rule), so the
    // holding is a graded card bought at a known, unsafe unit cost.
    const { holdingId, lotId } = await addCardAcquisition(
      {
        cardVariantId: seedCatalog.pikachuVariantId,
        gradingState: 'graded',
        grader: 'psa',
        grade: 9,
        origin: 'purchase',
        costBasisState: 'known',
        unitCostBasisMinor: A + 8n,
        quantity: 1,
        acquiredOn: today,
        manualValueMinor: A,
        clientRequestKey: crypto.randomUUID(),
      },
      db,
    )
    const lots = await getHoldingLots(holdingId)
    expect(lots.find((l) => l.id === lotId)?.unitCostBasisMinor).toBe(A + 8n)

    expect((await getActiveManualValuation(holdingId))?.valueMinor).toBe(A)
    await setManualValuation({ holdingId, valueMinor: A + 2n }, db)
    expect((await getActiveManualValuation(holdingId))?.valueMinor).toBe(A + 2n)

    const provenance = await getHoldingValueProvenance(holdingId)
    expect(provenance.unitValueMinor).toBe(A + 2n)
    expect(provenance.holdingValueMinor).toBe(A + 2n)

    const page = await listPortfolio({ sort: 'value_desc' })
    expect(page.results[0]?.unitValueMinor).toBe(A + 2n)
    expect(page.results[0]?.holdingValueMinor).toBe(A + 2n)
    const counts = await getPortfolioCounts()
    expect(counts.portfolioValueMinor).toBe(A + 2n)
    expect(counts.cardsValueMinor).toBe(A + 2n)
    expect((await getDashboardSummary()).gradedValueMinor).toBe(A + 2n)
  })

  it('the low-value threshold round-trips exactly', async () => {
    await freshUser('threshold')
    await updateMyProfile({ lowValueThresholdMinor: A }, db)
    expect((await getMyProfile()).lowValueThresholdMinor).toBe(A)
  })

  it('keyset pagination by value does not repeat or skip rows that differ only above 2^53', async () => {
    await freshUser('cursor')
    // Two holdings whose values differ by 2 minor units at 2^53 scale: a double cannot tell the
    // cursor's value apart from its neighbours', which repeats a row (or drops one) at a page break.
    const low = A
    const high = A + 2n
    for (const [variant, value] of [
      [seedCatalog.pikachuVariantId, low],
      [seedCatalog.charizardVariantId, high],
    ] as const) {
      await addCardAcquisition(
        {
          cardVariantId: variant,
          gradingState: 'graded',
          grader: 'psa',
          grade: 9,
          origin: 'pre_tracking',
          costBasisState: 'unknown',
          quantity: 1,
          acquiredOn: today,
          manualValueMinor: value,
          clientRequestKey: crypto.randomUUID(),
        },
        db,
      )
    }
    const first = await listPortfolio({ sort: 'value_desc', limit: 1 })
    expect(first.results).toHaveLength(1)
    expect(first.results[0]?.holdingValueMinor).toBe(high)
    expect(first.nextCursor?.valueMinor).toBe(high)

    const second = await listPortfolio({ sort: 'value_desc', limit: 1, cursor: first.nextCursor })
    expect(second.results).toHaveLength(1)
    expect(second.results[0]?.holdingValueMinor).toBe(low)
    expect(second.results[0]?.holdingId).not.toBe(first.results[0]?.holdingId)
  })
})

describe('openings', () => {
  it('a provisional opening carries an unsafe receipt total and bulk estimate exactly', async () => {
    await freshUser('opening')
    const total = A + 4n
    const bulk = A + 6n
    const opening = await createProvisionalOpening(
      {
        sealedProductId: seedCatalog.sealedProductId,
        quantity: 2,
        totalPaidNokMinor: total,
        purchasedOn: today,
        pulls: [{ cardVariantId: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
        bulkRemainderEstimateNokMinor: bulk,
        bulkRemainderCount: 5,
      },
      db,
    )
    // 2 units: the backend splits the receipt exactly (floor unit x quantity + residual).
    expect(opening.bulkRemainderEstimateNokMinor).toBe(bulk)
    expect(opening.costNokMinor).toBe(total)
    const detail = await getOpening(opening.id)
    expect(detail?.costNokMinor).toBe(total)
    expect(detail?.bulkRemainderEstimateNokMinor).toBe(bulk)
    expect(detail?.openingReturnNokMinor).not.toBeNull()
  })
})
