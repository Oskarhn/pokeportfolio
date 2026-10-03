import { createNativeClient } from '../../src/auth/create-client'
import { createChunkedSessionStorage } from '../../src/auth/chunked-session-storage'
import { createSharedCollectionPort } from '../../src/collection/shared-data-adapter'
import type { CollectionCursor } from '../../src/collection/types'
import { classifyFailure } from '../../src/net/failure'
import { UnsafeMoneyTransportError } from '../../src/money/wire'
import { WriteRefusedError, type RequestLogEntry } from '../../src/net/spike-fetch'
import { MemoryKeyValueStore } from '../support/fakes'
import { setFakeSupabase } from '../support/unit-supabase-client'

/**
 * The web app's RELEASED data layer (src/data/portfolio.ts, collection.ts) running unchanged on the
 * native client, over a scripted network. These tests pin what DB 104 sends and how the native
 * client reads it.
 */

const CONFIG = {
  url: 'http://127.0.0.1:55321',
  publishableKey: 'sb_publishable_' + 'k'.repeat(20),
  host: '127.0.0.1',
}

type Handler = (path: string, body: string | null) => Response | Promise<Response>

function client(handler: Handler) {
  const log: RequestLogEntry[] = []
  const bodies: string[] = []
  const c = createNativeClient(CONFIG, {
    storage: createChunkedSessionStorage(new MemoryKeyValueStore()),
    baseFetch: (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] as string
      const body = typeof init?.body === 'string' ? init.body : null
      if (body !== null) bodies.push(body)
      return Promise.resolve(handler(path, body))
    },
    fetchOptions: { onRequest: (e) => log.push(e) },
  })
  setFakeSupabase(c)
  return { c, log, bodies }
}

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function portfolioRow(id: string, value: string | null, extra: Record<string, unknown> = {}) {
  return {
    holding_id: id,
    holding_kind: 'raw_card',
    card_variant_id: `v-${id}`,
    manual_card_id: null,
    condition: 'NM',
    grading_state: 'raw',
    grader: null,
    grade: null,
    cert_number: null,
    is_favorite: false,
    notes: null,
    created_at: '2026-09-20T11:18:37+00:00',
    quantity: 3,
    lot_count: 1,
    variant_finish: 'normal',
    variant_stamp: '',
    variant_subtype: '',
    card_name: `Card ${id}`,
    card_local_id: '1',
    card_image_base_url: null,
    card_language: 'en',
    card_set_id: 's',
    card_set_name: 'Set',
    manual_name: null,
    manual_set_name: null,
    manual_collector_number: null,
    manual_language: null,
    sealed_product_id: null,
    sealed_product_type: null,
    sealed_product_name: null,
    sealed_product_language: null,
    sealed_pack_count: null,
    sealed_image_url: null,
    sealed_set_id: null,
    sealed_set_name: null,
    sealed_is_custom: false,
    qty_keep_sealed: 0,
    qty_planned_to_open: 0,
    qty_undecided: 0,
    unit_value_nok_minor: value,
    holding_value_nok_minor: value,
    price_state: value === null ? 'missing' : 'manual',
    acquired_on_min: null,
    acquired_on_max: null,
    has_multiple_storage_locations: false,
    number_sort_key: '0001',
    ...extra,
  }
}

async function listFailure(handler: Handler) {
  client(handler)
  try {
    await createSharedCollectionPort().listPage({ sort: 'added_newest', cursor: null, limit: 10 })
  } catch (e) {
    return classifyFailure(e)
  }
  throw new Error('expected a failure')
}

describe('collection port over the RELEASED shared data layer', () => {
  it('reads money above 2^53 exactly (list_portfolio returns text), and NULL stays null', async () => {
    client(() =>
      json([
        portfolioRow('a', '864691128455135235'),
        portfolioRow('b', '9007199254740993'),
        portfolioRow('c', null),
        portfolioRow('d', '0'),
      ]),
    )
    const page = await createSharedCollectionPort().listPage({
      sort: 'added_newest',
      cursor: null,
      limit: 10,
    })
    expect(page.rows.map((r) => r.holdingValueMinor)).toEqual([
      864691128455135235n,
      9007199254740993n,
      null,
      0n,
    ])
    expect(page.rows.map((r) => r.priceState)).toEqual(['manual', 'manual', 'missing', 'manual'])
  })

  it('a full page yields a keyset cursor; a short page ends the list', async () => {
    client(() => json([portfolioRow('a', null), portfolioRow('b', null)]))
    const port = createSharedCollectionPort()
    expect(
      (await port.listPage({ sort: 'added_newest', cursor: null, limit: 2 })).nextCursor,
    ).not.toBeNull()
    expect(
      (await port.listPage({ sort: 'added_newest', cursor: null, limit: 3 })).nextCursor,
    ).toBeNull()
  })

  it('portfolio_counts total above 2^53 is exact', async () => {
    client(() =>
      json({
        physical_card_count: '19955',
        unique_holding_count: '10006',
        graded_count: '0',
        manual_count: '0',
        priced_holding_count: '5',
        unpriced_holding_count: '10001',
        portfolio_value_nok_minor: '891712726219545687',
        cards_value_nok_minor: '891712726219545687',
        sealed_value_nok_minor: '0',
        sealed_holding_count: '0',
        sealed_priced_holding_count: '0',
        sealed_unpriced_holding_count: '0',
        sealed_unit_count: '0',
      }),
    )
    const counts = await createSharedCollectionPort().counts()
    expect(counts.portfolioValueMinor).toBe(891712726219545687n)
    expect(counts.uniqueHoldingCount).toBe(10006)
  })

  it('FAILS CLOSED when the server sends an unquoted integer above 2^53 (no rounded amount is ever shown)', async () => {
    const failure = await listFailure(() =>
      json(
        `[${JSON.stringify(portfolioRow('a', null)).replace('"holding_value_nok_minor":null', '"holding_value_nok_minor":864691128455135235')}]`,
      ),
    )
    expect(failure.kind).toBe('unsafe_numeric')
  })

  it('refuses a value-sort cursor whose value cannot be sent exactly, BEFORE any request', async () => {
    const { log } = client(() => json([]))
    const cursor: CollectionCursor = {
      holdingId: 'h',
      name: 'n',
      setName: 's',
      quantity: 1,
      acquiredOn: null,
      addedAt: 't',
      valueMinor: 2n ** 58n + 1n,
      hasValue: true,
      numberKey: '1',
    }
    await expect(
      createSharedCollectionPort().listPage({ sort: 'value_desc', cursor, limit: 10 }),
    ).rejects.toBeInstanceOf(UnsafeMoneyTransportError)
    expect(log).toHaveLength(0)
  })

  // P188: the shared data layer now carries every money argument as a decimal string (D-137, P146);
  // a number would be rounded above 2^53, so the safe value is no longer special-cased to a JSON number.
  it('sends a safe value cursor as a decimal string and the request passes the guard', async () => {
    const { bodies } = client(() => json([]))
    const cursor: CollectionCursor = {
      holdingId: 'h',
      name: 'n',
      setName: 's',
      quantity: 1,
      acquiredOn: null,
      addedAt: 't',
      valueMinor: 123456n,
      hasValue: true,
      numberKey: '1',
    }
    await createSharedCollectionPort().listPage({ sort: 'value_desc', cursor, limit: 10 })
    expect(bodies[0]).toContain('"p_cursor_value_minor":"123456"')
  })
})

describe('error states from the wire (loading / offline / 401 / 500)', () => {
  const rejecting = { code: 'PGRST301', details: null, hint: null, message: 'JWT expired' }

  it('401 -> unauthorized (status recovered even though the shared wrapper keeps only the message)', async () => {
    expect(await listFailure(() => json(rejecting, 401))).toMatchObject({
      kind: 'unauthorized',
      retryable: false,
    })
  })
  it('500 -> server (retryable)', async () => {
    expect(await listFailure(() => json({ message: 'boom', code: 'XX000' }, 500))).toMatchObject({
      kind: 'server',
      retryable: true,
    })
  })
  it('503 with a non-JSON body -> server', async () => {
    expect(
      await listFailure(() => new Response('<html>bad gateway</html>', { status: 503 })),
    ).toMatchObject({ kind: 'server' })
  })
  it('a network failure -> offline (retryable)', async () => {
    expect(
      await listFailure(() => Promise.reject(new TypeError('Network request failed'))),
    ).toMatchObject({ kind: 'offline', retryable: true })
  })
  it('403 -> forbidden, 404 -> not_found', async () => {
    expect((await listFailure(() => json({ message: 'nope', code: '42501' }, 403))).kind).toBe(
      'forbidden',
    )
    expect((await listFailure(() => json({ message: 'no', code: 'PGRST116' }, 404))).kind).toBe(
      'not_found',
    )
  })
  it('the fixed message never contains server detail', async () => {
    const f = await listFailure(() =>
      json({ message: 'secret-table-name leaked', code: 'XX000' }, 500),
    )
    expect(f.message).not.toContain('secret-table-name')
  })
})

describe('read-only policy', () => {
  it('refuses a financial write RPC and a table insert before they reach the network', async () => {
    const { c, log } = client(() => json([]))
    const refused = await c.rpc('create_purchase' as never, {} as never)
    expect(classifyFailure(refused.error)).toMatchObject({ kind: 'write_refused' })
    const insert = await c.from('holdings').insert({} as never)
    expect(classifyFailure(insert.error)).toMatchObject({ kind: 'write_refused' })
    expect(log).toHaveLength(0)
    expect(new WriteRefusedError('POST', '/x').code).toBe('write_refused')
  })

  it('allows only the read RPCs and records exactly what was called', async () => {
    const { c, log } = client(() => json([]))
    await c.rpc('list_portfolio' as never, { p_sort: 'added_newest', p_limit: 1 } as never)
    await c.rpc('search_cards' as never, { p_query: 'x' } as never)
    await c.from('cards').select('id').limit(1)
    expect(log.map((e) => `${e.method} ${e.path}`)).toEqual([
      'POST /rest/v1/rpc/list_portfolio',
      'POST /rest/v1/rpc/search_cards',
      'GET /rest/v1/cards',
    ])
  })
})
