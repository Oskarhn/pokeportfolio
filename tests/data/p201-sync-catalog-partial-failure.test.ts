import { describe, expect, it } from 'vitest'
import { hasDeno, opsOn, runFunction, type ProviderStep, type Scenario } from './p201-edge-harness'

/**
 * P201 — sync-catalog under partial provider failure. Runs the real function under Deno with a
 * scripted TCGdex and a recording database; nothing reaches a network or a real database.
 *
 * The defect these pin: the function deactivated every card of a set that was absent from the list
 * of cards whose DETAIL request had succeeded, so a rate-limit or 5xx burst on the detail endpoint
 * silently removed healthy cards from search (docs/FINANCIAL_MODEL.md F9's "a provider failure may
 * never degrade what we already hold", applied to the catalog).
 */
const withDeno = hasDeno ? describe : describe.skip

const SECRET = 'catalog-test-secret'
const SET_ID = 's1'

function setDetail(cardIds: string[]) {
  return {
    id: SET_ID,
    name: 'Test Set',
    serie: { id: 'sv', name: 'Scarlet & Violet' },
    cardCount: { official: cardIds.length, total: cardIds.length },
    cards: cardIds.map((id) => ({ id })),
  }
}

function cardDetail(id: string) {
  return {
    id,
    localId: id.split('-')[1],
    name: `Card ${id}`,
    variants: { normal: true },
  }
}

function scenario(
  cardIds: string[],
  cardSteps: Record<string, ProviderStep[]>,
  extra: Partial<Scenario> = {},
): Scenario {
  const provider: Record<string, ProviderStep[]> = {
    [`/en/sets/${SET_ID}`]: [{ status: 200, body: setDetail(cardIds) }],
  }
  for (const id of cardIds) {
    provider[`/en/cards/${id}`] = cardSteps[id] ?? [{ status: 200, body: cardDetail(id) }]
  }
  return {
    function: 'sync-catalog',
    env: { CATALOG_SYNC_SECRET: SECRET },
    headers: { authorization: `Bearer ${SECRET}` },
    request: { language: 'en', setId: SET_ID },
    provider,
    db: { counts: { cards: cardIds.length } },
    ...extra,
  }
}

function deactivation(result: ReturnType<typeof runFunction>) {
  return opsOn(result, 'cards', 'update').filter(
    (o) => (o.payload as { is_active?: boolean }).is_active === false,
  )
}

function keptIds(op: { filters: [string, string, unknown][] }): string[] {
  const filter = op.filters.find(
    ([kind, column]) => kind === 'not.in' && column === 'tcgdex_card_id',
  )
  return (String(filter?.[2]).match(/"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1))
}

withDeno('sync-catalog — partial provider failure never deactivates healthy cards', () => {
  const ids = ['s1-001', 's1-002', 's1-003', 's1-004']

  it('keeps a card whose detail request failed on the "still listed" side of the deactivation', () => {
    const result = runFunction(
      scenario(ids, { 's1-003': [{ status: 503, body: 'upstream down' }] }),
    )
    expect(result.status).toBe(200)
    const ops = deactivation(result)
    expect(ops).toHaveLength(1)
    // s1-003 is listed by the provider; only a card the listing no longer names may be deactivated.
    expect(keptIds(ops[0]!).sort()).toEqual(ids)
    expect(result.json.failureCount).toBe(1)
    expect(result.json.complete).toBe(false)
    expect(result.json.cardsUpserted).toBe(3)
  })

  it('makes a bounded number of requests for the failing card', () => {
    const result = runFunction(
      scenario(ids, { 's1-003': [{ status: 503, body: 'upstream down' }] }),
    )
    const forFailing = result.providerRequests.filter((r) => r.endsWith('/en/cards/s1-003'))
    expect(forFailing).toHaveLength(3)
    expect(result.sleeps).toHaveLength(2)
  })

  it('recovers a transient 429 on a card detail and reports the set complete', () => {
    const result = runFunction(
      scenario(ids, {
        's1-002': [
          { status: 429, headers: { 'retry-after': '1' }, body: '' },
          { status: 200, body: cardDetail('s1-002') },
        ],
      }),
    )
    expect(result.json.complete).toBe(true)
    expect(result.json.cardsUpserted).toBe(4)
    expect(result.sleeps).toEqual([1000])
  })

  it('does not deactivate anything when the provider lists no cards at all', () => {
    const result = runFunction(scenario([], {}, { db: { counts: { cards: 12 } } }))
    expect(deactivation(result)).toHaveLength(0)
    expect(result.json.complete).toBe(false)
  })

  it('does not deactivate on a listing that shrank implausibly (provider glitch, not a removal)', () => {
    const result = runFunction(scenario(ids, {}, { db: { counts: { cards: 40 } } }))
    expect(deactivation(result)).toHaveLength(0)
    expect(String(result.json.failureCount)).not.toBe('0')
  })

  it('still deactivates a card the provider genuinely stopped listing', () => {
    const result = runFunction(scenario(ids, {}, { db: { counts: { cards: 5 } } }))
    const ops = deactivation(result)
    expect(ops).toHaveLength(1)
    expect(keptIds(ops[0]!).sort()).toEqual(ids)
    expect(result.json.complete).toBe(true)
  })

  it('answers 404 for an unknown set and records a failed run, touching no catalog row', () => {
    const result = runFunction({
      ...scenario(ids, {}),
      provider: { [`/en/sets/${SET_ID}`]: [{ status: 404, body: '' }] },
    })
    expect(result.status).toBe(404)
    expect(opsOn(result, 'catalog_sync_runs', 'insert')).toHaveLength(1)
    expect(opsOn(result, 'cards')).toHaveLength(0)
  })

  it('answers 502 when the set endpoint is down and does not hammer it', () => {
    const result = runFunction({
      ...scenario(ids, {}),
      provider: { [`/en/sets/${SET_ID}`]: [{ status: 500, body: '' }] },
    })
    expect(result.status).toBe(502)
    expect(result.providerRequests).toHaveLength(3)
  })

  it('rejects a request without the operator secret before any provider or database access', () => {
    const result = runFunction({ ...scenario(ids, {}), headers: { authorization: 'Bearer nope' } })
    expect(result.status).toBe(401)
    expect(result.providerRequests).toHaveLength(0)
    expect(result.ops).toHaveLength(0)
  })

  it('logs one structured, secret-free line per finished set', () => {
    const result = runFunction(scenario(ids, {}))
    const line = result.logs.find((l) => l.includes('set_finished'))
    expect(line).toBeDefined()
    const parsed = JSON.parse(line!) as Record<string, unknown>
    expect(parsed).toMatchObject({ fn: 'sync-catalog', event: 'set_finished', cards_upserted: 4 })
    expect(JSON.stringify(parsed)).not.toContain(SECRET)
  })
})
