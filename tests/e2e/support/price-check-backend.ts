import type { Page, Route } from '@playwright/test'

/**
 * P153: a controlled, in-browser stand-in for the parts of the backend Price Check reads, so the
 * feature can be driven end-to-end in a real browser without a database or a provider. It fulfils
 * requests at the NETWORK boundary of the built app (`page.route`) — the app's own code runs
 * unmodified. Everything served here is SYNTHETIC test data.
 *
 * It also records every request the page makes to the backend. That log is the browser half of the
 * read-only proof: `assertReadOnly` fails on any request that could change state.
 */

export interface FixtureVariant {
  id: string
  finish: 'normal' | 'holo' | 'reverse' | 'other'
  stamp?: string
  subtype?: string
  size?: 'standard' | 'oversized'
  isActive?: boolean
}

export interface FixtureCard {
  id: string
  name: string
  localId: string
  setId: string
  setName: string
  language?: 'en' | 'ja'
  rarity?: string
  illustrator?: string
  variants: FixtureVariant[]
}

export const CARDS: FixtureCard[] = [
  {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: 'Charizard',
    localId: '4',
    setId: 'base1',
    setName: 'Base Set',
    rarity: 'Rare Holo',
    illustrator: 'Mitsuhiro Arita',
    variants: [
      { id: '00000000-0000-4000-8000-00000000c1a0', finish: 'holo', subtype: 'shadowless' },
      {
        id: '00000000-0000-4000-8000-00000000c1b0',
        finish: 'holo',
        subtype: 'shadowless',
        stamp: '1st-edition',
      },
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000000c2',
    name: 'Charizard',
    localId: '11',
    setId: 'evo',
    setName: 'Evolutions',
    rarity: 'Rare Holo',
    illustrator: 'Mitsuhiro Arita',
    variants: [{ id: '00000000-0000-4000-8000-00000000c2a0', finish: 'normal' }],
  },
  {
    id: '00000000-0000-4000-8000-0000000000c3',
    name: 'Charizard',
    localId: '125',
    setId: 'sv3',
    setName: 'Obsidian Flames',
    rarity: 'Double Rare',
    illustrator: '5ban Graphics',
    variants: [
      { id: '00000000-0000-4000-8000-00000000c3a0', finish: 'normal' },
      { id: '00000000-0000-4000-8000-00000000c3b0', finish: 'reverse' },
    ],
  },
  {
    id: '00000000-0000-4000-8000-0000000000d1',
    name: 'Pikachu',
    localId: '58',
    setId: 'base1',
    setName: 'Base Set',
    rarity: 'Common',
    illustrator: 'Mitsuhiro Arita',
    variants: [{ id: '00000000-0000-4000-8000-00000000d1a0', finish: 'normal' }],
  },
  {
    id: '00000000-0000-4000-8000-0000000000e1',
    name: 'Pikachu with Grey Felt Hat and an Extremely Long Promotional Card Name',
    localId: 'SVP 085',
    setId: 'svp',
    setName: 'Scarlet & Violet Black Star Promos',
    rarity: 'Promo',
    illustrator: 'Some Very Long Illustrator Name Junior the Third',
    variants: [{ id: '00000000-0000-4000-8000-00000000e1a0', finish: 'holo' }],
  },
]

export interface WireObservation {
  provider: string
  priceKind: string
  sourceCurrency: string
  valueMinor: string
  providerUpdatedAt: string | null
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

export function cardmarket(
  valueMinor: string,
  observedDaysAgo: number | null = 1,
): WireObservation {
  return {
    provider: 'tcgdex_cardmarket',
    priceKind: 'cm_trend',
    sourceCurrency: 'EUR',
    valueMinor,
    providerUpdatedAt: observedDaysAgo === null ? null : daysAgoIso(observedDaysAgo),
  }
}

export function tcgplayer(valueMinor: string, observedDaysAgo: number | null = 1): WireObservation {
  return {
    provider: 'tcgdex_tcgplayer',
    priceKind: 'tp_market',
    sourceCurrency: 'USD',
    valueMinor,
    providerUpdatedAt: observedDaysAgo === null ? null : daysAgoIso(observedDaysAgo),
  }
}

export interface BackendState {
  /** Per-variant provider observations. A variant absent here has none. */
  observations: Record<string, WireObservation[]>
  /** How `search-prices` answers. `ok` serves `observations`; the rest simulate failures. */
  pricesMode: 'ok' | 'http500' | 'http429' | 'http404' | 'network' | 'malformed' | 'provider-error'
  /** Latest FX rows by base currency; `null` = no cached rate. */
  fx: Record<string, { rate: number | string; rateDate: string } | null>
  /** Artificial delay (ms) per exact search query, to stage out-of-order responses. */
  searchDelayMs: Record<string, number>
  searchMode: 'ok' | 'http500'
  /** Artificial delay (ms) before `search-prices` answers, to observe the loading state. */
  pricesDelayMs: number
  /** Cards the scanner-side `cards?id=in.(…)` lookup should treat as existing (defaults to all). */
  scannerEcho: boolean
}

export interface RequestRecord {
  method: string
  path: string
  search: string
  body: string | null
}

export interface Backend {
  state: BackendState
  requests: RequestRecord[]
  priceRequests: () => RequestRecord[]
  searchQueries: string[]
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': '*',
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function cardRow(card: FixtureCard) {
  return {
    id: card.id,
    name: card.name,
    local_id: card.localId,
    rarity: card.rarity ?? null,
    category: 'Pokemon',
    illustrator: card.illustrator ?? null,
    image_base_url: null,
    language: card.language ?? 'en',
    set_id: card.setId,
    card_sets: { name: card.setName },
  }
}

export function defaultState(): BackendState {
  const today = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  return {
    observations: {},
    pricesMode: 'ok',
    fx: {
      EUR: { rate: 11.54, rateDate: today },
      USD: { rate: 10.5, rateDate: today },
    },
    searchDelayMs: {},
    searchMode: 'ok',
    pricesDelayMs: 0,
    scannerEcho: false,
  }
}

/** Installs the backend stand-in on `page` and returns its live state and request log. */
export async function installBackend(
  page: Page,
  overrides: Partial<BackendState> = {},
): Promise<Backend> {
  const backend: Backend = {
    state: { ...defaultState(), ...overrides },
    requests: [],
    priceRequests: () =>
      backend.requests.filter((r) => r.path.endsWith('/functions/v1/search-prices')),
    searchQueries: [],
  }

  await page.route(/\/(rest|functions|auth)\/v1\//, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    const url = new URL(request.url())
    const record: RequestRecord = {
      method: request.method(),
      path: url.pathname,
      search: url.search,
      body: request.postData(),
    }
    backend.requests.push(record)
    const { state } = backend

    // ── catalog search RPC ─────────────────────────────────────────────────────────────────
    if (url.pathname.endsWith('/rest/v1/rpc/search_cards')) {
      const args = JSON.parse(record.body ?? '{}') as {
        p_query?: string
        p_language?: string | null
      }
      const query = (args.p_query ?? '').trim()
      backend.searchQueries.push(query)
      const delay = state.searchDelayMs[query]
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      if (state.searchMode === 'http500') {
        await json(route, 500, { message: 'search backend down' })
        return
      }
      const q = query.toLowerCase()
      const matches = CARDS.filter(
        (c) =>
          (q !== '' && (c.name.toLowerCase().includes(q) || c.setName.toLowerCase().includes(q))) ||
          (state.scannerEcho && q !== ''),
      ).filter((c) => args.p_language == null || (c.language ?? 'en') === args.p_language)
      const rows = (state.scannerEcho && matches.length === 0 ? CARDS.slice(0, 3) : matches).map(
        (c) => ({
          card_id: c.id,
          name: c.name,
          local_id: c.localId,
          rarity: c.rarity ?? null,
          category: 'Pokemon',
          illustrator: c.illustrator ?? null,
          image_base_url: null,
          language: c.language ?? 'en',
          set_id: c.setId,
          set_name: c.setName,
          variant_count: c.variants.length,
          total_count: matches.length,
        }),
      )
      await json(route, 200, rows)
      return
    }

    // ── catalog reads ──────────────────────────────────────────────────────────────────────
    if (url.pathname.endsWith('/rest/v1/cards')) {
      const wantsObject = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object')
      const idFilter = url.searchParams.get('id') ?? ''
      const ids = idFilter.startsWith('eq.')
        ? [idFilter.slice(3)]
        : idFilter.startsWith('in.')
          ? idFilter.slice(4, -1).split(',')
          : []
      const found = CARDS.filter((c) => ids.includes(c.id)).map(cardRow)
      if (wantsObject) {
        if (found[0]) await json(route, 200, found[0])
        else await json(route, 406, { code: 'PGRST116', message: 'no rows' })
      } else {
        await json(route, 200, found)
      }
      return
    }
    if (url.pathname.endsWith('/rest/v1/card_variants')) {
      const cardId = (url.searchParams.get('card_id') ?? '').replace('eq.', '')
      const card = CARDS.find((c) => c.id === cardId)
      await json(
        route,
        200,
        (card?.variants ?? []).map((v) => ({
          id: v.id,
          finish: v.finish,
          stamp: v.stamp ?? '',
          subtype: v.subtype ?? '',
          size: v.size ?? 'standard',
          is_active: v.isActive ?? true,
        })),
      )
      return
    }
    if (url.pathname.endsWith('/rest/v1/fx_rates')) {
      const base = (url.searchParams.get('base_currency') ?? '').replace('eq.', '')
      const row = state.fx[base]
      const wantsObject = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object')
      if (row) {
        const body = { rate: row.rate, rate_date: row.rateDate }
        await json(route, 200, wantsObject ? body : [body])
      } else {
        await json(
          route,
          wantsObject ? 406 : 200,
          wantsObject ? { code: 'PGRST116', message: 'none' } : [],
        )
      }
      return
    }

    // ── provider prices ────────────────────────────────────────────────────────────────────
    if (url.pathname.endsWith('/functions/v1/search-prices')) {
      const body = JSON.parse(record.body ?? '{}') as { cardIds?: string[] }
      const cardId = body.cardIds?.[0] ?? ''
      if (state.pricesDelayMs > 0) await new Promise((r) => setTimeout(r, state.pricesDelayMs))
      switch (state.pricesMode) {
        case 'http500':
          await json(route, 500, { error: 'server_error' })
          return
        case 'http429':
          await json(route, 429, { error: 'rate_limited' })
          return
        case 'http404':
          await json(route, 404, { error: 'not_found' })
          return
        case 'network':
          await route.abort('failed')
          return
        case 'malformed':
          await json(route, 200, { ok: true, results: 'nope' })
          return
        case 'provider-error':
          await json(route, 200, { ok: true, results: [], providerErrorCount: 1 })
          return
        case 'ok': {
          const card = CARDS.find((c) => c.id === cardId)
          const results = (card?.variants ?? []).map((v) => ({
            cardVariantId: v.id,
            cardId,
            priceState: (state.observations[v.id] ?? []).length > 0 ? 'available' : 'missing',
            provider: state.observations[v.id]?.[0]?.provider ?? null,
            priceKind: state.observations[v.id]?.[0]?.priceKind ?? null,
            sourceCurrency: state.observations[v.id]?.[0]?.sourceCurrency ?? null,
            sourceValueMinor: null,
            valueNokMinor: null,
            providerUpdatedAt: state.observations[v.id]?.[0]?.providerUpdatedAt ?? null,
            observations: state.observations[v.id] ?? [],
          }))
          await json(route, 200, { ok: true, results, providerErrorCount: 0 })
          return
        }
      }
    }

    // Everything else the shell may read (profile, favourites, …): an empty, successful read.
    if (request.method() === 'GET') {
      await json(route, 200, [])
      return
    }
    await json(route, 404, { message: 'not stubbed' })
  })

  return backend
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ALLOWED_POSTS: RegExp[] = [
  /\/rest\/v1\/rpc\/search_cards$/,
  /\/functions\/v1\/search-prices$/,
]

/** Requests that could have changed backend state. Empty means the page only ever read. */
export function mutatingRequests(requests: readonly RequestRecord[]): RequestRecord[] {
  return requests.filter((r) => {
    if (r.path.includes('/rest/v1/rpc/') && !r.path.endsWith('/rpc/search_cards')) return true
    if (READ_METHODS.has(r.method)) return false
    return !ALLOWED_POSTS.some((pattern) => pattern.test(r.path))
  })
}
