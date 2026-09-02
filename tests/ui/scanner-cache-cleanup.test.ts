/**
 * Bounded obsolete-scanner-cache cleanup (P87 F-42). A fake `caches` global stands in for the
 * real Cache Storage API (unavailable in this Node test environment) — see
 * scanner-cache-cleanup.ts's own header for why this runs from the main thread rather than a
 * Service Worker `activate` handler.
 */
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
