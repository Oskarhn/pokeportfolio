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

/** P151: a response an ASSET request must never legitimately receive and must never be cached.
 *  A captive portal (public Wi-Fi at a card shop or convention), a proxy error page or an SPA
 *  fallback answers an asset URL with `200 text/html`. Cached, it would be served for the rest of
 *  that generation's life: the index checksum fails every session and the visual channel stays
 *  unavailable until the user clears site data. */
function isHtmlResponse(response: Response): boolean {
  return /^\s*text\/html/i.test(response.headers.get('content-type') ?? '')
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
  /** Deletes every cached entry whose URL satisfies `shouldEvict` (P151: prune superseded index
   *  generations, purge a generation that failed its integrity check). Returns the evicted URLs.
   *  Never throws — an unavailable or failing cache simply evicts nothing. */
  evict(shouldEvict: (url: string) => boolean): Promise<string[]>
}

/** True for an entry of ANY index generation other than `contentId` under `indexBase`
 *  (`<indexBase>/generations/<id>/...`). Everything else — including the model/runtime files, should
 *  an engine route them through the patched fetch — is left alone. */
export function isSupersededIndexGeneration(
  url: string,
  indexBase: string,
  contentId: string,
): boolean {
  const path = pathnameOf(url)
  const generations = `${indexBase}/generations/`
  return path.startsWith(generations) && !path.startsWith(`${generations}${contentId}/`)
}

/** True for an entry of exactly the generation `contentId`. */
export function isIndexGeneration(url: string, indexBase: string, contentId: string): boolean {
  return pathnameOf(url).startsWith(`${indexBase}/generations/${contentId}/`)
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, 'https://cache.invalid').pathname
  } catch {
    return url
  }
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
      // P122 (resolving the P119-disclosed gap): `cache.match()` rejecting degrades to a plain
      // network fetch, exactly like `caches.open()` rejecting already does above — this module's
      // own interface doc (`CacheThroughFetch.fetch`, this file) already promised "any cache-layer
      // failure (open/match/put rejecting) degrades to a plain network fetch rather than ever
      // failing the request itself"; leaving `match()` unwrapped was a gap against that stated
      // contract, not a deliberate design choice — CacheStorage is an optimization layer here, and
      // its corruption/unavailability must never prevent a scan whose network path is healthy
      // (prompt §36 posture: "a missing optimization is never an error", already applied to
      // `open()`/`put()` in this same function). A well-formed cache HIT still returns exactly as
      // before; only a rejection changes behavior.
      let cached: Response | undefined
      try {
        cached = await cache.match(input)
      } catch {
        cached = undefined
      }
      if (cached !== undefined && isHtmlResponse(cached)) {
        // A poisoned entry written before this guard existed (or by another engine): drop it and
        // fall through to the network so the device self-heals on the next load.
        void cache.delete(input).catch(() => {})
        cached = undefined
      }
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
      response.status === 200 &&
      !isHtmlResponse(response)
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
    evict: async (shouldEvict) => {
      const cache = await getCache()
      if (cache === null) return []
      const evicted: string[] = []
      try {
        for (const request of await cache.keys()) {
          if (!shouldEvict(request.url)) continue
          const deleted = await cache.delete(request).catch(() => false)
          if (deleted) evicted.push(request.url)
        }
      } catch {
        // keys() failing means nothing more can be evicted right now; never surface it.
      }
      return evicted
    },
  }
}
