/**
 * P119 §17: the visual worker's own Cache-Storage cache-through mechanics
 * (`installFetchProbe`/`getWorkerAssetCache` in visual-worker.ts, P81 §8), extracted into a small,
 * dependency-injected module so its fault behavior (cache unavailable, `open`/`match`/`put`
 * rejecting, a malformed cached/network response) is unit-testable without a real Worker or
 * browser Cache Storage implementation at all.
 *
 * DELIBERATELY NOT a redesign: production still needs `self.fetch` itself reassigned globally,
 * because transformers.js/onnxruntime-web issue their OWN fetches internally (their own call
 * sites, not ours) and the only way to intercept THOSE is a global monkeypatch — see
 * visual-worker.ts's own installFetchProbe for that wiring, which is the only thing left there.
 * Everything this module exports is the pure DECISION logic (cache lookup, classification, write-
 * back) that monkeypatch delegates to, taking real or fake primitives as plain parameters instead
 * of reading `self.fetch`/`caches` out of module-global scope — that's the entire seam this file
 * buys: production passes the real ones, tests pass deterministic fakes.
 */
import { classifyVisualAssetUrl, type RecordedFetch } from './phase-timing'

export interface CacheThroughDeps {
  /** The real, unpatched fetch to fall through to on a cache miss or bypass. */
  realFetch: typeof fetch
  /** Opens (or creates) the named Cache Storage entry. `undefined` when Cache Storage itself is
   *  unavailable in this environment — the caller's own `typeof caches === 'undefined'` check. */
  cachesOpen: ((cacheName: string) => Promise<Cache>) | undefined
  cacheName: string
}

export interface CacheThroughFetch {
  /** Drop-in replacement for `fetch` carrying the exact cache-through semantics described in
   *  visual-worker.ts's own module doc: a `cache: 'no-store'` request bypasses BOTH the HTTP
   *  cache and this cache-through layer; every other successful (200, ok) GET response is written
   *  back for next time; any cache-layer failure (open/match/put rejecting) degrades to a plain
   *  network fetch rather than ever failing the request itself. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  getLog(): RecordedFetch[]
  resetLog(): void
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export function createCacheThroughFetch(deps: CacheThroughDeps): CacheThroughFetch {
  let fetchLog: RecordedFetch[] = []
  let workerAssetCache: Cache | null = null

  async function getCache(): Promise<Cache | null> {
    if (workerAssetCache !== null) return workerAssetCache
    if (deps.cachesOpen === undefined) return null
    try {
      workerAssetCache = await deps.cachesOpen(deps.cacheName)
      return workerAssetCache
    } catch {
      // Cache Storage can be unavailable (private-mode quirks, quota) — the caller still gets a
      // plain network fetch, never a hard failure (prompt §36 posture: a missing optimization is
      // never an error). Matches the ORIGINAL behavior exactly: retried on the next call too, not
      // latched, since a transient quota condition can clear.
      return null
    }
  }

  async function cachedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = requestUrl(input)
    const start = performance.now()
    const bypassCache = init?.cache === 'no-store'
    // The real Cache Storage API throws a TypeError from `cache.put()` for any non-GET request
    // (spec requirement) — P119's fault matrix caught this module's write-back check omitting
    // the same GET guard the read (`match`) check already had, meaning a hypothetical non-GET
    // response here would have silently attempted (and, only via the catch below, survived) an
    // operation a real browser rejects outright. Computed once and shared by both checks so they
    // can never drift apart again.
    const isCacheableRequest =
      init === undefined || init.method === undefined || init.method === 'GET'
    const cache = bypassCache ? null : await getCache()
    if (cache !== null && isCacheableRequest) {
      // FAITHFUL to the pre-extraction behavior (visual-worker.ts's original installFetchProbe):
      // NOT wrapped in try/catch here. Whether a rejecting `cache.match` should degrade
      // gracefully to a network fetch, like a rejecting `caches.open` already does, or whether
      // that gap is itself a real bug, is exactly what P119's cache-fault-matrix tests against
      // this module are for — deciding that by testing it, not by silently changing behavior
      // during what is meant to be a pure extraction.
      const cached = await cache.match(input)
      if (cached !== undefined) {
        const ms = performance.now() - start
        const bytesHeader = cached.headers.get('content-length')
        fetchLog.push({
          phase: classifyVisualAssetUrl(url),
          ms,
          bytes: bytesHeader !== null ? Number(bytesHeader) : null,
        })
        return cached
      }
    }
    const response = await deps.realFetch(input, init)
    const ms = performance.now() - start
    const bytesHeader = response.headers.get('content-length')
    fetchLog.push({
      phase: classifyVisualAssetUrl(url),
      ms,
      bytes: bytesHeader !== null ? Number(bytesHeader) : null,
    })
    if (
      !bypassCache &&
      cache !== null &&
      isCacheableRequest &&
      response.ok &&
      response.status === 200
    ) {
      const toCache = response.clone()
      void cache.put(input, toCache).catch(() => {
        // Quota/opaque-response failures never block the real response reaching the caller.
      })
    }
    return response
  }

  return {
    fetch: cachedFetch,
    getLog: () => fetchLog,
    resetLog: () => {
      fetchLog = []
    },
  }
}
