import type { AuthClientPort, SessionLike } from '../../src/auth/auth-controller'
import type { KeyValueStore } from '../../src/auth/chunked-session-storage'
import type {
  CollectionPage,
  CollectionPort,
  CollectionRow,
  HoldingDetail,
} from '../../src/collection/types'
import type { LeasedWriteDb } from '../../src/write/leased-write-client'
import { PendingWriteJournal } from '../../src/write/pending-write-journal'
import type { ExistsCheckerMap } from '../../src/write/pending-write-reconciliation'
import type { WriteDbBinder } from '../../src/write/write-db'

/** Never finds anything settled — tests that need a real reconciliation outcome build their own
 *  checkers; every other test's pending writes simply stay "unresolved" if it ever records one. */
const INERT_PENDING_WRITES: ExistsCheckerMap = {
  create_purchase: () => Promise.resolve(false),
  create_sale: () => Promise.resolve(false),
}

/** A write-db binder for tests that do not exercise a real (or scripted) write RPC call: any
 *  attempt to actually USE the returned "client" fails loudly instead of silently no-op'ing. */
export function fakeWriteDbBinder(): WriteDbBinder {
  return () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`unexpected use of the fake write client: .${String(prop)}`)
        },
      },
    ) as LeasedWriteDb
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

/** Lets pending promise continuations run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

export function session(userId: string, email = `${userId}@example.invalid`): SessionLike {
  return { user: { id: userId, email } }
}

type Listener = (event: string, session: SessionLike | null) => void

/** A scriptable stand-in for supabase.auth: tests drive the events supabase-js would emit. */
export class FakeAuth implements AuthClientPort {
  listeners = new Set<Listener>()
  current: SessionLike | null = null
  signOutCalls: { scope?: string | undefined }[] = []
  signOutError: { message: string; name?: string } | null = null
  signInError: { message: string; status?: number } | null = null
  getSessionResult: {
    session: SessionLike | null
    error: { message: string; name?: string } | null
  } = {
    session: null,
    error: null,
  }

  onAuthStateChange(callback: Listener) {
    this.listeners.add(callback)
    return { data: { subscription: { unsubscribe: () => void this.listeners.delete(callback) } } }
  }

  emit(event: string, next: SessionLike | null): void {
    this.current = next
    for (const l of [...this.listeners]) l(event, next)
  }

  signInWithPassword(credentials: { email: string; password: string }) {
    if (this.signInError !== null) {
      return Promise.resolve({ data: { session: null }, error: this.signInError })
    }
    const next = session(credentials.email.split('@')[0] ?? 'user', credentials.email)
    this.emit('SIGNED_IN', next)
    return Promise.resolve({ data: { session: next }, error: null })
  }

  signOut(options?: { scope?: 'global' | 'local' | 'others' }) {
    this.signOutCalls.push({ scope: options?.scope })
    if (this.signOutError !== null) return Promise.resolve({ error: this.signOutError })
    this.emit('SIGNED_OUT', null)
    return Promise.resolve({ error: null })
  }

  getSession() {
    return Promise.resolve({
      data: { session: this.getSessionResult.session },
      error: this.getSessionResult.error,
    })
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  data = new Map<string, string>()
  constructor(private readonly maxValueBytes = Infinity) {}

  getItemAsync(key: string) {
    return Promise.resolve(this.data.get(key) ?? null)
  }

  setItemAsync(key: string, value: string) {
    if (Buffer.byteLength(value, 'utf8') > this.maxValueBytes) {
      return Promise.reject(new Error('value too large for the secure store'))
    }
    this.data.set(key, value)
    return Promise.resolve()
  }

  deleteItemAsync(key: string) {
    this.data.delete(key)
    return Promise.resolve()
  }
}

export function row(id: string, overrides: Partial<CollectionRow> = {}): CollectionRow {
  return {
    holdingId: id,
    holdingKind: 'raw_card',
    title: `Card ${id}`,
    subtitle: 'Set · #1',
    quantity: 1,
    holdingValueMinor: null,
    priceState: 'missing',
    cardVariantId: `variant-${id}`,
    ...overrides,
  }
}

export function detail(id: string, overrides: Partial<HoldingDetail> = {}): HoldingDetail {
  return {
    holdingId: id,
    title: `Card ${id}`,
    subtitle: 'Set · #1',
    quantity: 1,
    lotCount: 1,
    finish: 'normal',
    condition: 'NM',
    cardVariantId: `variant-${id}`,
    priceState: 'missing',
    unitValueMinor: null,
    holdingValueMinor: null,
    provider: null,
    sourceCurrency: null,
    sourceValueMinor: null,
    snapshotDate: null,
    providerUpdatedAt: null,
    ...overrides,
  }
}

/** A collection port whose calls the test controls. */
export class FakeCollectionPort implements CollectionPort {
  pages: CollectionPage[] = []
  listCalls: { cursor: unknown; limit: number; sort: string }[] = []
  pending: Deferred<CollectionPage>[] = []
  countsResult: Awaited<ReturnType<CollectionPort['counts']>> = {
    uniqueHoldingCount: 0,
    physicalCardCount: 0,
    pricedHoldingCount: 0,
    unpricedHoldingCount: 0,
    portfolioValueMinor: 0n,
  }
  countsError: unknown = null
  details = new Map<string, HoldingDetail | null>()
  detailPending = new Map<string, Deferred<HoldingDetail | null>>()
  listError: unknown = null

  listPage(input: { sort: 'added_newest' | 'value_desc'; cursor: unknown; limit: number }) {
    this.listCalls.push(input)
    if (this.listError !== null) return Promise.reject(asError(this.listError))
    const d = this.pending.shift()
    if (d !== undefined) return d.promise
    return Promise.resolve(this.pages.shift() ?? { rows: [], nextCursor: null })
  }

  counts() {
    if (this.countsError !== null) return Promise.reject(asError(this.countsError))
    return Promise.resolve(this.countsResult)
  }

  getDetail(holdingId: string) {
    const d = this.detailPending.get(holdingId)
    if (d !== undefined) return d.promise
    return Promise.resolve(this.details.get(holdingId) ?? null)
  }
}

import type { PhotoOutcome, PhotoPort } from '../../src/photo/photo-store'
import type { PriceCheckPort, PriceLookup } from '../../src/price-check/types'
import { createRuntime, type PriceFeatureDeps, type Runtime } from '../../src/wiring/runtime'
import { createFixturePriceCheckPort } from '../../src/price-check/fixture-adapter'

export class FakePhotoPort implements PhotoPort {
  outcome: PhotoOutcome = { status: 'cancelled' }
  pending: Deferred<PhotoOutcome> | null = null
  deleted: string[] = []
  deleteError = false
  acquire(): Promise<PhotoOutcome> {
    return this.pending !== null ? this.pending.promise : Promise.resolve(this.outcome)
  }
  deleteFile(uri: string): Promise<void> {
    if (this.deleteError) return Promise.reject(new Error('cannot delete'))
    this.deleted.push(uri)
    return Promise.resolve()
  }
  purges = 0
  purgeError = false
  purgeOwnedCache(): Promise<number> {
    if (this.purgeError) return Promise.reject(new Error('cannot purge'))
    this.purges += 1
    return Promise.resolve(0)
  }
}

/** Search / Price Check wired to nothing: any call is a test that forgot to fake it. */
const INERT_PRICE_FEATURE: PriceFeatureDeps = {
  invoke: () => Promise.reject(new Error('search-prices is not faked in this harness')),
  readFx: () => Promise.reject(new Error('fx is not faked in this harness')),
}

export interface Harness {
  runtime: Runtime
  auth: FakeAuth
  collection: FakeCollectionPort
  photo: FakePhotoPort
  removed: () => number
}

/** The real composition root with every I/O dependency replaced by a fake. */
export function harness(
  overrides: {
    released?: PriceCheckPort
    fixture?: PriceCheckPort
    priceFeature?: PriceFeatureDeps
  } = {},
): Harness {
  const auth = new FakeAuth()
  const collection = new FakeCollectionPort()
  const photo = new FakePhotoPort()
  let removed = 0
  const fixture = overrides.fixture ?? createFixturePriceCheckPort()
  const runtime = createRuntime({
    auth,
    removeStoredSession: () => {
      removed += 1
      return Promise.resolve()
    },
    collection,
    priceCheck: { released: overrides.released ?? fixture, fixture },
    priceFeature: overrides.priceFeature ?? INERT_PRICE_FEATURE,
    readFx: overrides.priceFeature?.readFx ?? INERT_PRICE_FEATURE.readFx,
    photo,
    writeDb: fakeWriteDbBinder(),
    pendingWrites: {
      journal: new PendingWriteJournal(new MemoryKeyValueStore()),
      existsCheckers: INERT_PENDING_WRITES,
    },
  })
  runtime.auth.start()
  return { runtime, auth, collection, photo, removed: () => removed }
}

export type { PriceLookup }
