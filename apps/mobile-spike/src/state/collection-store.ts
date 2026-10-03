import type { IdentityAuthority } from '../auth/identity-authority'
import type {
  CollectionCounts,
  CollectionCursor,
  CollectionPort,
  CollectionRow,
  CollectionSort,
} from '../collection/types'
import type { Failure } from '../net/failure'
import { runUnderIdentity } from './lease-run'
import { Emitter, type Resettable } from './registry'

/**
 * The collection list. User-scoped: registered with the identity boundary, so its rows are gone the
 * moment the identity changes, and a page still in flight for the previous identity is discarded
 * (`runUnderIdentity`), not merely overwritten later.
 *
 * Paging is keyset (the cursor is the last row the server returned), never offset: rows added while
 * scrolling cannot shift a page. Rows are de-duplicated by `holdingId`, the list's stable key, so a
 * page that overlaps the previous one cannot produce a duplicate key. A newer load supersedes an older
 * one (`seq`), so a slow first page cannot land on top of a refresh.
 */

export interface CollectionState {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  sort: CollectionSort
  rows: readonly CollectionRow[]
  counts: CollectionCounts | null
  countsFailure: Failure | null
  loadingMore: boolean
  done: boolean
  /** Failure of the first page (status 'error') or of a later page (rows stay). */
  failure: Failure | null
}

const INITIAL: CollectionState = {
  status: 'idle',
  sort: 'added_newest',
  rows: [],
  counts: null,
  countsFailure: null,
  loadingMore: false,
  done: false,
  failure: null,
}

export const PAGE_SIZE = 100

export class CollectionStore implements Resettable {
  private state: CollectionState = INITIAL
  private cursor: CollectionCursor = null
  private seq = 0
  private seen = new Set<string>()
  private readonly emitter = new Emitter()

  constructor(
    private readonly port: CollectionPort,
    private readonly authority: IdentityAuthority,
    private readonly pageSize: number = PAGE_SIZE,
  ) {}

  subscribe = this.emitter.subscribe

  getSnapshot = (): CollectionState => this.state

  private set(next: Partial<CollectionState>): void {
    this.state = { ...this.state, ...next }
    this.emitter.emit()
  }

  reset(): void {
    this.state = INITIAL
    this.cursor = null
    this.seen = new Set()
    this.emitter.emit()
  }

  async setSort(sort: CollectionSort): Promise<void> {
    if (sort === this.state.sort && this.state.status !== 'idle') return
    this.state = { ...this.state, sort }
    await this.load()
  }

  /** First page (and the counts). Also the pull-to-refresh and the "Try again" path. */
  async load(): Promise<void> {
    const seq = (this.seq += 1)
    this.cursor = null
    this.seen = new Set()
    this.set({ status: 'loading', rows: [], loadingMore: false, done: false, failure: null })

    const [page, counts] = await Promise.all([
      runUnderIdentity(this.authority, () =>
        this.port.listPage({ sort: this.state.sort, cursor: null, limit: this.pageSize }),
      ),
      runUnderIdentity(this.authority, () => this.port.counts()),
    ])
    if (page.kind === 'stale' || counts.kind === 'stale' || seq !== this.seq) return

    const countsPatch: Partial<CollectionState> =
      counts.kind === 'ok'
        ? { counts: counts.value, countsFailure: null }
        : { counts: null, countsFailure: counts.failure }

    if (page.kind === 'failed') {
      this.set({ ...countsPatch, status: 'error', failure: page.failure })
      return
    }
    const rows = this.append([], page.value.rows)
    this.cursor = page.value.nextCursor
    this.set({
      ...countsPatch,
      status: rows.length === 0 ? 'empty' : 'ready',
      rows,
      done: page.value.nextCursor === null,
    })
  }

  async loadMore(): Promise<void> {
    const s = this.state
    if (s.status !== 'ready' || s.loadingMore || s.done) return
    const seq = this.seq
    this.set({ loadingMore: true, failure: null })
    const outcome = await runUnderIdentity(this.authority, () =>
      this.port.listPage({ sort: s.sort, cursor: this.cursor, limit: this.pageSize }),
    )
    if (outcome.kind === 'stale' || seq !== this.seq) return
    if (outcome.kind === 'failed') {
      this.set({ loadingMore: false, failure: outcome.failure })
      return
    }
    this.cursor = outcome.value.nextCursor
    this.set({
      loadingMore: false,
      rows: this.append(this.state.rows, outcome.value.rows),
      done: outcome.value.nextCursor === null,
    })
  }

  private append(
    existing: readonly CollectionRow[],
    incoming: readonly CollectionRow[],
  ): CollectionRow[] {
    const out = existing.slice()
    for (const row of incoming) {
      if (this.seen.has(row.holdingId)) continue
      this.seen.add(row.holdingId)
      out.push(row)
    }
    return out
  }
}
