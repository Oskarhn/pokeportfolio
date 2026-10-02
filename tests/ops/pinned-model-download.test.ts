import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  byteCeiling,
  DEFAULT_MAX_BYTES,
  downloadPinnedFile,
  isAllowedDownloadUrl,
  MAX_REDIRECTS,
} from '../../scripts/scanner-visual-index/lib/pinned-download.mjs'

/**
 * P130-30: the model download is bounded and never leaves unverified bytes behind. The SHA-256 pin
 * stays the authority; these tests prove the bounds around it, with an injected `fetch`.
 */

const URL_OK = 'https://huggingface.co/Xenova/dinov2-small/resolve/abc/config.json'
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const GOOD = Buffer.from('{"ok":true}')
const GOOD_SHA = sha(GOOD)

function dir() {
  return mkdtempSync(join(tmpdir(), 'p191-dl-'))
}

function respond(body: Uint8Array | null, init: ResponseInit = {}): Response {
  return new Response(body as unknown as BodyInit | null, { status: 200, ...init })
}

function streamOf(chunks: Uint8Array[], gapMs = 0): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift()
      if (next === undefined) {
        controller.close()
        return
      }
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
      controller.enqueue(next)
    },
  })
  return new Response(stream, { status: 200 })
}

const never = ((_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason as Error)
    })
  })) as unknown as typeof fetch

describe('downloadPinnedFile', () => {
  it('writes a verified file and nothing else', async () => {
    const d = dir()
    const dest = join(d, 'sub', 'config.json')
    const result = await downloadPinnedFile({
      url: URL_OK,
      dest,
      expectedSha256: GOOD_SHA,
      fetchImpl: () => Promise.resolve(respond(GOOD)),
    })
    expect(result).toBe(GOOD_SHA)
    expect(readFileSync(dest)).toEqual(GOOD)
    expect(readdirSync(join(d, 'sub'))).toEqual(['config.json'])
  })

  it('has a timeout: a request that never answers is a failure, not a hang', async () => {
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        timeoutMs: 40,
        fetchImpl: never,
      }),
    ).rejects.toThrow(/did not finish within 40 ms/)
    expect(existsSync(dest)).toBe(false)
  })

  it('has a timeout on the BODY: a stalled stream is a failure too', async () => {
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        timeoutMs: 60,
        fetchImpl: () => Promise.resolve(streamOf([new Uint8Array(5), new Uint8Array(5)], 200)),
      }),
    ).rejects.toThrow(/did not finish/)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses an oversized declared content-length without reading the body', async () => {
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        fetchImpl: () =>
          Promise.resolve(
            respond(GOOD, { headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } }),
          ),
      }),
    ).rejects.toThrow(/exceeds the \d+-byte limit/)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses an oversized body that omits its length', async () => {
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        maxBytes: 64,
        fetchImpl: () => Promise.resolve(streamOf([new Uint8Array(40), new Uint8Array(40)])),
      }),
    ).rejects.toThrow(/exceeded the 64-byte limit/)
    expect(existsSync(dest)).toBe(false)
  })

  it('the pinned size is a ceiling and an exact check', async () => {
    expect(byteCeiling({ bytes: 100 })).toBe(100 + 1024)
    expect(byteCeiling({ bytes: null })).toBe(DEFAULT_MAX_BYTES)
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        file: { bytes: GOOD.byteLength + 1 },
        fetchImpl: () => Promise.resolve(respond(GOOD)),
      }),
    ).rejects.toThrow(/the pin says/)
    expect(existsSync(dest)).toBe(false)
  })

  it('a wrong hash is refused and leaves no file — the hash is still authoritative', async () => {
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: sha('something else'),
        fetchImpl: () => Promise.resolve(respond(GOOD)),
      }),
    ).rejects.toThrow(/SHA-256 mismatch/)
    expect(existsSync(dest)).toBe(false)
  })

  it('a failure never overwrites a previously verified file', async () => {
    const d = dir()
    const dest = join(d, 'f')
    writeFileSync(dest, GOOD)
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        fetchImpl: () => Promise.resolve(respond(Buffer.from('tampered'))),
      }),
    ).rejects.toThrow()
    expect(readFileSync(dest)).toEqual(GOOD)
    expect(readdirSync(d)).toEqual(['f'])
  })

  it('a timeout does not retry or fall back: one request, no file', async () => {
    const dest = join(dir(), 'f')
    let calls = 0
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        timeoutMs: 30,
        fetchImpl: (url: RequestInfo | URL, init?: RequestInit) => {
          calls++
          return never(url, init)
        },
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
    expect(existsSync(dest)).toBe(false)
  })

  it('HTTP errors are failures', async () => {
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest: join(dir(), 'f'),
        expectedSha256: GOOD_SHA,
        fetchImpl: () => Promise.resolve(new Response('nope', { status: 503 })),
      }),
    ).rejects.toThrow(/HTTP 503/)
  })

  it('a transport failure names its cause instead of the bare "fetch failed"', async () => {
    const dest = join(dir(), 'f')
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest,
        expectedSha256: GOOD_SHA,
        fetchImpl: () =>
          Promise.reject(
            Object.assign(new TypeError('fetch failed'), {
              cause: Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
            }),
          ),
      }),
    ).rejects.toThrow(/UND_ERR_CONNECT_TIMEOUT/)
    expect(existsSync(dest)).toBe(false)
  })
})

describe('redirect policy', () => {
  it('allows Hugging Face hosts over https and nothing else', () => {
    for (const ok of [
      'https://huggingface.co/a',
      'https://cdn-lfs.huggingface.co/a',
      'https://cas-bridge.xethub.hf.co/a',
    ]) {
      expect(isAllowedDownloadUrl(ok), ok).toBe(true)
    }
    for (const bad of [
      'http://huggingface.co/a',
      'https://evilhuggingface.co/a',
      'https://huggingface.co.evil.example/a',
      'https://example.com/a',
      'https://huggingface.co:8443/a',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isAllowedDownloadUrl(bad), bad).toBe(false)
    }
  })

  it('follows a redirect to an allowed CDN host', async () => {
    const dest = join(dir(), 'f')
    const seen: string[] = []
    await downloadPinnedFile({
      url: URL_OK,
      dest,
      expectedSha256: GOOD_SHA,
      fetchImpl: (url) => {
        seen.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
        return Promise.resolve(
          seen.length === 1
            ? new Response(null, {
                status: 302,
                headers: { location: 'https://cdn-lfs.huggingface.co/blob' },
              })
            : respond(GOOD),
        )
      },
    })
    expect(seen).toEqual([URL_OK, 'https://cdn-lfs.huggingface.co/blob'])
    expect(readFileSync(dest)).toEqual(GOOD)
  })

  it('refuses a redirect to another host, to http, and a redirect loop', async () => {
    const redirectTo = (location: string) => () =>
      Promise.resolve(new Response(null, { status: 302, headers: { location } }))
    const attempt = (fetchImpl: typeof fetch) =>
      downloadPinnedFile({
        url: URL_OK,
        dest: join(dir(), 'f'),
        expectedSha256: GOOD_SHA,
        fetchImpl,
      })
    await expect(attempt(redirectTo('https://attacker.example/m.onnx'))).rejects.toThrow(
      /not an allowed/,
    )
    await expect(attempt(redirectTo('http://huggingface.co/m.onnx'))).rejects.toThrow(
      /not an allowed/,
    )
    await expect(attempt(redirectTo(URL_OK))).rejects.toThrow(
      new RegExp(`more than ${String(MAX_REDIRECTS)}`),
    )
  })

  it('a redirect without a location is refused', async () => {
    await expect(
      downloadPinnedFile({
        url: URL_OK,
        dest: join(dir(), 'f'),
        expectedSha256: GOOD_SHA,
        fetchImpl: () => Promise.resolve(new Response(null, { status: 302 })),
      }),
    ).rejects.toThrow(/without a location/)
  })
})

describe('both staging scripts use the bounded downloader', () => {
  for (const script of [
    'scripts/prepare-scanner-visual-assets.mjs',
    'apps/mobile-spike/scripts/prepare-scanner-native-assets.mjs',
  ]) {
    it(`${script}: no bare fetch, writes only through downloadPinnedFile`, () => {
      const text = readFileSync(script, 'utf8')
      expect(text).toMatch(/downloadPinnedFile\(/)
      expect(text).not.toMatch(/\bfetch\(/)
    })
  }
})
