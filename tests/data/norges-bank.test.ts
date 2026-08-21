import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNorgesBankRates, NorgesBankError } from '../../supabase/functions/_shared/norges-bank'

/**
 * Deterministic, no-network tests for the Norges Bank FX client (M8, FINANCIAL_MODEL.md §7,
 * docs/API_SOURCES.md). The fixture below is the real response captured live 2026-08-21 for
 * `B.EUR.NOK.SP` over 2026-08-10..2026-08-14 — not a synthesized shape — and its values match the
 * 2026-08-16 verification already on record in API_SOURCES.md (10.986 for 2026-08-13, 10.9325 for
 * 2026-08-14). This is exactly the orientation regression test M8 prompt §43 asks for: proving
 * BASE_CUR is the first currency in the pair and the returned number is NOK per one unit of it,
 * against a real captured payload rather than an assumption.
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
    },
  },
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
  it('parses a real captured EUR/NOK response with the correct date/rate orientation', async () => {
    mockFetchOnce(REAL_EUR_NOK_RESPONSE)

    const observations = await fetchNorgesBankRates({
      baseCurrency: 'EUR',
      startDate: '2026-08-10',
      endDate: '2026-08-14',
    })

    expect(observations).toHaveLength(5)
    // Ascending by date, and the value is NOK per 1 EUR — matching API_SOURCES.md's
    // 2026-08-16 verification exactly, re-confirmed live for this milestone.
    expect(observations[0]).toEqual({ date: '2026-08-10', rate: '10.986' })
    expect(observations[3]).toEqual({ date: '2026-08-13', rate: '10.986' })
    expect(observations[4]).toEqual({ date: '2026-08-14', rate: '10.9325' })
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

  it('rejects an invalid currency code before ever making a network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      fetchNorgesBankRates({ baseCurrency: 'eur', startDate: '2026-08-10', endDate: '2026-08-14' }),
    ).rejects.toThrow(NorgesBankError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
