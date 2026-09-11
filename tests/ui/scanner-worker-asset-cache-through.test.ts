import { describe, expect, it, vi } from 'vitest'
import { createCacheThroughFetch } from '../../src/features/scanner/visual/worker-asset-cache-through'

/**
 * P119 §17/§18: fault matrix for the visual worker's own Cache-Storage cache-through layer,
 * against the extracted, dependency-injected `createCacheThroughFetch` — P116 explicitly deferred
 * this because the worker's real Cache Storage calls happen inside a dynamically-created
 * dedicated Worker's own global scope, unreachable by Playwright's `page.addInitScript()`. The
 * extraction (this session) removes that obstacle entirely: every case below runs as a plain,
 * fast, deterministic Node/vitest unit test, no browser or real Worker involved.
 *
 * A minimal fake `Cache` is used throughout — only `open`/`match`/`put`, the three methods this
 * module actually calls.
 */

function fakeResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, { status: 200, ...init })
}

interface FakeCacheBehavior {
  openRejects?: boolean
  matchRejects?: boolean
  matchReturns?: Response | undefined
  putRejects?: boolean
}

function makeFakeCachesOpen(
  behavior: FakeCacheBehavior,
  putCalls: unknown[][],
): (cacheName: string) => Promise<Cache> {
  return function fakeCachesOpen(): Promise<Cache> {
    if (behavior.openRejects) return Promise.reject(new Error('caches.open rejected (mock)'))
    const fakeCache = {
      match(...args: unknown[]): Promise<Response | undefined> {
        if (behavior.matchRejects) return Promise.reject(new Error('cache.match rejected (mock)'))
        void args
        return Promise.resolve(behavior.matchReturns)
      },
      put(...args: unknown[]): Promise<void> {
        putCalls.push(args)
        if (behavior.putRejects) return Promise.reject(new Error('cache.put rejected (mock)'))
        return Promise.resolve()
      },
    }
    return Promise.resolve(fakeCache as unknown as Cache)
  }
}

describe('worker-asset-cache-through fault matrix (P119 §18)', () => {
  it('caches unavailable (cachesOpen undefined): fetch still works, no cache interaction attempted', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('ok'))
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: undefined,
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(await response.text()).toBe('ok')
    expect(realFetch).toHaveBeenCalledTimes(1)
  })

  it('caches.open rejects: degrades to a plain network fetch, never throws', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('ok'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ openRejects: true }, putCalls),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(await response.text()).toBe('ok')
    expect(realFetch).toHaveBeenCalledTimes(1)
    // No cache to put into after a failed open — nothing attempted.
    expect(putCalls).toHaveLength(0)
  })

  it('caches.open rejects repeatedly: every subsequent call re-attempts open rather than latching a permanent failure (matches original pre-extraction behavior)', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('ok'))
    let openAttempts = 0
    function cachesOpen(): Promise<Cache> {
      openAttempts += 1
      return Promise.reject(new Error('always rejects (mock)'))
    }
    const instance = createCacheThroughFetch({ realFetch, cachesOpen, cacheName: 'test-cache' })
    await instance.fetch('/a')
    await instance.fetch('/b')
    expect(openAttempts).toBe(2)
    expect(realFetch).toHaveBeenCalledTimes(2)
  })

  it('cache hit: the network is never called at all', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('network'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: fakeResponse('cached') }, putCalls),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(await response.text()).toBe('cached')
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('cache miss: fetches the network and writes the response back for next time', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('fresh'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: undefined }, putCalls),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(await response.text()).toBe('fresh')
    expect(realFetch).toHaveBeenCalledTimes(1)
    // put() is fire-and-forget (`void cache.put(...).catch(...)`) — give its microtask a tick.
    await vi.waitFor(() => {
      expect(putCalls).toHaveLength(1)
    })
  })

  it('cache.put rejects: the real response still reaches the caller (write-back failure is not caller-visible)', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('fresh'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: undefined, putRejects: true }, putCalls),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fresh')
  })

  it('cache.match rejects on a GET: PROPAGATES rather than degrading to network — a real gap inherited unchanged from the pre-extraction code, not introduced by this refactor', async () => {
    // This is the one case this fault matrix EXISTS to characterize honestly rather than assume:
    // `caches.open` rejecting was already handled gracefully (try/catch in getCache()), but
    // `cache.match` rejecting was never wrapped either before or after this extraction — proven
    // here rather than asserted from reading the source alone. See this test file's own header
    // and worker-asset-cache-through.ts's `cachedFetch` comment for the disposition: flagged as a
    // real, disclosed gap (not silently patched over during what was meant to be a pure
    // extraction), left for a follow-up decision rather than fixed in the same commit as the
    // extraction itself.
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('network'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchRejects: true }, putCalls),
      cacheName: 'test-cache',
    })
    await expect(instance.fetch('/scanner-assets/visual-v1/model/config.json')).rejects.toThrow(
      'cache.match rejected (mock)',
    )
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('no-store bypasses BOTH the cache lookup and the write-back, even on a cache hit that would otherwise have served', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('network-authoritative'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: fakeResponse('stale-cached') }, putCalls),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/index/current.json', {
      cache: 'no-store',
    })
    expect(await response.text()).toBe('network-authoritative')
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(putCalls).toHaveLength(0)
  })

  it('a non-GET request (POST) is never served from or written to the cache', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('posted'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen(
        { matchReturns: fakeResponse('should-never-be-used') },
        putCalls,
      ),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/some/endpoint', { method: 'POST' })
    expect(await response.text()).toBe('posted')
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(putCalls).toHaveLength(0)
  })

  it('a non-ok network response (404/500) is never written to the cache', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('not found', { status: 404 }))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: undefined }, putCalls),
      cacheName: 'test-cache',
    })
    const response = await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(response.status).toBe(404)
    // Give any (incorrect) fire-and-forget put() a chance to have run before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(putCalls).toHaveLength(0)
  })

  it('a real network rejection (offline/timeout) propagates — the caller (loadIndex) already treats a rejected fetch as "index unavailable"', async () => {
    const realFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch (mock offline)'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: undefined }, putCalls),
      cacheName: 'test-cache',
    })
    await expect(instance.fetch('/scanner-assets/visual-v1/model/config.json')).rejects.toThrow(
      'Failed to fetch',
    )
  })

  it('getLog/resetLog: every real network fetch and every cache hit are recorded; resetLog clears without needing a fresh instance', async () => {
    const realFetch = vi.fn().mockResolvedValue(fakeResponse('ok'))
    const putCalls: unknown[][] = []
    const instance = createCacheThroughFetch({
      realFetch,
      cachesOpen: makeFakeCachesOpen({ matchReturns: undefined }, putCalls),
      cacheName: 'test-cache',
    })
    await instance.fetch('/scanner-assets/visual-v1/model/config.json')
    expect(instance.getLog()).toHaveLength(1)
    instance.resetLog()
    expect(instance.getLog()).toHaveLength(0)
  })
})
