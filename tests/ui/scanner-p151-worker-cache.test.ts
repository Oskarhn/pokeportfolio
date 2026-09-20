import { describe, expect, it, vi } from 'vitest'
import {
  createCacheThroughFetch,
  isIndexGeneration,
  isSupersededIndexGeneration,
} from '../../src/features/scanner/visual/worker-asset-cache-through'

/**
 * P151 — the visual worker's own Cache Storage layer (`scanner-visual-worker-cache-v1`).
 *
 * Two measured defects, both reproducible against a minimal in-memory Cache:
 *  1. UNBOUNDED: the cache name never changes and nothing ever deleted an entry, so every index
 *     generation ever published (~15.7 MB each: manifest + card ids + embeddings) stayed on the
 *     device forever (P130 B-05 measured it).
 *  2. POISONABLE: every `200` GET was stored, including `200 text/html` from a captive portal or
 *     proxy. Cached under the immutable generation URL it failed the index checksum on every later
 *     session — the visual channel stayed unavailable until the user cleared site data.
 */

const ORIGIN = 'https://pokeportfolio.test'
const INDEX_BASE = '/scanner-assets/visual-v1/index'

class MemoryCache {
  readonly entries = new Map<string, Response>()
  deleteCalls = 0
  keysRejects = false
  deleteRejects = false

  private key(input: RequestInfo | URL): string {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return new URL(raw, ORIGIN).href
  }
  match(input: RequestInfo | URL): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(this.key(input))?.clone())
  }
  put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(input), response)
    return Promise.resolve()
  }
  delete(input: RequestInfo | URL): Promise<boolean> {
    this.deleteCalls += 1
    if (this.deleteRejects) return Promise.reject(new Error('delete rejected'))
    return Promise.resolve(this.entries.delete(this.key(input)))
  }
  keys(): Promise<Request[]> {
    if (this.keysRejects) return Promise.reject(new Error('keys rejected'))
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)))
  }
}

function layer(cache: MemoryCache, realFetch: typeof fetch) {
  return createCacheThroughFetch({
    realFetch,
    cachesOpen: () => Promise.resolve(cache as unknown as Cache),
    cacheName: 'test',
  })
}

function json(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}
function html(): Response {
  return new Response('<html>Please log in to the guest Wi-Fi</html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

const generationFiles = (id: string) => [
  `${INDEX_BASE}/generations/${id}/manifest.json`,
  `${INDEX_BASE}/generations/${id}/card-ids.json`,
  `${INDEX_BASE}/generations/${id}/embeddings.bin`,
]

async function flushPuts(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('P151 — a captive-portal / error page is never cached', () => {
  it('a 200 text/html answer is returned to the caller but NOT written to the cache', async () => {
    const cache = new MemoryCache()
    const realFetch = vi.fn(() => Promise.resolve(html()))
    const instance = layer(cache, realFetch)
    const response = await instance.fetch(generationFiles('aaaa')[2] ?? '')
    expect(await response.text()).toContain('guest Wi-Fi')
    await flushPuts()
    expect(cache.entries.size).toBe(0)
  })

  it('a poisoned entry written earlier is deleted on read and the network is used (self-healing)', async () => {
    const cache = new MemoryCache()
    const url = generationFiles('aaaa')[2] ?? ''
    await cache.put(url, html())
    const realFetch = vi.fn(() => Promise.resolve(json('good-bytes')))
    const instance = layer(cache, realFetch)

    const response = await instance.fetch(url)
    expect(await response.text()).toBe('good-bytes')
    expect(realFetch).toHaveBeenCalledTimes(1)
    await flushPuts()
    // The bad entry is gone and the good one replaced it.
    const stored = cache.entries.get(new URL(url, ORIGIN).href)
    expect(await stored?.text()).toBe('good-bytes')
  })

  it('a normal cached asset is still served without touching the network', async () => {
    const cache = new MemoryCache()
    const url = generationFiles('aaaa')[0] ?? ''
    await cache.put(url, json('{"ok":true}'))
    const realFetch = vi.fn(() => Promise.resolve(json('network')))
    const response = await layer(cache, realFetch).fetch(url)
    expect(await response.text()).toBe('{"ok":true}')
    expect(realFetch).not.toHaveBeenCalled()
  })

  it('error statuses and a bypassed (no-store) request are never cached', async () => {
    const cache = new MemoryCache()
    const realFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(json('{"contentId":"x"}'))
    const instance = layer(cache, realFetch)
    await instance.fetch(generationFiles('aaaa')[0] ?? '')
    await instance.fetch(generationFiles('aaaa')[1] ?? '')
    await instance.fetch(`${INDEX_BASE}/current.json`, { cache: 'no-store' })
    await flushPuts()
    expect(cache.entries.size).toBe(0)
  })
})

describe('P151 — superseded index generations are pruned (bounded cache)', () => {
  it('selects only OTHER generations under the index tree — never the current one, never model/runtime files', () => {
    const current = 'cccc'
    for (const url of generationFiles(current)) {
      expect(isSupersededIndexGeneration(`${ORIGIN}${url}`, INDEX_BASE, current)).toBe(false)
      expect(isIndexGeneration(`${ORIGIN}${url}`, INDEX_BASE, current)).toBe(true)
    }
    for (const url of generationFiles('bbbb')) {
      expect(isSupersededIndexGeneration(`${ORIGIN}${url}`, INDEX_BASE, current)).toBe(true)
    }
    for (const other of [
      '/scanner-assets/visual-v1/model/onnx/model_quantized.onnx',
      '/scanner-assets/visual-v1/ort/ort-wasm-simd-threaded.asyncify.wasm',
      `${INDEX_BASE}/current.json`,
    ]) {
      expect(isSupersededIndexGeneration(`${ORIGIN}${other}`, INDEX_BASE, current)).toBe(false)
    }
    // A generation id that merely STARTS with the current one is a different generation.
    expect(
      isSupersededIndexGeneration(
        `${ORIGIN}${INDEX_BASE}/generations/cccc0/manifest.json`,
        INDEX_BASE,
        current,
      ),
    ).toBe(true)
  })

  it('50 successive index publications across restarts keep the cache at exactly ONE generation (3 entries)', async () => {
    const cache = new MemoryCache()
    await cache.put('/scanner-assets/visual-v1/model/config.json', json('model-config'))
    let peak = 0
    for (let generation = 0; generation < 50; generation += 1) {
      const id = `gen${String(generation).padStart(4, '0')}`
      // A new session = a new cache-through instance (worker restart) over the same Cache Storage.
      const instance = layer(
        cache,
        vi.fn(() => Promise.resolve(json(`payload-${id}`))),
      )
      for (const url of generationFiles(id)) await instance.fetch(url)
      await flushPuts()
      peak = Math.max(peak, cache.entries.size)
      await instance.evict((url) => isSupersededIndexGeneration(url, INDEX_BASE, id))
      const indexEntries = [...cache.entries.keys()].filter((url) => url.includes('/generations/'))
      expect(indexEntries).toHaveLength(3)
      expect(indexEntries.every((url) => url.includes(`/${id}/`))).toBe(true)
    }
    // Never more than the previous + the new generation at once, then back to one.
    expect(peak).toBeLessThanOrEqual(1 + 6)
    expect(
      cache.entries.has(new URL('/scanner-assets/visual-v1/model/config.json', ORIGIN).href),
    ).toBe(true)
  })

  it('a generation that failed integrity is purged so the next session downloads it fresh', async () => {
    const cache = new MemoryCache()
    const instance = layer(
      cache,
      vi.fn(() => Promise.resolve(json('corrupt'))),
    )
    for (const url of generationFiles('badd')) await instance.fetch(url)
    for (const url of generationFiles('good')) await instance.fetch(url)
    await flushPuts()
    expect(cache.entries.size).toBe(6)
    const evicted = await instance.evict((url) => isIndexGeneration(url, INDEX_BASE, 'badd'))
    expect(evicted).toHaveLength(3)
    expect([...cache.entries.keys()].every((url) => url.includes('/good/'))).toBe(true)
  })
})

describe('P151 — eviction never breaks the fetch path', () => {
  it('cache unavailable, keys() rejecting and delete() rejecting all evict nothing and never throw', async () => {
    const unavailable = createCacheThroughFetch({
      realFetch: vi.fn(),
      cachesOpen: undefined,
      cacheName: 'test',
    })
    await expect(unavailable.evict(() => true)).resolves.toEqual([])

    const keysFail = new MemoryCache()
    keysFail.keysRejects = true
    await expect(layer(keysFail, vi.fn()).evict(() => true)).resolves.toEqual([])

    const deleteFail = new MemoryCache()
    await deleteFail.put(generationFiles('aaaa')[0] ?? '', json('x'))
    deleteFail.deleteRejects = true
    await expect(layer(deleteFail, vi.fn()).evict(() => true)).resolves.toEqual([])
    expect(deleteFail.entries.size).toBe(1)
  })
})
