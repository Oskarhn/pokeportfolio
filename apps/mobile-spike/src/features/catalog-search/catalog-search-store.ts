import type { IdentityAuthority } from '../../auth/identity-authority'
import type { Failure } from '../../net/failure'
import { runUnderIdentity } from '../../state/lease-run'
import { Emitter, type Resettable } from '../../state/registry'
import { cardsSharingAName } from '../price-check/p165-domain/price-check/identity'
import type {
  CatalogLanguage,
  CatalogSearchPort,
  SearchHit,
  SearchPage,
} from './catalog-search-port'

/**
 * Manual catalog search: name, set name and/or collector number, typed by a person.
 *
 * - DEBOUNCED: typing schedules one request after `debounceMs` of quiet; submitting (keyboard
 *   "search") runs it at once. Fewer than MIN_QUERY_LENGTH characters never reach the network.
 * - STALE-SAFE: every request carries a sequence number and runs under the identity lease; an answer
 *   for a superseded query, or one that arrives after an identity change, is dropped. The shared
 *   wrapper takes no AbortSignal, so the request itself cannot be aborted, only its answer ignored.
 * - BOUNDED: pages of `pageSize`, at most `maxResults` loaded per query (the person refines the
 *   query instead), a bounded cache of pages keyed by (language, normalised query, offset). The key
 *   never contains anything user-specific, but the cache is still dropped on every identity change.
 * - DEDUPED: `search_cards` orders by (exact number, similarity, name, local_id); two cards with the
 *   same name AND number in different sets tie, so an OFFSET page can repeat or skip one of them.
 *   Loaded hits are de-duplicated by card id (the count of repeats is kept); a skipped tie cannot be
 *   detected client-side, which is recorded as a backend finding, not hidden.
 * - SAME NAME IS NOT SAME CARD: hits whose names match (P165 `cardsSharingAName`) are flagged so the
 *   UI tells the person to check set and number. Nothing is auto-selected, not even a single hit.
 */

export const MIN_QUERY_LENGTH = 2

export interface CatalogSearchOptions {
  readonly debounceMs?: number
  readonly pageSize?: number
  readonly maxResults?: number
  readonly cacheEntries?: number
  readonly schedule?: (fn: () => void, ms: number) => unknown
  readonly cancelSchedule?: (handle: unknown) => void
  readonly onEvent?: (event: CatalogSearchEvent) => void
  readonly now?: () => number
}

export type CatalogSearchEvent =
  | { type: 'search_request'; query: string; offset: number; ms: number; outcome: 'ok' | 'error' }
  | { type: 'search_cache_hit'; key: string }
  | { type: 'search_dropped_stale'; query: string }
  | { type: 'search_deduped'; count: number }

export interface SearchHitView extends SearchHit {
  /** Another loaded hit has the same name: set and number are what tell them apart. */
  readonly sharesName: boolean
}

export interface CatalogSearchState {
  /** Draft: what the person typed (kept across a same-user token refresh). */
  readonly query: string
  readonly language: CatalogLanguage | null
  readonly status: 'idle' | 'pending' | 'loading' | 'ready' | 'empty' | 'error'
  /** The normalised query the hits belong to. */
  readonly resultsFor: string | null
  readonly hits: readonly SearchHitView[]
  readonly totalCount: number
  readonly loadingMore: boolean
  readonly reachedLimit: boolean
  readonly failure: Failure | null
  readonly moreFailure: Failure | null
}

const INITIAL: CatalogSearchState = {
  query: '',
  language: null,
  status: 'idle',
  resultsFor: null,
  hits: [],
  totalCount: 0,
  loadingMore: false,
  reachedLimit: false,
  failure: null,
  moreFailure: null,
}

export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ')
}

export function searchCacheKey(
  language: CatalogLanguage | null,
  query: string,
  offset: number,
): string {
  return `${language ?? '*'}|${normaliseQuery(query).toLocaleLowerCase('en')}|${String(offset)}`
}

function withSharedNames(hits: readonly SearchHit[]): SearchHitView[] {
  const shared = cardsSharingAName(hits)
  return hits.map((h) => ({ ...h, sharesName: shared.has(h.cardId) }))
}

export class CatalogSearchStore implements Resettable {
  private state: CatalogSearchState = INITIAL
  private seq = 0
  private timer: unknown = null
  /** Next server offset (can differ from hits.length when duplicates were dropped). */
  private nextOffset = 0
  private readonly cache = new Map<string, SearchPage>()
  private readonly emitter = new Emitter()
  private readonly opts: Required<Omit<CatalogSearchOptions, 'onEvent'>> &
    Pick<CatalogSearchOptions, 'onEvent'>

  constructor(
    private readonly port: CatalogSearchPort,
    private readonly authority: IdentityAuthority,
    options: CatalogSearchOptions = {},
  ) {
    this.opts = {
      debounceMs: options.debounceMs ?? 300,
      pageSize: options.pageSize ?? 25,
      maxResults: options.maxResults ?? 200,
      cacheEntries: options.cacheEntries ?? 30,
      schedule: options.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
      cancelSchedule:
        options.cancelSchedule ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      now: options.now ?? Date.now,
      onEvent: options.onEvent,
    }
  }

  subscribe = this.emitter.subscribe
  getSnapshot = (): CatalogSearchState => this.state

  private set(next: CatalogSearchState): void {
    this.state = next
    this.emitter.emit()
  }

  private clearTimer(): void {
    if (this.timer !== null) this.opts.cancelSchedule(this.timer)
    this.timer = null
  }

  /** Identity boundary: drops drafts, results, cache and any pending request, synchronously. */
  reset(): void {
    this.clearTimer()
    this.seq += 1
    this.nextOffset = 0
    this.cache.clear()
    this.set(INITIAL)
  }

  setQuery(text: string): void {
    this.clearTimer()
    const q = normaliseQuery(text)
    if (q.length < MIN_QUERY_LENGTH) {
      this.seq += 1
      this.set({ ...INITIAL, query: text, language: this.state.language })
      return
    }
    this.set({ ...this.state, query: text, status: 'pending' })
    this.timer = this.opts.schedule(() => {
      this.timer = null
      void this.run()
    }, this.opts.debounceMs)
  }

  setLanguage(language: CatalogLanguage | null): void {
    if (language === this.state.language) return
    this.set({ ...this.state, language })
    if (normaliseQuery(this.state.query).length >= MIN_QUERY_LENGTH) void this.submit()
  }

  /** Keyboard "search" / explicit button: run now, no debounce. */
  async submit(): Promise<void> {
    this.clearTimer()
    await this.run()
  }

  private rememberPage(key: string, page: SearchPage): void {
    this.cache.delete(key)
    this.cache.set(key, page)
    while (this.cache.size > this.opts.cacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async fetchPage(
    query: string,
    offset: number,
  ): Promise<
    { kind: 'ok'; page: SearchPage } | { kind: 'stale' } | { kind: 'failed'; failure: Failure }
  > {
    const key = searchCacheKey(this.state.language, query, offset)
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.opts.onEvent?.({ type: 'search_cache_hit', key })
      return { kind: 'ok', page: cached }
    }
    const language = this.state.language
    const started = this.opts.now()
    const outcome = await runUnderIdentity(this.authority, () =>
      this.port.searchPage({ query, language, offset, limit: this.opts.pageSize }),
    )
    const ms = this.opts.now() - started
    if (outcome.kind === 'stale') return { kind: 'stale' }
    if (outcome.kind === 'failed') {
      this.opts.onEvent?.({ type: 'search_request', query, offset, ms, outcome: 'error' })
      return { kind: 'failed', failure: outcome.failure }
    }
    this.opts.onEvent?.({ type: 'search_request', query, offset, ms, outcome: 'ok' })
    this.rememberPage(key, outcome.value)
    return { kind: 'ok', page: outcome.value }
  }

  private async run(): Promise<void> {
    const query = normaliseQuery(this.state.query)
    if (query.length < MIN_QUERY_LENGTH) return
    const seq = (this.seq += 1)
    this.set({ ...this.state, status: 'loading', failure: null, moreFailure: null })
    const result = await this.fetchPage(query, 0)
    if (result.kind === 'stale' || seq !== this.seq) {
      this.opts.onEvent?.({ type: 'search_dropped_stale', query })
      return
    }
    if (result.kind === 'failed') {
      this.set({
        ...this.state,
        status: 'error',
        failure: result.failure,
        resultsFor: query,
        hits: [],
        totalCount: 0,
      })
      return
    }
    const hits = this.dedupe([], result.page.hits)
    this.nextOffset = result.page.hits.length
    this.set({
      ...this.state,
      status: hits.length === 0 ? 'empty' : 'ready',
      resultsFor: query,
      hits: withSharedNames(hits),
      totalCount: result.page.totalCount,
      reachedLimit: hits.length >= this.opts.maxResults,
      loadingMore: false,
      failure: null,
    })
  }

  private dedupe(existing: readonly SearchHit[], incoming: readonly SearchHit[]): SearchHit[] {
    const seen = new Set(existing.map((h) => h.cardId))
    const out = [...existing]
    let repeats = 0
    for (const hit of incoming) {
      if (seen.has(hit.cardId)) {
        repeats += 1
        continue
      }
      seen.add(hit.cardId)
      out.push(hit)
    }
    if (repeats > 0) this.opts.onEvent?.({ type: 'search_deduped', count: repeats })
    return out
  }

  get canLoadMore(): boolean {
    const s = this.state
    return (
      s.status === 'ready' && !s.loadingMore && !s.reachedLimit && this.nextOffset < s.totalCount
    )
  }

  async loadMore(): Promise<void> {
    if (!this.canLoadMore || this.state.resultsFor === null) return
    const seq = this.seq
    const query = this.state.resultsFor
    this.set({ ...this.state, loadingMore: true, moreFailure: null })
    const result = await this.fetchPage(query, this.nextOffset)
    if (result.kind === 'stale' || seq !== this.seq) {
      this.opts.onEvent?.({ type: 'search_dropped_stale', query })
      return
    }
    if (result.kind === 'failed') {
      this.set({ ...this.state, loadingMore: false, moreFailure: result.failure })
      return
    }
    const hits = this.dedupe(this.state.hits, result.page.hits).slice(0, this.opts.maxResults)
    this.nextOffset += result.page.hits.length
    this.set({
      ...this.state,
      hits: withSharedNames(hits),
      totalCount: result.page.totalCount,
      loadingMore: false,
      reachedLimit: hits.length >= this.opts.maxResults,
    })
  }
}
