import type { AuthClientPort, SessionLike } from '../../src/auth/auth-controller'
import type { KeyValueStore } from '../../src/auth/chunked-session-storage'
import type {
  CollectionPage,
  CollectionPort,
  CollectionRow,
  HoldingDetail,
} from '../../src/collection/types'

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
import { createRuntime, type Runtime } from '../../src/wiring/runtime'
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

export interface Harness {
  runtime: Runtime
  auth: FakeAuth
  collection: FakeCollectionPort
  photo: FakePhotoPort
  removed: () => number
}

/** The real composition root with every I/O dependency replaced by a fake. */
export function harness(
  overrides: { released?: PriceCheckPort; fixture?: PriceCheckPort } = {},
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
    photo,
  })
  runtime.auth.start()
  return { runtime, auth, collection, photo, removed: () => removed }
}

export type { PriceLookup }
