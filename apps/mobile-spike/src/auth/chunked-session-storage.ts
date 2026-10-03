/**
 * Session storage for supabase-js on a phone: a Keychain / Android Keystore backed key-value store
 * whose single value is limited in size, holding a session JSON that is larger than that limit.
 *
 * WHY CHUNKS. expo-secure-store documents that "some iOS releases refused values above roughly 2048
 * bytes" and that Expo enforces no limit itself (docs.expo.dev/versions/latest/sdk/securestore,
 * read 2026-09-20). A real supabase-js session measured against the local stack (see
 * tests/backend/auth-session.test.ts) is above that. The two options considered:
 *
 *   A. the pattern in Supabase's own Expo guide ("LargeSecureStore"): an AES key in SecureStore and
 *      the ciphertext in AsyncStorage. Needs a crypto dependency and a random source, and the guide's
 *      AES-CTR gives confidentiality but no integrity.
 *   B. this file: split the session string into chunks below the limit and keep EVERY byte in the
 *      hardware-backed store. No crypto code of our own, no second storage medium.
 *
 * B is what the spike implements. Neither is claimed to be the final decision (OWNER/SECURITY
 * REVIEW). A torn write (the app is killed between chunk writes) is detected by a manifest that
 * records the chunk count and a checksum; a session that fails the check reads as ABSENT, i.e. the
 * person signs in again. That is the safe failure: a partial session is never returned.
 */

export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

/** The shape supabase-js accepts as `auth.storage`. */
export interface SessionStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/** Well under the ~2048-byte figure, leaving room for the store's own per-value overhead. */
export const DEFAULT_CHUNK_BYTES = 1500

// SecureStore keys may contain only alphanumerics, ".", "-" and "_".
const VALID_KEY = /^[A-Za-z0-9._-]+$/

function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/** Splits `value` into pieces of at most `maxBytes` UTF-8 bytes, never inside a code point. */
export function splitUtf8(value: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error('chunk size must hold at least one code point')
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of value) {
    const size = codePointBytes(ch.codePointAt(0) as number)
    if (bytes + size > maxBytes) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += ch
    bytes += size
  }
  if (current !== '' || chunks.length === 0) chunks.push(current)
  return chunks
}

/** FNV-1a 32-bit over UTF-16 code units: enough to notice a mix of old and new chunks. */
export function checksum(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

interface Manifest {
  chunks: number
  length: number
  sum: string
}

function parseManifest(raw: string | null): Manifest | null {
  if (raw === null) return null
  const m = /^(\d{1,6}):(\d{1,9}):([0-9a-f]{8})$/.exec(raw)
  if (m === null) return null
  return { chunks: Number(m[1]), length: Number(m[2]), sum: m[3] as string }
}

export function createChunkedSessionStorage(
  store: KeyValueStore,
  options: { chunkBytes?: number } = {},
): SessionStorage {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES
  const manifestKey = (key: string): string => `${key}.m`
  const chunkKey = (key: string, index: number): string => `${key}.c${String(index)}`
  const assertKey = (key: string): void => {
    if (!VALID_KEY.test(key)) throw new Error('invalid session storage key')
  }

  async function deleteChunks(key: string, from: number, to: number): Promise<void> {
    for (let i = from; i < to; i += 1) await store.deleteItemAsync(chunkKey(key, i))
  }

  return {
    async getItem(key) {
      assertKey(key)
      const manifest = parseManifest(await store.getItemAsync(manifestKey(key)))
      if (manifest === null) return null
      let value = ''
      for (let i = 0; i < manifest.chunks; i += 1) {
        const part = await store.getItemAsync(chunkKey(key, i))
        if (part === null) return null
        value += part
      }
      if (value.length !== manifest.length || checksum(value) !== manifest.sum) return null
      return value
    },

    async setItem(key, value) {
      assertKey(key)
      const previous = parseManifest(await store.getItemAsync(manifestKey(key)))
      const chunks = splitUtf8(value, chunkBytes)
      for (let i = 0; i < chunks.length; i += 1) {
        await store.setItemAsync(chunkKey(key, i), chunks[i] as string)
      }
      // The manifest is written LAST: until it lands, readers see the previous, consistent session
      // (or a checksum mismatch, which reads as absent) and never a half-written one.
      await store.setItemAsync(
        manifestKey(key),
        `${String(chunks.length)}:${String(value.length)}:${checksum(value)}`,
      )
      if (previous !== null && previous.chunks > chunks.length) {
        await deleteChunks(key, chunks.length, previous.chunks)
      }
    },

    async removeItem(key) {
      assertKey(key)
      const previous = parseManifest(await store.getItemAsync(manifestKey(key)))
      // Manifest first: from this instant the session reads as absent, whatever happens next.
      await store.deleteItemAsync(manifestKey(key))
      if (previous !== null) await deleteChunks(key, 0, previous.chunks)
    },
  }
}
