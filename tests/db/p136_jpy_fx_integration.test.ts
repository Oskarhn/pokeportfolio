import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import { fetchNorgesBankRates } from '../../supabase/functions/_shared/norges-bank'
import {
  convertToNokMinorUnits,
  normalizeNorgesBankRate,
  NORGES_BANK_UNIT_MULT,
} from '../data/p135/reference/fx-oracle'

/**
 * P136 — coordinated-release integration test. P133 (SQL exponent fix) and P134 (Norges Bank
 * UNIT_MULT normalization) were built as independent workstreams and never tested together, and
 * neither was cross-checked against P135's independent, from-scratch oracle (P133's own parity
 * test used `src/domain/fx.ts` — the pre-existing client module, already cited as correct by the
 * P130 audit — as its reference, which the P136 prompt (§10/§18) requires a second, fully
 * independent check against).
 *
 * This file proves the FULL chain, end to end, on the actual integrated tree:
 *   real Norges Bank SDMX response (mocked fetch only)
 *     -> real `fetchNorgesBankRates` (P134's fix normalizes UNIT_MULT)
 *     -> real `create_purchase`/`create_sale` RPC (P133's fix applies the exponent shift)
 *     -> compared against P135's independent oracle (`convertToNokMinorUnits`), computed from the
 *        SAME normalized rate string, never from either fix's own implementation.
 *
 * A partial-deployment regression (SQL fixed but parser not, or vice versa) would be caught here:
 * either half missing reproduces exactly the ~100x-too-high or ~100x-too-low cells of P135's
 * PARTIAL_DEPLOY_MATRIX (output_135.txt), not the oracle's value.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p136-fx-integration')
  clientA = await signInAs(userA)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const today = new Date().toISOString().slice(0, 10)

interface PurchaseRow {
  id: string
  total_nok_minor: number
  fx_rate_to_nok: string
}

interface SaleRow {
  id: string
  net_proceeds_nok_minor: number
  fx_rate_to_nok: string
}

interface LotRow {
  id: string
}

/** One NOK-currency card purchase, quantity 1, to produce a lot a sale can dispose of — sale
 *  currency/rate are independent of the acquiring purchase's own currency. */
async function acquireLot(): Promise<LotRow> {
  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.grassEnergyVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 100000,
        },
      ],
    })
    .single<PurchaseRow>()
  if (error) throw new Error(error.message)
  const { data: line, error: lineError } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  if (lineError) throw new Error(lineError.message)
  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', line.id)
    .single()
  if (lotError) throw new Error(lotError.message)
  return lot
}

/** Real Norges Bank JPY/NOK SDMX-JSON shape, UNIT_MULT=2 ("Hundreds"), same structure P134's own
 *  fixture uses (tests/data/norges-bank.test.ts REAL_JPY_NOK_RESPONSE) — a single observation. */
function jpySdmxFixture(rawObservation: string, observationDate: string) {
  return {
    meta: { id: 'P136-INTEGRATION', prepared: `${observationDate}T12:00:00`, test: false },
    data: {
      dataSets: [
        {
          series: {
            '0:0:0:0': {
              attributes: [0, 0, 0, 0],
              observations: { '0': [rawObservation] },
            },
          },
        },
      ],
      structure: {
        dimensions: {
          series: [
            { id: 'FREQ', values: [{ id: 'B', name: 'Business' }] },
            { id: 'BASE_CUR', values: [{ id: 'JPY', name: 'Japanese yen' }] },
            { id: 'QUOTE_CUR', values: [{ id: 'NOK', name: 'Norwegian krone' }] },
            { id: 'TENOR', values: [{ id: 'SP', name: 'Spot' }] },
          ],
          observation: [
            { id: 'TIME_PERIOD', values: [{ id: observationDate, name: observationDate }] },
          ],
        },
        attributes: {
          series: [
            { id: 'DECIMALS', values: [{ id: '4', name: '4' }] },
            { id: 'CALCULATED', values: [{ id: 'false', name: 'false' }] },
            { id: 'UNIT_MULT', values: [{ id: '2', name: 'Hundreds' }] },
            { id: 'COLLECTION', values: [{ id: 'C', name: 'ECB concertation time 14:15 CET' }] },
          ],
          observation: [],
        },
      },
    },
  }
}

function mockFetchOnce(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) }),
  )
}

describe('P136 — real Norges Bank parser -> real RPC -> independent P135 oracle', () => {
  it('a genuine 10,000 JPY auto-sourced purchase matches the oracle exactly (the deploy-matrix "cell 4" case)', async () => {
    // Raw provider figure: 6.0375 NOK per 100 JPY (UNIT_MULT=2) — the exact number P130 found live.
    mockFetchOnce(jpySdmxFixture('6.0375', today))
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: today,
      endDate: today,
    })
    vi.unstubAllGlobals() // real fetch must reach the local Supabase REST API below, not the mock
    expect(observations).toHaveLength(1)
    const normalizedRate = observations[0]!.rate
    // The real parser's own output, independently cross-checked against the oracle's own
    // normalization of the SAME raw figure (never assumed equal — asserted). Both are correct,
    // decimal-equal representations ('0.060375' vs '0.06037500'); compared numerically, not by
    // exact string equality, since trailing-zero trimming is a cosmetic difference between the two
    // independent implementations, not a semantic one.
    expect(Number(normalizedRate)).toBe(
      Number(normalizeNorgesBankRate('6.0375', NORGES_BANK_UNIT_MULT.JPY)),
    )
    expect(Number(normalizedRate)).toBeCloseTo(0.060375, 8)

    const { data: purchase, error } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'JPY',
        p_fx_rate_to_nok: normalizedRate,
        p_fx_rate_date: today,
        p_fx_source: 'norges_bank',
        p_lines: [
          {
            line_type: 'accessory',
            description: 'P136 integration fixture',
            quantity: 1,
            unit_price_minor: 10000, // 10,000 JPY (exponent 0 -> minor units == major units)
          },
        ],
      })
      .single<PurchaseRow>()
    if (error) throw new Error(error.message)

    const oracleExpected = convertToNokMinorUnits({
      sourceCurrency: 'JPY',
      sourceMinorUnits: 10000n,
      fxRateToNokPerMajorUnit: normalizedRate,
    })
    expect(BigInt(purchase.total_nok_minor)).toBe(oracleExpected)
    expect(purchase.total_nok_minor).toBe(60375) // the exact figure the P136 prompt requires
  })

  it('a genuine JPY sale (auto-sourced rate) matches the oracle exactly', async () => {
    const lot = await acquireLot()
    mockFetchOnce(jpySdmxFixture('6.0375', today))
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: today,
      endDate: today,
    })
    vi.unstubAllGlobals() // real fetch must reach the local Supabase REST API below, not the mock
    const normalizedRate = observations[0]!.rate

    const { data: sale, error } = await clientA
      .rpc('create_sale', {
        p_idempotency_key: crypto.randomUUID(),
        p_sold_on: today,
        p_currency: 'JPY',
        p_fx_rate_to_nok: normalizedRate,
        p_fx_rate_date: today,
        p_fx_source: 'norges_bank',
        p_lines: [{ lot_id: lot.id, quantity: 1, unit_gross_minor: 20000 }],
      })
      .single<SaleRow>()
    if (error) throw new Error(error.message)

    const oracleExpected = convertToNokMinorUnits({
      sourceCurrency: 'JPY',
      sourceMinorUnits: 20000n,
      fxRateToNokPerMajorUnit: normalizedRate,
    })
    expect(BigInt(sale.net_proceeds_nok_minor)).toBe(oracleExpected)
  })

  it('manual and automatic JPY paths converge on the identical NOK value for the same economic rate', async () => {
    mockFetchOnce(jpySdmxFixture('6.0375', today))
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: today,
      endDate: today,
    })
    vi.unstubAllGlobals() // real fetch must reach the local Supabase REST API below, not the mock
    const autoRate = observations[0]!.rate // normalized by the real parser

    const { data: autoPurchase, error: autoError } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'JPY',
        p_fx_rate_to_nok: autoRate,
        p_fx_rate_date: today,
        p_fx_source: 'norges_bank',
        p_lines: [
          { line_type: 'accessory', description: 'auto', quantity: 1, unit_price_minor: 10000 },
        ],
      })
      .single<PurchaseRow>()
    if (autoError) throw new Error(autoError.message)

    // A manual entry made by a user reading the SAME normalized per-unit convention
    // ("NOK per 1 JPY") the UI already labels its field with — not the raw provider figure.
    const { data: manualPurchase, error: manualError } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'JPY',
        p_fx_rate_to_nok: '0.060375',
        p_fx_rate_date: today,
        p_fx_source: 'manual',
        p_lines: [
          { line_type: 'accessory', description: 'manual', quantity: 1, unit_price_minor: 10000 },
        ],
      })
      .single<PurchaseRow>()
    if (manualError) throw new Error(manualError.message)

    expect(autoPurchase.total_nok_minor).toBe(manualPurchase.total_nok_minor)
    expect(autoPurchase.total_nok_minor).toBe(60375)
  })

  it('EUR control: UNIT_MULT=0 is a true no-op end to end (parser, RPC and oracle all agree, unchanged from pre-P133/P134)', async () => {
    mockFetchOnce({
      data: {
        dataSets: [
          {
            series: { '0:0:0:0': { attributes: [0, 0, 0, 0], observations: { '0': ['11.5400'] } } },
          },
        ],
        structure: {
          dimensions: {
            series: [{ id: 'BASE_CUR', values: [{ id: 'EUR', name: 'Euro' }] }],
            observation: [{ id: 'TIME_PERIOD', values: [{ id: today, name: today }] }],
          },
          attributes: {
            series: [{ id: 'UNIT_MULT', values: [{ id: '0', name: 'Units' }] }],
            observation: [],
          },
        },
      },
    })
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'EUR',
      startDate: today,
      endDate: today,
    })
    vi.unstubAllGlobals() // real fetch must reach the local Supabase REST API below, not the mock
    const rate = observations[0]!.rate
    expect(rate).toBe('11.5400')

    const { data: purchase, error } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'EUR',
        p_fx_rate_to_nok: rate,
        p_fx_rate_date: today,
        p_fx_source: 'norges_bank',
        p_lines: [
          {
            line_type: 'card',
            card_variant_id: seedCatalog.grassEnergyVariantId,
            condition: 'NM',
            quantity: 1,
            unit_price_minor: 4500,
          },
        ],
      })
      .single<PurchaseRow>()
    if (error) throw new Error(error.message)

    const oracleExpected = convertToNokMinorUnits({
      sourceCurrency: 'EUR',
      sourceMinorUnits: 4500n,
      fxRateToNokPerMajorUnit: rate,
    })
    expect(BigInt(purchase.total_nok_minor)).toBe(oracleExpected)
  })
})
