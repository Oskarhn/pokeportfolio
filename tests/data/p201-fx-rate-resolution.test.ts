import { describe, expect, it } from 'vitest'
import { hasDeno, opsOn, runFunction, type ProviderStep, type Scenario } from './p201-edge-harness'
import { norgesPath, sdmxResponse } from './p201-fx-fixtures'

/**
 * P201 — fetch-fx-rate and ingest-fx. FINANCIAL_MODEL.md §7: a purchase's FX rate is frozen once
 * (F11), and for a date Norges Bank did not publish on, "the most recent prior business-day rate is
 * used". The cache must never make that rule worse than asking the provider would have.
 */
const withDeno = hasDeno ? describe : describe.skip

const TODAY = new Date().toISOString().slice(0, 10)
const iso = (offsetDays: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10)

function fetchRate(
  request: { baseCurrency: string; date: string },
  cached: { rate: string; rate_date: string } | null,
  upstream: ProviderStep[],
  extra: Partial<Scenario> = {},
): Scenario {
  return {
    function: 'fetch-fx-rate',
    headers: { authorization: 'Bearer user-jwt' },
    request,
    provider: { [norgesPath(request.baseCurrency)]: upstream },
    db:
      cached === null
        ? {}
        : {
            data: {
              fx_rates: [
                {
                  base_currency: request.baseCurrency,
                  quote_currency: 'NOK',
                  source: 'norges_bank',
                  ...cached,
                },
              ],
            },
          },
    ...extra,
  }
}

const upstreamOk = (base: string, obs: [string, string][]): ProviderStep[] => [
  { status: 200, body: sdmxResponse(base, obs) },
]

withDeno('fetch-fx-rate — the cache never substitutes an older rate for a published one', () => {
  const wed = '2026-10-07'
  const published: [string, string][] = [
    ['2026-10-05', '11.0000'],
    ['2026-10-06', '11.1000'],
    ['2026-10-07', '11.2000'],
  ]

  it('asks Norges Bank when the cached row is from an EARLIER business day than the request', () => {
    const result = runFunction(
      fetchRate(
        { baseCurrency: 'EUR', date: wed },
        { rate: '11.0000', rate_date: '2026-10-05' },
        upstreamOk('EUR', published),
      ),
    )
    expect(result.json).toMatchObject({
      ok: true,
      rate: '11.2000',
      rateDate: wed,
      source: 'norges_bank',
    })
    expect(result.providerRequests).toHaveLength(1)
  })

  it('serves the cache without a provider call when the cached row is for the exact date', () => {
    const result = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: wed }, { rate: '11.2000', rate_date: wed }, [
        { status: 500 },
      ]),
    )
    expect(result.json).toMatchObject({ ok: true, rate: '11.2000', rateDate: wed })
    expect(result.providerRequests).toHaveLength(0)
  })

  it('on a weekend resolves to the last business day published, not an older cached one', () => {
    // The most recent Saturday strictly before today (never a future date, whatever day this runs).
    let offset = -1
    while (new Date(`${iso(offset)}T00:00:00Z`).getUTCDay() !== 6) offset--
    const saturday = iso(offset)
    const friday = iso(offset - 1)
    const thursday = iso(offset - 2)
    const result = runFunction(
      fetchRate(
        { baseCurrency: 'EUR', date: saturday },
        { rate: '11.0000', rate_date: iso(offset - 6) },
        upstreamOk('EUR', [
          [thursday, '11.3000'],
          [friday, '11.4000'],
        ]),
      ),
    )
    expect(result.json).toMatchObject({ ok: true, rate: '11.4000', rateDate: friday })
  })

  it('caches every observation of the window it fetched, so a neighbouring date is a cache hit', () => {
    const result = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: wed }, null, upstreamOk('EUR', published)),
    )
    const written = opsOn(result, 'fx_rates', 'upsert').flatMap((o) =>
      Array.isArray(o.payload)
        ? (o.payload as { rate_date: string }[])
        : [o.payload as { rate_date: string }],
    )
    expect(written.map((r) => r.rate_date).sort()).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ])
  })

  it('fails closed, rather than serving an older cached rate, when Norges Bank is unreachable', () => {
    const result = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: wed }, { rate: '11.0000', rate_date: '2026-10-05' }, [
        { status: 503, body: 'down' },
      ]),
    )
    expect(result.json).toMatchObject({ ok: false, error: 'norges_bank_unreachable' })
    // bounded: three attempts, two sleeps, then stop
    expect(result.providerRequests).toHaveLength(3)
    expect(result.sleeps).toHaveLength(2)
  })

  it('recovers from one transient 429 by waiting the provider-stated time', () => {
    const result = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: wed }, null, [
        { status: 429, headers: { 'retry-after': '1' }, body: '' },
        { status: 200, body: sdmxResponse('EUR', published) },
      ]),
    )
    expect(result.json).toMatchObject({ ok: true, rateDate: wed })
    expect(result.sleeps).toEqual([1000])
  })

  it('reports invalid JSON from the provider as an error, never as a rate', () => {
    const result = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: wed }, null, [{ status: 200, body: '<html>' }]),
    )
    expect(result.json).toMatchObject({ ok: false, error: 'norges_bank_unreachable' })
    expect(opsOn(result, 'fx_rates', 'upsert')).toHaveLength(0)
  })

  it('reports no_rate_found when the window holds no observation, and caches nothing', () => {
    const result = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: wed }, null, [{ status: 404, body: '' }]),
    )
    expect(result.json).toMatchObject({ ok: false, error: 'no_rate_found' })
    expect(opsOn(result, 'fx_rates', 'upsert')).toHaveLength(0)
  })

  it('stores a JPY rate per ONE yen, never the raw per-100 figure', () => {
    const result = runFunction({
      function: 'fetch-fx-rate',
      headers: { authorization: 'Bearer user-jwt' },
      request: { baseCurrency: 'JPY', date: wed },
      provider: {
        [norgesPath('JPY')]: [
          {
            status: 200,
            body: sdmxResponse('JPY', [[wed, '6.0375']], { id: '2', name: 'Hundreds' }),
          },
        ],
      },
    })
    expect(result.json).toMatchObject({ ok: true, rate: '0.060375' })
  })

  it('rejects a future date and a non-currency before any provider call', () => {
    const future = runFunction(
      fetchRate({ baseCurrency: 'EUR', date: iso(3) }, null, upstreamOk('EUR', published)),
    )
    expect(future.json).toMatchObject({ ok: false, error: 'date_in_future' })
    const bad = runFunction(fetchRate({ baseCurrency: 'E1R', date: wed }, null, []))
    expect(bad.json).toMatchObject({ ok: false, error: 'invalid_base_currency' })
    expect(future.providerRequests.length + bad.providerRequests.length).toBe(0)
  })

  it('refuses a request with no session', () => {
    const result = runFunction({
      ...fetchRate({ baseCurrency: 'EUR', date: wed }, null, []),
      headers: {},
    })
    expect(result.status).toBe(401)
  })
})

withDeno('ingest-fx — a missed day is backfilled and a silent provider is reported', () => {
  function ingestFx(provider: Record<string, ProviderStep[]>): Scenario {
    return {
      function: 'ingest-fx',
      env: { PRICE_SYNC_SECRET: 's3cret' },
      headers: { authorization: 'Bearer s3cret' },
      request: {},
      provider,
    }
  }
  const recentObs = (base: string, rate: string): [string, string][] => [
    [iso(-3), rate],
    [iso(-2), rate],
    [iso(-1), rate],
  ]
  const upsertedDates = (result: ReturnType<typeof runFunction>) =>
    opsOn(result, 'fx_rates', 'upsert').flatMap((o) =>
      (Array.isArray(o.payload) ? o.payload : [o.payload]).map(
        (r) =>
          `${(r as { base_currency: string }).base_currency}:${(r as { rate_date: string }).rate_date}`,
      ),
    )

  it('upserts every observation of the lookback window, not only the newest', () => {
    const result = runFunction(
      ingestFx({
        [norgesPath('EUR')]: upstreamOk('EUR', recentObs('EUR', '11.5000')),
        [norgesPath('USD')]: upstreamOk('USD', recentObs('USD', '10.2000')),
      }),
    )
    expect(new Set(upsertedDates(result))).toEqual(
      new Set([
        ...[-3, -2, -1].map((d) => `EUR:${iso(d)}`),
        ...[-3, -2, -1].map((d) => `USD:${iso(d)}`),
      ]),
    )
    const run = opsOn(result, 'price_sync_runs', 'insert')[0]!.payload as Record<string, unknown>
    expect(run.status).toBe('succeeded')
  })

  it('records a partial run when one currency fails and still stores the other', () => {
    const result = runFunction(
      ingestFx({
        [norgesPath('EUR')]: upstreamOk('EUR', recentObs('EUR', '11.5000')),
        [norgesPath('USD')]: [{ status: 503, body: '' }],
      }),
    )
    const run = opsOn(result, 'price_sync_runs', 'insert')[0]!.payload as Record<string, unknown>
    expect(run.status).toBe('partial')
    expect(String(run.error)).toContain('USD')
    expect(upsertedDates(result).every((k) => k.startsWith('EUR:'))).toBe(true)
  })

  it('flags a provider whose newest rate is older than a week as a failure, not a success', () => {
    const result = runFunction(
      ingestFx({
        [norgesPath('EUR')]: upstreamOk('EUR', [[iso(-9), '11.5000']]),
        [norgesPath('USD')]: upstreamOk('USD', recentObs('USD', '10.2000')),
      }),
    )
    const run = opsOn(result, 'price_sync_runs', 'insert')[0]!.payload as Record<string, unknown>
    expect(run.status).toBe('partial')
    expect(String(run.error)).toContain('EUR: stale_rate')
  })

  it('is idempotent: delivering the same run twice writes the same keys', () => {
    const scenario = ingestFx({
      [norgesPath('EUR')]: upstreamOk('EUR', recentObs('EUR', '11.5000')),
      [norgesPath('USD')]: upstreamOk('USD', recentObs('USD', '10.2000')),
    })
    expect(upsertedDates(runFunction(scenario)).sort()).toEqual(
      upsertedDates(runFunction(scenario)).sort(),
    )
  })

  it('rejects a call without the operator secret', () => {
    const result = runFunction({ ...ingestFx({}), headers: { authorization: 'Bearer x' } })
    expect(result.status).toBe(401)
    expect(result.ops).toHaveLength(0)
  })
})
