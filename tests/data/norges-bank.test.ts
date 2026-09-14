import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNorgesBankRates, NorgesBankError } from '../../supabase/functions/_shared/norges-bank'

/**
 * Deterministic, no-network tests for the Norges Bank FX client (M8, FINANCIAL_MODEL.md §7,
 * docs/API_SOURCES.md; UNIT_MULT handling: P130-02 / P134).
 *
 * The EUR, USD and JPY fixtures below are real responses captured live against
 * `https://data.norges-bank.no` (not synthesized shapes) — EUR on 2026-08-21, USD and JPY on
 * 2026-09-14 — trimmed to a few observations. All three confirm the same live fact the P130 audit
 * and the P134 re-verification both found: EUR and USD carry series-level `UNIT_MULT: 0` ("Units"
 * — the printed number already is NOK per 1 unit), while JPY carries `UNIT_MULT: 2` ("Hundreds" —
 * the printed number is NOK per 100 JPY). `fetchNorgesBankRates` must return NOK-per-ONE-unit for
 * every currency alike; a caller must never need to know which currencies Norges Bank happens to
 * rescale.
 */

const REAL_EUR_NOK_RESPONSE = {
  meta: { id: 'IREF390751', prepared: '2026-08-21T19:04:39', test: false },
  data: {
    dataSets: [
      {
        series: {
          '0:0:0:0': {
            attributes: [0, 0, 0, 0],
            observations: {
              '0': ['10.986'],
              '1': ['10.9705'],
              '2': ['10.936'],
              '3': ['10.986'],
              '4': ['10.9325'],
            },
          },
        },
      },
    ],
    structure: {
      dimensions: {
        series: [
          { id: 'FREQ', values: [{ id: 'B', name: 'Business' }] },
          { id: 'BASE_CUR', values: [{ id: 'EUR', name: 'Euro' }] },
          { id: 'QUOTE_CUR', values: [{ id: 'NOK', name: 'Norwegian krone' }] },
          { id: 'TENOR', values: [{ id: 'SP', name: 'Spot' }] },
        ],
        observation: [
          {
            id: 'TIME_PERIOD',
            values: [
              { id: '2026-08-10', name: '2026-08-10' },
              { id: '2026-08-11', name: '2026-08-11' },
              { id: '2026-08-12', name: '2026-08-12' },
              { id: '2026-08-13', name: '2026-08-13' },
              { id: '2026-08-14', name: '2026-08-14' },
            ],
          },
        ],
      },
      attributes: {
        series: [
          { id: 'DECIMALS', values: [{ id: '4', name: '4' }] },
          { id: 'CALCULATED', values: [{ id: 'false', name: 'false' }] },
          { id: 'UNIT_MULT', values: [{ id: '0', name: 'Units' }] },
          { id: 'COLLECTION', values: [{ id: 'C', name: 'ECB concertation time 14:15 CET' }] },
        ],
        observation: [],
      },
    },
  },
}

/** Real USD/NOK response, captured live 2026-09-14, trimmed to 3 observations. UNIT_MULT: 0. */
const REAL_USD_NOK_RESPONSE = {
  meta: { id: 'IREF130167', prepared: '2026-09-14T19:10:15', test: false },
  data: {
    dataSets: [
      {
        series: {
          '0:0:0:0': {
            attributes: [0, 0, 0, 0],
            observations: {
              '0': ['9.3343'],
              '1': ['9.3358'],
              '2': ['9.3037'],
            },
          },
        },
      },
    ],
    structure: {
      dimensions: {
        series: [
          { id: 'FREQ', values: [{ id: 'B', name: 'Business' }] },
          { id: 'BASE_CUR', values: [{ id: 'USD', name: 'US dollar' }] },
          { id: 'QUOTE_CUR', values: [{ id: 'NOK', name: 'Norwegian krone' }] },
          { id: 'TENOR', values: [{ id: 'SP', name: 'Spot' }] },
        ],
        observation: [
          {
            id: 'TIME_PERIOD',
            values: [
              { id: '2026-09-01', name: '2026-09-01' },
              { id: '2026-09-02', name: '2026-09-02' },
              { id: '2026-09-03', name: '2026-09-03' },
            ],
          },
        ],
      },
      attributes: {
        series: [
          { id: 'DECIMALS', values: [{ id: '4', name: '4' }] },
          { id: 'CALCULATED', values: [{ id: 'false', name: 'false' }] },
          { id: 'UNIT_MULT', values: [{ id: '0', name: 'Units' }] },
          { id: 'COLLECTION', values: [{ id: 'C', name: 'ECB concertation time 14:15 CET' }] },
        ],
        observation: [],
      },
    },
  },
}

/**
 * Real JPY/NOK response, captured live 2026-09-14 against
 * `B.JPY.NOK.SP?format=sdmx-json&startPeriod=2026-09-01&endPeriod=2026-09-12`, trimmed to 3
 * observations. UNIT_MULT: 2 ("Hundreds") — every printed value is NOK per 100 JPY. The last
 * observation, `6.0375`, is the exact number the P130-02 audit found being stored unnormalized.
 */
const REAL_JPY_NOK_RESPONSE = {
  meta: { id: 'IREF129869', prepared: '2026-09-14T19:09:43', test: false },
  data: {
    dataSets: [
      {
        series: {
          '0:0:0:0': {
            attributes: [0, 0, 0, 0],
            observations: {
              '0': ['5.828'],
              '1': ['5.8497'],
              '2': ['6.0375'],
            },
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
          {
            id: 'TIME_PERIOD',
            values: [
              { id: '2026-09-01', name: '2026-09-01' },
              { id: '2026-09-02', name: '2026-09-02' },
              { id: '2026-09-11', name: '2026-09-11' },
            ],
          },
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

/**
 * Fabricated (not a real Norges Bank series) fixture for a fictitious base currency with
 * `UNIT_MULT: 1`. Its purpose is narrow: proving the parser applies UNIT_MULT *generically* from
 * provider metadata rather than only recognising the literal string `'JPY'`. A currency-keyed
 * special case (`if (baseCurrency === 'JPY') rate / 100`) passes every EUR/USD/JPY fixture above
 * but would leave this one's `UNIT_MULT: 1` completely unapplied — see MUTATION_B in output_134.txt.
 */
const SYNTHETIC_ISK_UNIT_MULT_1_RESPONSE = {
  meta: { id: 'SYNTHETIC-1', prepared: '2026-09-14T00:00:00', test: true },
  data: {
    dataSets: [
      {
        series: {
          '0:0:0:0': {
            attributes: [0, 0, 0, 0],
            observations: {
              '0': ['5.4321'],
            },
          },
        },
      },
    ],
    structure: {
      dimensions: {
        series: [
          { id: 'FREQ', values: [{ id: 'B', name: 'Business' }] },
          { id: 'BASE_CUR', values: [{ id: 'ISK', name: 'Icelandic krona (synthetic fixture)' }] },
          { id: 'QUOTE_CUR', values: [{ id: 'NOK', name: 'Norwegian krone' }] },
          { id: 'TENOR', values: [{ id: 'SP', name: 'Spot' }] },
        ],
        observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-09-14', name: '2026-09-14' }] }],
      },
      attributes: {
        series: [
          { id: 'DECIMALS', values: [{ id: '4', name: '4' }] },
          { id: 'CALCULATED', values: [{ id: 'false', name: 'false' }] },
          { id: 'UNIT_MULT', values: [{ id: '1', name: 'Tens' }] },
          { id: 'COLLECTION', values: [{ id: 'C', name: 'ECB concertation time 14:15 CET' }] },
        ],
        observation: [],
      },
    },
  },
}

/** Same shape as the JPY fixture, but a fabricated high-precision observation, to prove the
 *  UNIT_MULT shift is exact decimal-string arithmetic rather than a `Number` division that could
 *  introduce binary floating-point rounding into a value about to become a frozen monetary rate. */
function precisionFixture(rawObservation: string, unitMult: string, unitMultName: string) {
  return {
    meta: { id: 'SYNTHETIC-PRECISION', prepared: '2026-09-14T00:00:00', test: true },
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
          observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-09-14', name: '2026-09-14' }] }],
        },
        attributes: {
          series: [
            { id: 'DECIMALS', values: [{ id: '4', name: '4' }] },
            { id: 'CALCULATED', values: [{ id: 'false', name: 'false' }] },
            { id: 'UNIT_MULT', values: [{ id: unitMult, name: unitMultName }] },
            { id: 'COLLECTION', values: [{ id: 'C', name: 'ECB concertation time 14:15 CET' }] },
          ],
          observation: [],
        },
      },
    },
  }
}

/** A response whose UNIT_MULT attribute value is present but not a plain integer. */
function malformedUnitMultResponse() {
  const response = structuredClone(REAL_JPY_NOK_RESPONSE)
  response.data.structure.attributes.series[2]!.values[0] = { id: 'not-a-number', name: 'garbage' }
  return response
}

/** A response whose series attribute *definitions* never include UNIT_MULT at all. */
function missingUnitMultResponse() {
  const response = structuredClone(REAL_JPY_NOK_RESPONSE)
  response.data.structure.attributes.series = response.data.structure.attributes.series.filter(
    (definition) => definition.id !== 'UNIT_MULT',
  )
  return response
}

function mockFetchOnce(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchNorgesBankRates', () => {
  it('parses a real captured EUR/NOK response (UNIT_MULT 0) with the correct date/rate orientation', async () => {
    mockFetchOnce(REAL_EUR_NOK_RESPONSE)

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'EUR',
      startDate: '2026-08-10',
      endDate: '2026-08-14',
    })

    expect(observations).toHaveLength(5)
    // Ascending by date, and the value is NOK per 1 EUR — matching API_SOURCES.md's
    // 2026-08-16 verification exactly, re-confirmed live for this milestone. UNIT_MULT 0 is a
    // no-op: the printed value passes through unchanged.
    expect(observations[0]).toEqual({ date: '2026-08-10', rate: '10.986' })
    expect(observations[3]).toEqual({ date: '2026-08-13', rate: '10.986' })
    expect(observations[4]).toEqual({ date: '2026-08-14', rate: '10.9325' })
  })

  it('parses a real captured USD/NOK response (UNIT_MULT 0) unchanged', async () => {
    mockFetchOnce(REAL_USD_NOK_RESPONSE)

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'USD',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
    })

    expect(observations).toEqual([
      { date: '2026-09-01', rate: '9.3343' },
      { date: '2026-09-02', rate: '9.3358' },
      { date: '2026-09-03', rate: '9.3037' },
    ])
  })

  it('normalizes a real captured JPY/NOK response (UNIT_MULT 2, "Hundreds") to NOK-per-1-JPY — the P130-02 fix', async () => {
    mockFetchOnce(REAL_JPY_NOK_RESPONSE)

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: '2026-09-01',
      endDate: '2026-09-11',
    })

    // The provider printed 6.0375 (NOK per 100 JPY, per its own UNIT_MULT metadata). The
    // canonical fx_rate_to_nok contract (FINANCIAL_MODEL.md §7) is NOK per ONE unit, so the
    // returned rate must be 6.0375 / 100 = 0.060375 — exactly, as a string, not a
    // floating-point approximation (P130-02's "no float-induced 100x issue").
    expect(observations).toEqual([
      { date: '2026-09-01', rate: '0.05828' },
      { date: '2026-09-02', rate: '0.058497' },
      { date: '2026-09-11', rate: '0.060375' },
    ])
  })

  it('applies UNIT_MULT generically from provider metadata, not from a JPY-keyed special case', async () => {
    // A fictitious base currency with UNIT_MULT 1 ("Tens"). A parser that only special-cases
    // 'JPY' would return '5.4321' unchanged here; the correct generic division by 10^1 gives
    // '0.54321'. See MUTATION_B in output_134.txt.
    mockFetchOnce(SYNTHETIC_ISK_UNIT_MULT_1_RESPONSE)

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'ISK',
      startDate: '2026-09-14',
      endDate: '2026-09-14',
    })

    expect(observations).toEqual([{ date: '2026-09-14', rate: '0.54321' }])
  })

  it('shifts a decimal by exact string arithmetic where a naive float division would round wrong', async () => {
    // 1.1 / 10^2 = 0.011 exactly. `Number('1.1') / 100` does NOT reproduce this in JS — it
    // produces 0.011000000000000001, an IEEE-754 binary-fraction artifact — which is exactly the
    // class of silent corruption a frozen, never-recomputed monetary rate (FINANCIAL_MODEL.md §7,
    // invariant F11) cannot tolerate. The string-shift implementation never converts to a binary
    // float, so it cannot reproduce that artifact.
    expect(String(Number('1.1') / 100)).not.toBe('0.011') // documents the risk this guards against
    mockFetchOnce(precisionFixture('1.1', '2', 'Hundreds'))

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: '2026-09-14',
      endDate: '2026-09-14',
    })

    expect(observations).toEqual([{ date: '2026-09-14', rate: '0.011' }])
  })

  it('shifts an observation with many significant digits without truncating precision', async () => {
    // 123456789012.3456 / 10^2 = 1234567890.123456 exactly, regardless of magnitude — the
    // string-shift implementation's exactness does not depend on the value staying inside a
    // float's safe range.
    mockFetchOnce(precisionFixture('123456789012.3456', '2', 'Hundreds'))

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: '2026-09-14',
      endDate: '2026-09-14',
    })

    expect(observations).toEqual([{ date: '2026-09-14', rate: '1234567890.123456' }])
  })

  it('is a no-op for UNIT_MULT 0 even when the observation has many decimal digits', async () => {
    mockFetchOnce(precisionFixture('9.12345678', '0', 'Units'))

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: '2026-09-14',
      endDate: '2026-09-14',
    })

    expect(observations).toEqual([{ date: '2026-09-14', rate: '9.12345678' }])
  })

  it('resolves the historical window the same way as a current-day window (same shared parser)', async () => {
    // fetch-fx-rate calls this for any past purchase/sale date; ingest-fx calls it only for
    // "today". Both go through this exact function with no branch on which caller it is — this
    // fixture's window (2026-09-01..2026-09-11) stands in for a historical lookup.
    mockFetchOnce(REAL_JPY_NOK_RESPONSE)
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'JPY',
      startDate: '2026-09-01',
      endDate: '2026-09-11',
    })
    expect(observations.at(-1)).toEqual({ date: '2026-09-11', rate: '0.060375' })
  })

  it('the last observation in a window ending on a weekend is the prior business day', async () => {
    // A window request never includes a weekend observation at all — Norges Bank simply has none
    // to return — so "the last element" is already the correct prior-business-day fallback
    // (FINANCIAL_MODEL.md §7) without any date-arithmetic guessing on our side.
    mockFetchOnce(REAL_EUR_NOK_RESPONSE)
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'EUR',
      startDate: '2026-08-08', // a Saturday
      endDate: '2026-08-14',
    })
    const latest = observations[observations.length - 1]
    expect(latest).toEqual({ date: '2026-08-14', rate: '10.9325' })
  })

  it('returns an empty array on a 404 (no series for this currency pair) rather than throwing', async () => {
    mockFetchOnce({}, 404)
    const observations = await fetchNorgesBankRates({
      baseCurrency: 'ZZZ',
      startDate: '2026-08-10',
      endDate: '2026-08-14',
    })
    expect(observations).toEqual([])
  })

  it('throws NorgesBankError on a genuinely malformed response body', async () => {
    mockFetchOnce({ unexpected: 'shape' })
    await expect(
      fetchNorgesBankRates({ baseCurrency: 'EUR', startDate: '2026-08-10', endDate: '2026-08-14' }),
    ).rejects.toThrow(NorgesBankError)
  })

  it('fails closed on a non-numeric UNIT_MULT rather than assuming 0 (Units)', async () => {
    mockFetchOnce(malformedUnitMultResponse())
    await expect(
      fetchNorgesBankRates({ baseCurrency: 'JPY', startDate: '2026-09-01', endDate: '2026-09-11' }),
    ).rejects.toThrow(NorgesBankError)
  })

  it('fails closed when UNIT_MULT metadata is missing entirely rather than assuming 0 (Units)', async () => {
    mockFetchOnce(missingUnitMultResponse())
    await expect(
      fetchNorgesBankRates({ baseCurrency: 'JPY', startDate: '2026-09-01', endDate: '2026-09-11' }),
    ).rejects.toThrow(NorgesBankError)
  })

  it('rejects an invalid currency code before ever making a network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      fetchNorgesBankRates({ baseCurrency: 'eur', startDate: '2026-08-10', endDate: '2026-08-14' }),
    ).rejects.toThrow(NorgesBankError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
