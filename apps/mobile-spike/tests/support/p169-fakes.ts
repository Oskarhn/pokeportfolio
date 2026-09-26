import type { P169Feature } from '../../src/features/feature'
import type {
  CatalogSearchPort,
  SearchHit,
  SearchPage,
} from '../../src/features/catalog-search/catalog-search-port'
import type { FxRateReader } from '../../src/features/price-check/fx-source'
import type { CardWithVariants } from '../../src/features/price-check/price-check-flow-store'
import type { SearchPricesInvoker } from '../../src/features/price-check/search-prices-source'
import type { SnapshotPoint } from '../../src/features/price-check/snapshot-source'
import type {
  CardIdentity,
  VariantIdentity,
} from '../../src/features/price-check/p165-domain/price-check/types'
import { deferred, harness, type Deferred } from './fakes'

/** Test doubles for P169. Everything synthetic; nothing reaches a network. */

export const NOW = Date.parse('2026-09-25T12:00:00Z')
export const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString()

export function card(id: string, overrides: Partial<CardIdentity> = {}): CardIdentity {
  return {
    cardId: id,
    name: `Card ${id}`,
    setId: `set-${id}`,
    setName: `Set ${id}`,
    collectorNumber: '001',
    language: 'en',
    imageBaseUrl: null,
    rarity: null,
    illustrator: null,
    ...overrides,
  }
}

export function variant(id: string, overrides: Partial<VariantIdentity> = {}): VariantIdentity {
  return {
    variantId: id,
    finish: 'normal',
    stamp: '',
    subtype: '',
    size: 'standard',
    isActive: true,
    ...overrides,
  }
}

export function obs(
  provider: 'tcgdex_cardmarket' | 'tcgdex_tcgplayer',
  valueMinor: unknown,
  updated: string | null = daysAgo(0),
  extra: Record<string, unknown> = {},
) {
  return {
    provider,
    priceKind: provider === 'tcgdex_cardmarket' ? 'cm_trend' : 'tp_market',
    sourceCurrency: provider === 'tcgdex_cardmarket' ? 'EUR' : 'USD',
    valueMinor,
    providerUpdatedAt: updated,
    ...extra,
  }
}

/** A search-prices body: rows for the given variant ids, each with `observations`. */
export function body(rows: Record<string, unknown[] | undefined>, providerErrorCount = 0) {
  return {
    ok: true,
    providerErrorCount,
    results: Object.entries(rows).map(([cardVariantId, observations]) =>
      observations === undefined ? { cardVariantId } : { cardVariantId, observations },
    ),
  }
}

type InvokeResult = Awaited<ReturnType<SearchPricesInvoker>>

/** Scriptable `supabase.functions.invoke('search-prices', …)`. */
export class FakeInvoker {
  calls: { cardIds: string[]; signal: AbortSignal | undefined }[] = []
  byCard = new Map<string, InvokeResult>()
  pending: Deferred<InvokeResult>[] = []

  invoke: SearchPricesInvoker = (_name, options) => {
    this.calls.push({ cardIds: options.body.cardIds, signal: options.signal })
    const next = this.pending.shift()
    if (next !== undefined) return next.promise
    const found = this.byCard.get(options.body.cardIds[0] ?? '')
    return Promise.resolve(found ?? { data: body({}), error: null })
  }

  answer(cardId: string, data: unknown): void {
    this.byCard.set(cardId, { data, error: null })
  }

  fail(cardId: string, error: unknown): void {
    this.byCard.set(cardId, { data: null, error })
  }

  hold(): Deferred<InvokeResult> {
    const d = deferred<InvokeResult>()
    this.pending.push(d)
    return d
  }
}

export function fakeFx(
  rates: Record<string, { rate: unknown; rate_date: unknown } | 'error'>,
): FxRateReader & { calls: string[] } {
  const calls: string[] = []
  const reader = ((currency: string) => {
    calls.push(currency)
    const r = rates[currency]
    if (r === 'error') return Promise.resolve({ data: null, error: { message: 'boom' } })
    return Promise.resolve({ data: r ?? null, error: null })
  }) as FxRateReader & { calls: string[] }
  reader.calls = calls
  return reader
}

export const STANDARD_FX = {
  EUR: { rate: 11.5, rate_date: '2026-09-25' },
  USD: { rate: 10.5, rate_date: '2026-09-25' },
} as const

export class FakeCatalog implements CatalogSearchPort {
  calls: { query: string; language: string | null; offset: number; limit: number }[] = []
  pending: Deferred<SearchPage>[] = []
  corpus: SearchHit[] = []

  searchPage(params: {
    query: string
    language: 'en' | 'ja' | null
    offset: number
    limit: number
  }): Promise<SearchPage> {
    this.calls.push(params)
    const next = this.pending.shift()
    if (next !== undefined) return next.promise
    const q = params.query.toLowerCase()
    const all = this.corpus.filter(
      (h) =>
        (params.language === null || h.language === params.language) &&
        (h.name.toLowerCase().includes(q) || h.setName.toLowerCase().includes(q)),
    )
    return Promise.resolve({
      hits: all.slice(params.offset, params.offset + params.limit),
      totalCount: all.length,
    })
  }
}

export function hit(id: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    cardId: id,
    name: `Card ${id}`,
    setId: `set-${id}`,
    setName: `Set ${id}`,
    collectorNumber: '001',
    language: 'en',
    rarity: null,
    activeVariantCount: 1,
    ...overrides,
  }
}

export interface P169Harness extends ReturnType<typeof harness> {
  feature: P169Feature
  invoker: FakeInvoker
  catalog: FakeCatalog
  cards: Map<string, CardWithVariants>
  cardReads: Deferred<CardWithVariants | null>[]
  snapshots: Map<string, SnapshotPoint[]>
  fx: ReturnType<typeof fakeFx>
}

export function p169Harness(
  options: { fx?: Parameters<typeof fakeFx>[0]; now?: () => number } = {},
): P169Harness {
  const invoker = new FakeInvoker()
  const catalog = new FakeCatalog()
  const cards = new Map<string, CardWithVariants>()
  const cardReads: Deferred<CardWithVariants | null>[] = []
  const snapshots = new Map<string, SnapshotPoint[]>()
  const fx = fakeFx(options.fx ?? STANDARD_FX)
  // ONE runtime: the feature is created by the composition root, over these fakes.
  const base = harness({
    priceFeature: {
      invoke: invoker.invoke,
      readFx: fx,
      catalog,
      readCard: (id) => cardReads.shift()?.promise ?? Promise.resolve(cards.get(id) ?? null),
      readSnapshots: (variantId) => Promise.resolve(snapshots.get(variantId) ?? []),
      now: options.now ?? (() => NOW),
      // Debounce runs as a microtask in tests, so `await flush()` settles it (a cancelled handle never fires).
      searchOptions: {
        debounceMs: 0,
        schedule: (fn) => {
          const handle = { cancelled: false }
          queueMicrotask(() => {
            if (!handle.cancelled) fn()
          })
          return handle
        },
        cancelSchedule: (handle) => {
          ;(handle as { cancelled: boolean }).cancelled = true
        },
      },
    },
  })
  return {
    ...base,
    feature: base.runtime.feature,
    invoker,
    catalog,
    cards,
    cardReads,
    snapshots,
    fx,
  }
}
