import {
  checksum,
  createChunkedSessionStorage,
  DEFAULT_CHUNK_BYTES,
  splitUtf8,
} from '../../src/auth/chunked-session-storage'
import { MemoryKeyValueStore } from '../support/fakes'

const KEY = 'pokeportfolio-spike-auth'
/** The documented limit some iOS releases enforce. The fake store REJECTS anything larger. */
const IOS_LIMIT = 2048

function sessionJson(bytes: number, unicode = false): string {
  const filler = unicode ? 'æøå€😀'.repeat(Math.ceil(bytes / 13)) : 'a'.repeat(bytes)
  return JSON.stringify({ access_token: filler, refresh_token: 'r', user: { id: 'u' } })
}

describe('splitUtf8', () => {
  it('never exceeds the byte limit and never splits a code point', () => {
    const value = 'æ😀€'.repeat(2000)
    const parts = splitUtf8(value, 100)
    expect(parts.join('')).toBe(value)
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(100)
    for (const p of parts) expect(p).not.toContain('�')
  })
  it('returns one empty chunk for an empty string', () => {
    expect(splitUtf8('', 100)).toEqual([''])
  })
})

describe('chunked session storage', () => {
  it('a session larger than the 2048-byte limit is REJECTED by a plain store but round-trips chunked', async () => {
    const value = sessionJson(6000)
    const plain = new MemoryKeyValueStore(IOS_LIMIT)
    await expect(plain.setItemAsync('k', value)).rejects.toThrow('too large')

    const store = new MemoryKeyValueStore(IOS_LIMIT)
    const storage = createChunkedSessionStorage(store)
    await storage.setItem(KEY, value)
    expect(await storage.getItem(KEY)).toBe(value)
    for (const stored of store.data.values()) {
      expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(IOS_LIMIT)
    }
  })

  it('the default chunk size leaves headroom under the documented limit', () => {
    expect(DEFAULT_CHUNK_BYTES).toBeLessThan(IOS_LIMIT)
  })

  it('round-trips multi-byte content and an empty value', async () => {
    const store = new MemoryKeyValueStore(IOS_LIMIT)
    const storage = createChunkedSessionStorage(store)
    const value = sessionJson(9000, true)
    await storage.setItem(KEY, value)
    expect(await storage.getItem(KEY)).toBe(value)
    await storage.setItem(KEY, '')
    expect(await storage.getItem(KEY)).toBe('')
  })

  it('returns null when nothing is stored', async () => {
    expect(await createChunkedSessionStorage(new MemoryKeyValueStore()).getItem(KEY)).toBeNull()
  })

  it('a shrinking session leaves no stale chunks behind', async () => {
    const store = new MemoryKeyValueStore()
    const storage = createChunkedSessionStorage(store)
    await storage.setItem(KEY, sessionJson(9000))
    const before = store.data.size
    await storage.setItem(KEY, sessionJson(500))
    expect(store.data.size).toBeLessThan(before)
    expect([...store.data.keys()].filter((k) => k.includes('.c'))).toHaveLength(1)
  })

  it('removeItem removes the manifest first and every chunk', async () => {
    const store = new MemoryKeyValueStore()
    const storage = createChunkedSessionStorage(store)
    await storage.setItem(KEY, sessionJson(9000))
    await storage.removeItem(KEY)
    expect(store.data.size).toBe(0)
    expect(await storage.getItem(KEY)).toBeNull()
  })

  it('a torn write (killed after some chunks, before the manifest) reads as ABSENT, never as a mixed session', async () => {
    const store = new MemoryKeyValueStore()
    const storage = createChunkedSessionStorage(store)
    const oldValue = sessionJson(6000)
    await storage.setItem(KEY, oldValue)
    // Simulate the app dying while writing a new, different session: chunk 0 replaced, manifest not.
    const newValue = sessionJson(6000).replace('aaaa', 'bbbb')
    store.data.set(`${KEY}.c0`, splitUtf8(newValue, DEFAULT_CHUNK_BYTES)[0] as string)
    expect(await storage.getItem(KEY)).toBeNull()
  })

  it('a missing chunk reads as absent', async () => {
    const store = new MemoryKeyValueStore()
    const storage = createChunkedSessionStorage(store)
    await storage.setItem(KEY, sessionJson(6000))
    store.data.delete(`${KEY}.c1`)
    expect(await storage.getItem(KEY)).toBeNull()
  })

  it('a corrupt manifest reads as absent', async () => {
    const store = new MemoryKeyValueStore()
    const storage = createChunkedSessionStorage(store)
    await storage.setItem(KEY, sessionJson(3000))
    store.data.set(`${KEY}.m`, 'garbage')
    expect(await storage.getItem(KEY)).toBeNull()
  })

  it('refuses a key SecureStore would reject', async () => {
    const storage = createChunkedSessionStorage(new MemoryKeyValueStore())
    await expect(storage.setItem('bad key!', 'x')).rejects.toThrow('invalid session storage key')
  })

  it('checksum differs for different content of equal length', () => {
    expect(checksum('abcd')).not.toBe(checksum('abce'))
  })
})
