import { describe, expect, it } from 'vitest'
import { hasDeno, opsOn, runFunction, type ProviderStep, type Scenario } from './p201-edge-harness'

/**
 * P201 — ingest-prices and search-prices under provider failure, malformed provider data and
 * repeated delivery. The real function code runs under Deno; the provider is scripted and the
 * database is a recorder, so the assertions are about what the function WROTE and REPORTED.
 */
const withDeno = hasDeno ? describe : describe.skip

const SECRET = 'price-test-secret'
const TODAY = new Date().toISOString().slice(0, 10)

function batchRow(n: number, card = `c${n}`) {
  return {
    card_variant_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    card_id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    tcgdex_card_id: card,
    language: 'en',
    finish: 'normal',
    stamp: '',
    subtype: '',
    size: 'standard',
  }
}

function cardWithTrend(id: string, trend: number, updated = '2026-10-08T05:00:00.000Z') {
  return {
    id,
    variants: { normal: true },
    pricing: { cardmarket: { updated, unit: 'EUR', trend } },
  }
}

function ingest(
  rows: ReturnType<typeof batchRow>[],
  provider: Record<string, ProviderStep[]>,
  extra: Partial<Scenario> = {},
): Scenario {
  return {
    function: 'ingest-prices',
    env: { PRICE_SYNC_SECRET: SECRET },
    headers: { authorization: `Bearer ${SECRET}` },
    request: {},
    provider,
    db: { rpc: { select_price_sync_batch: { data: rows } } },
    ...extra,
  }
}

const OK = (id: string, trend = 5) =>
  [{ status: 200, body: cardWithTrend(id, trend) }] as ProviderStep[]
const DOWN: ProviderStep[] = [{ status: 503, body: 'down' }]

function runRecord(result: ReturnType<typeof runFunction>) {
  const inserts = opsOn(result, 'price_sync_runs', 'insert')
  expect(inserts).toHaveLength(1)
  return inserts[0]!.payload as Record<string, unknown>
}

withDeno('ingest-prices — provider failure is isolated, bounded and reported honestly', () => {
  it('writes the healthy card, skips the failing one, and records the run as partial', () => {
    const result = runFunction(
      ingest([batchRow(1), batchRow(2)], { '/en/cards/c1': OK('c1'), '/en/cards/c2': DOWN }),
    )
    expect(result.status).toBe(200)
    const upserts = opsOn(result, 'price_snapshots', 'upsert')
    expect(upserts).toHaveLength(1)
    const rows = upserts[0]!.payload as { card_variant_id: string }[]
    expect(rows.map((r) => r.card_variant_id)).toEqual([batchRow(1).card_variant_id])
    const run = runRecord(result)
    expect(run.status).toBe('partial')
    expect(run.provider_error_count).toBe(1)
    expect(String(run.error)).toContain('server_error=1')
  })

  it('retries the failing card a bounded number of times and no more', () => {
    const result = runFunction(
      ingest([batchRow(1), batchRow(2)], { '/en/cards/c1': OK('c1'), '/en/cards/c2': DOWN }),
    )
    expect(result.providerRequests.filter((r) => r.endsWith('/cards/c2'))).toHaveLength(3)
    expect(result.providerRequests.filter((r) => r.endsWith('/cards/c1'))).toHaveLength(1)
  })

  it('records a run in which every provider request failed as FAILED, never as succeeded', () => {
    const result = runFunction(
      ingest([batchRow(1), batchRow(2)], { '/en/cards/c1': DOWN, '/en/cards/c2': DOWN }),
    )
    expect(opsOn(result, 'price_snapshots')).toHaveLength(0)
    expect(runRecord(result).status).toBe('failed')
  })

  it('stops asking a provider that keeps refusing us and leaves the rest of the batch queued', () => {
    const rows = Array.from({ length: 24 }, (_, i) => batchRow(i + 1))
    const provider: Record<string, ProviderStep[]> = {}
    for (const row of rows) {
      provider[`/en/cards/${row.tcgdex_card_id}`] = [
        { status: 429, headers: { 'retry-after': '600' }, body: '' },
      ]
    }
    const result = runFunction(ingest(rows, provider))
    // Five provider failures trip the breaker; with five workers a few more were already in flight.
    expect(result.providerRequests.length).toBeLessThanOrEqual(10)
    expect(result.providerRequests.length).toBeLessThan(rows.length)
    expect(result.sleeps).toEqual([])
    const run = runRecord(result)
    expect(run.status).toBe('failed')
    expect(String(run.error)).toContain('stopped: provider_unhealthy')
    expect(String(run.error)).toContain('skipped=')
    expect(result.json.skippedCount).toBeGreaterThan(0)
    // Skipped cards are not provider errors: they say nothing about the card.
    expect((run.provider_error_count as number) + (result.json.skippedCount as number)).toBe(24)
  })

  it('treats a 404 for a card as a provider error for that card only', () => {
    const result = runFunction(ingest([batchRow(1), batchRow(2)], { '/en/cards/c1': OK('c1') }))
    const run = runRecord(result)
    expect(run.provider_error_count).toBe(1)
    expect(String(run.error)).toContain('not_found=1')
    expect(opsOn(result, 'price_snapshots', 'upsert')).toHaveLength(1)
  })

  it('classifies invalid JSON without retrying it', () => {
    const result = runFunction(
      ingest([batchRow(1)], {
        '/en/cards/c1': [{ status: 200, body: '<html>maintenance</html>' }],
      }),
    )
    expect(result.providerRequests).toHaveLength(1)
    expect(String(runRecord(result).error)).toContain('invalid_json=1')
  })

  it('classifies a timeout and bounds it', () => {
    const result = runFunction(
      ingest(
        [batchRow(1)],
        { '/en/cards/c1': [{ hang: true }] },
        {
          policy: { attemptTimeoutMs: 30, maxAttempts: 2 },
        },
      ),
    )
    expect(result.providerRequests).toHaveLength(2)
    expect(String(runRecord(result).error)).toContain('timeout=1')
  })

  it('an empty batch is a successful no-op that makes no provider request', () => {
    const result = runFunction(ingest([], {}))
    expect(result.providerRequests).toHaveLength(0)
    expect(runRecord(result).status).toBe('succeeded')
  })

  it('rejects a call without the operator secret before touching anything', () => {
    const result = runFunction({
      ...ingest([batchRow(1)], {}),
      headers: { authorization: 'Bearer x' },
    })
    expect(result.status).toBe(401)
    expect(result.ops).toHaveLength(0)
    expect(result.providerRequests).toHaveLength(0)
  })
})

withDeno('ingest-prices — provider data that would poison a whole upsert chunk', () => {
  function snapshotRows(result: ReturnType<typeof runFunction>) {
    return opsOn(result, 'price_snapshots', 'upsert').flatMap(
      (o) => o.payload as Record<string, unknown>[],
    )
  }

  it('stamps a non-existent provider date with the retrieval day instead of sending it to Postgres', () => {
    const result = runFunction(
      ingest([batchRow(1), batchRow(2)], {
        '/en/cards/c1': [{ status: 200, body: cardWithTrend('c1', 5, '2026-02-31T00:00:00.000Z') }],
        '/en/cards/c2': OK('c2'),
      }),
    )
    const rows = snapshotRows(result)
    expect(rows).toHaveLength(2)
    const bad = rows.find((r) => r.card_variant_id === batchRow(1).card_variant_id)!
    expect(bad.snapshot_date).toBe(TODAY)
    expect(bad.provider_updated_at).toBeNull()
    for (const r of rows) expect(String(r.snapshot_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('never writes a far-future provider date that would pin a variant fresh forever', () => {
    const result = runFunction(
      ingest([batchRow(1)], {
        '/en/cards/c1': [{ status: 200, body: cardWithTrend('c1', 5, '2099-01-01T00:00:00.000Z') }],
      }),
    )
    const [row] = snapshotRows(result)
    expect(row!.snapshot_date).toBe(TODAY)
    expect(row!.provider_updated_at).toBeNull()
  })

  it('does not send a negative price to the CHECK-constrained column', () => {
    const result = runFunction(
      ingest([batchRow(1), batchRow(2)], {
        '/en/cards/c1': [{ status: 200, body: cardWithTrend('c1', -4) }],
        '/en/cards/c2': OK('c2'),
      }),
    )
    const rows = snapshotRows(result)
    expect(rows.map((r) => r.card_variant_id)).toEqual([batchRow(2).card_variant_id])
    expect(rows.every((r) => (r.value_minor as number) >= 0)).toBe(true)
  })

  it('writes a genuine zero price', () => {
    const result = runFunction(ingest([batchRow(1)], { '/en/cards/c1': OK('c1', 0) }))
    expect(snapshotRows(result)).toMatchObject([{ value_minor: 0, price_kind: 'cm_trend' }])
  })

  it('is idempotent: the same delivery twice produces the same upsert keys', () => {
    const scenario = ingest([batchRow(1)], { '/en/cards/c1': OK('c1') })
    const keys = (r: ReturnType<typeof runFunction>) =>
      snapshotRows(r).map((x) => `${x.card_variant_id}|${x.provider}|${x.snapshot_date}`)
    expect(keys(runFunction(scenario))).toEqual(keys(runFunction(scenario)))
    const upsert = opsOn(runFunction(scenario), 'price_snapshots', 'upsert')[0]!
    expect(upsert.payload).toHaveLength(1)
  })

  it('reports a database rejection of every chunk as a failed run with the error recorded', () => {
    const result = runFunction(
      ingest(
        [batchRow(1)],
        { '/en/cards/c1': OK('c1') },
        {
          db: {
            rpc: { select_price_sync_batch: { data: [batchRow(1)] } },
            fail: {
              'price_snapshots:upsert': { message: 'check constraint violated', code: '23514' },
            },
          },
        },
      ),
    )
    const run = runRecord(result)
    expect(run.status).toBe('failed')
    expect(String(run.error)).toContain('upsert:')
  })
})

withDeno('search-prices — a provider outage is reported as an outage, not as "no price"', () => {
  const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const variantRow = (id: string, cardId: string, tcgdex: string) => ({
    id,
    card_id: cardId,
    finish: 'normal',
    stamp: '',
    subtype: '',
    size: 'standard',
    cards: { id: cardId, tcgdex_card_id: tcgdex, language: 'en' },
  })

  function search(provider: Record<string, ProviderStep[]>): Scenario {
    return {
      function: 'search-prices',
      headers: { authorization: 'Bearer stub' },
      request: { cardIds: [CARD, OTHER], useEuPricing: true },
      provider,
      db: {
        rows: {
          card_variants: [
            variantRow('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', CARD, 'c1'),
            variantRow('aaaaaaaa-aaaa-4aaa-8aaa-000000000002', OTHER, 'c2'),
          ],
        },
        single: { fx_rates: { rate: 11.5 } },
      },
    }
  }

  it('counts the failed card by class while still answering for the healthy one', () => {
    const result = runFunction(search({ '/en/cards/c1': OK('c1'), '/en/cards/c2': DOWN }))
    expect(result.status).toBe(200)
    expect(result.json.providerErrorCount).toBe(1)
    expect(result.json.providerFailures).toEqual({ server_error: 1 })
    const rows = result.json.results as { priceState: string; cardId: string }[]
    expect(rows.find((r) => r.cardId === CARD)!.priceState).toBe('available')
  })

  it('names a rate limit as rate_limited', () => {
    const result = runFunction(
      search({
        '/en/cards/c1': OK('c1'),
        '/en/cards/c2': [{ status: 429, headers: { 'retry-after': '300' }, body: '' }],
      }),
    )
    expect(result.json.providerFailures).toEqual({ rate_limited: 1 })
  })

  it('reports no failure when every card answered', () => {
    const result = runFunction(search({ '/en/cards/c1': OK('c1'), '/en/cards/c2': OK('c2') }))
    expect(result.json.providerErrorCount).toBe(0)
    expect(result.json.providerFailures).toEqual({})
  })
})
