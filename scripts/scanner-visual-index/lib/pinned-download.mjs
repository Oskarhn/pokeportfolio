// Bounded, verified download of one pinned model file (P130-30, P191).
//
// The SHA-256 in model-pin.mjs is the ONLY thing that makes downloaded bytes trustworthy, and it
// stays authoritative here: nothing this module does makes a file acceptable. What it adds is the
// bounds a build step needs so that a hostile or broken network can neither hang the build nor fill
// the disk, and so that a failure never leaves unverified bytes where a later run might use them:
//
//   * a finite timeout on every request AND on the body read (a stalled body is a timeout, not a hang);
//   * a hard byte ceiling, applied while streaming, so an oversized body is abandoned early;
//   * a redirect policy: https only, a bounded hop count, and only Hugging Face's own hosts
//     (huggingface.co and the *.hf.co / *.huggingface.co CDN names its LFS redirects use) — a
//     redirect anywhere else is refused, not followed;
//   * `Content-Length`, when present, must agree with the pinned size and the ceiling;
//   * bytes go to a temporary file and are renamed into place only after the hash matches, so a
//     timeout, a size refusal or a mismatch leaves nothing at the destination path;
//   * no fallback of any kind: every failure throws.
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_REDIRECTS = 5
/** Ceiling for a file whose pinned size is unknown (the two small JSON configs). */
export const DEFAULT_MAX_BYTES = 1_048_576
/** Slack over a pinned size, to tolerate nothing but a wrong pin — the hash decides correctness. */
export const PINNED_SIZE_SLACK_BYTES = 1024

const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*(?:huggingface\.co|hf\.co)$/i

export function isAllowedDownloadUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.port === '' && ALLOWED_HOST.test(parsed.hostname)
}

/** Largest body accepted for `file` ({ bytes: number | null }). */
export function byteCeiling(file, override) {
  if (override !== undefined) return override
  return file.bytes === null || file.bytes === undefined
    ? DEFAULT_MAX_BYTES
    : file.bytes + PINNED_SIZE_SLACK_BYTES
}

async function requestFollowingAllowedRedirects(url, { fetchImpl, signal }) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedDownloadUrl(current)) {
      throw new Error(`download refused: ${current} is not an allowed https Hugging Face host`)
    }
    const response = await fetchImpl(current, { redirect: 'manual', signal })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location)
        throw new Error(`download refused: redirect from ${current} without a location`)
      // Relative locations resolve against the current URL; the target is re-checked on the loop.
      current = new URL(location, current).toString()
      continue
    }
    return { response, finalUrl: current }
  }
  throw new Error(`download refused: more than ${MAX_REDIRECTS} redirects for ${url}`)
}

async function readBounded(response, maxBytes, signal) {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const n = Number(declared)
    if (!Number.isFinite(n) || n < 0) throw new Error('download refused: invalid content-length')
    if (n > maxBytes) {
      throw new Error(`download refused: content-length ${n} exceeds the ${maxBytes}-byte limit`)
    }
  }
  if (response.body === null) throw new Error('download refused: empty response body')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('download aborted')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`download refused: body exceeded the ${maxBytes}-byte limit`)
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  return Buffer.concat(chunks, total)
}

/**
 * Download `url` to `dest`, verified against `expectedSha256`. Resolves with the SHA-256 on success;
 * throws on every failure and leaves `dest` untouched (or absent).
 *
 * `fetchImpl` and `timeoutMs` are injectable for tests.
 */
export async function downloadPinnedFile({
  url,
  dest,
  expectedSha256,
  file = { bytes: null },
  maxBytes,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const limit = byteCeiling(file, maxBytes)
  const signal = AbortSignal.timeout(timeoutMs)
  let body
  try {
    const { response, finalUrl } = await requestFollowingAllowedRedirects(url, {
      fetchImpl,
      signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${finalUrl}`)
    body = await readBounded(response, limit, signal)
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`download of ${url} did not finish within ${timeoutMs} ms`, { cause: error })
    }
    throw error
  }

  if (file.bytes !== null && file.bytes !== undefined && body.byteLength !== file.bytes) {
    throw new Error(
      `download refused: ${url} is ${body.byteLength} bytes, the pin says ${file.bytes}`,
    )
  }
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${url} (expected ${expectedSha256}, got ${actual}). Refusing to stage unverified bytes.`,
    )
  }

  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.${process.pid}.partial`
  try {
    writeFileSync(partial, body)
    renameSync(partial, dest)
  } finally {
    rmSync(partial, { force: true })
  }
  return actual
}
