/**
 * Bounded obsolete-scanner-cache cleanup (P87 F-42). A fake `caches` global stands in for the
 * real Cache Storage API (unavailable in this Node test environment) — see
 * scanner-cache-cleanup.ts's own header for why this runs from the main thread rather than a
 * Service Worker `activate` handler.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupObsoleteScannerCaches,
  CURRENT_SCANNER_CACHE_NAMES,
} from '../../src/platform/scanner-cache-cleanup'

function fakeCaches(names: string[]) {
  const deleted: string[] = []
  return {
    deleted,
    api: {
      keys: vi.fn().mockResolvedValue(names),
      delete: vi.fn((name: string) => {
        deleted.push(name)
        return Promise.resolve(true)
      }),
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cleanupObsoleteScannerCaches (P87 F-42)', () => {
  it('deletes an obsolete scanner-prefixed cache name not in the current allowlist', async () => {
    const { api, deleted } = fakeCaches(['scanner-assets-v6', ...CURRENT_SCANNER_CACHE_NAMES])
    vi.stubGlobal('caches', api)
    const result = await cleanupObsoleteScannerCaches()
    expect(deleted).toEqual(['scanner-assets-v6'])
    expect(result.deleted).toEqual(['scanner-assets-v6'])
  })

  it('deletes an obsolete visual-index-generation cache left over from a prior content id scheme', async () => {
    const { api, deleted } = fakeCaches([
      'scanner-assets-visual-v0-index', // hypothetical prior generation-cache naming
      ...CURRENT_SCANNER_CACHE_NAMES,
    ])
    vi.stubGlobal('caches', api)
    await cleanupObsoleteScannerCaches()
    expect(deleted).toEqual(['scanner-assets-visual-v0-index'])
  })

  it('never deletes any cache name in the current allowlist', async () => {
    const { api, deleted } = fakeCaches([...CURRENT_SCANNER_CACHE_NAMES])
    vi.stubGlobal('caches', api)
    await cleanupObsoleteScannerCaches()
    expect(deleted).toEqual([])
  })

  it('never touches a cache name that does not start with a known scanner prefix, however unfamiliar', async () => {
    const { api, deleted } = fakeCaches(['workbox-precache-v2', 'some-unrelated-app-cache'])
    vi.stubGlobal('caches', api)
    await cleanupObsoleteScannerCaches()
    expect(deleted).toEqual([])
  })

  it('a clean device (only current caches present) deletes nothing — idempotent, not an error', async () => {
    const { api, deleted } = fakeCaches([...CURRENT_SCANNER_CACHE_NAMES])
    vi.stubGlobal('caches', api)
    const first = await cleanupObsoleteScannerCaches()
    const second = await cleanupObsoleteScannerCaches()
    expect(first.deleted).toEqual([])
    expect(second.deleted).toEqual([])
    expect(deleted).toEqual([])
  })

  it('never throws when Cache Storage is unavailable in this environment', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(cleanupObsoleteScannerCaches()).resolves.toEqual({ deleted: [] })
  })

  it('never throws when caches.keys() itself rejects', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockRejectedValue(new Error('quota')),
      delete: vi.fn(),
    })
    await expect(cleanupObsoleteScannerCaches()).resolves.toEqual({ deleted: [] })
  })

  it('a single cache failing to delete does not abort deleting the rest', async () => {
    const deleted: string[] = []
    const api = {
      keys: vi.fn().mockResolvedValue(['scanner-assets-v5', 'scanner-assets-v6']),
      delete: vi.fn((name: string) => {
        if (name === 'scanner-assets-v5') return Promise.reject(new Error('locked'))
        deleted.push(name)
        return Promise.resolve(true)
      }),
    }
    vi.stubGlobal('caches', api)
    const result = await cleanupObsoleteScannerCaches()
    expect(deleted).toEqual(['scanner-assets-v6'])
    expect(result.deleted).toEqual(['scanner-assets-v5', 'scanner-assets-v6'])
  })
})

describe('CURRENT_SCANNER_CACHE_NAMES — contract test against its two real sources (N-18, P94)', () => {
  // `CURRENT_SCANNER_CACHE_NAMES` is a hand-duplicated literal (this module's own header explains
  // why it cannot import vite.config.ts, which is Node-only build config, not shippable browser
  // code). A future cache-name bump that updates one source and forgets the other would make this
  // cleanup delete the new, currently-active cache on every boot instead of an obsolete one — the
  // opposite of what it's for. Rather than build config-loading machinery to compare the REAL
  // values at runtime (out of proportion for a low-risk drift check), this reads both source files
  // as plain text and regex-extracts their cache-name literals — no Vite/Workbox/worker module is
  // ever imported or evaluated.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

  function extractWorkboxCacheNames(): string[] {
    const source = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf-8')
    return [...source.matchAll(/cacheName:\s*'([^']+)'/g)].map((m) => m[1] as string)
  }

  function extractWorkerAssetCacheName(): string {
    const source = readFileSync(
      join(repoRoot, 'src', 'features', 'scanner', 'visual', 'visual-worker.ts'),
      'utf-8',
    )
    const match = /WORKER_ASSET_CACHE_NAME\s*=\s*'([^']+)'/.exec(source)
    if (match?.[1] === undefined) {
      throw new Error(
        'Could not find WORKER_ASSET_CACHE_NAME in visual-worker.ts — has it been renamed or moved?',
      )
    }
    return match[1]
  }

  it('every Workbox cacheName in vite.config.ts is present in the allowlist', () => {
    const workboxNames = extractWorkboxCacheNames()
    expect(workboxNames.length).toBeGreaterThan(0) // the extraction itself must find something real
    for (const name of workboxNames) {
      expect(CURRENT_SCANNER_CACHE_NAMES).toContain(name)
    }
  })

  it("the worker's own Cache Storage API cache name is present in the allowlist", () => {
    expect(CURRENT_SCANNER_CACHE_NAMES).toContain(extractWorkerAssetCacheName())
  })

  it('the allowlist contains nothing BEYOND its two real sources (no stale leftover entry)', () => {
    const expected = new Set([...extractWorkboxCacheNames(), extractWorkerAssetCacheName()])
    expect(new Set(CURRENT_SCANNER_CACHE_NAMES)).toEqual(expected)
  })
})
