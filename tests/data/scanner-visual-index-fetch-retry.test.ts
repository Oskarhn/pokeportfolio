/**
 * Timeout, retry, and backoff behavior for the offline visual-index generator's per-card image
 * fetches (P110, prompt §6-7). Exercised against a REAL local `node:http` server, not a mocked
 * `fetch` — timeout behavior in particular is easy to get subtly wrong (a real `AbortController`
 * wired to a real pending request) in a way a mock would not catch. `sleep`/`random` are injected
 * as fast, deterministic stand-ins so this suite runs in milliseconds, never real wall-clock
 * backoff delays.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeBackoffDelayMs,
  fetchWithRetry,
  parseRetryAfterMs,
} from '../../scripts/scanner-visual-index/fetch-with-retry'

let server: Server | undefined
let baseUrl = ''

function noSleep(): Promise<void> {
  return Promise.resolve()
}
const fixedRandom = () => 0.5

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

async function startServer(handler: RequestHandler): Promise<void> {
  server = createServer(handler)
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  baseUrl = `http://127.0.0.1:${String(address.port)}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve()
      })
    })
  }
  server = undefined
})

describe('fetchWithRetry — success paths', () => {
  it('returns ok=true on the first attempt when the server responds 200 immediately', async () => {
    await startServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    const result = await fetchWithRetry(baseUrl, { sleep: noSleep, random: fixedRandom })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.attempts).toBe(1)
      expect(await result.response.text()).toBe('ok')
    }
  })
})

describe('fetchWithRetry — timeout (no real internet needed)', () => {
  it('aborts a request that never responds once the timeout elapses, and reports kind=timeout', async () => {
    await startServer(() => {
      // Deliberately never call res.end() — the request hangs forever unless the client aborts it.
    })
    const result = await fetchWithRetry(baseUrl, {
      timeoutMs: 20,
      maxAttempts: 1,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('timeout')
      expect(result.message).toMatch(/timed out/)
    }
  })

  it('a slow-but-eventually-successful response inside a generous timeout still succeeds', async () => {
    await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('slow-ok')
      }, 10)
    })
    const result = await fetchWithRetry(baseUrl, {
      timeoutMs: 5000,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(true)
  })
})

describe('fetchWithRetry — permanent failures are never retried', () => {
  it('404 returns immediately on the first attempt, never retried', async () => {
    let requestCount = 0
    await startServer((_req, res) => {
      requestCount += 1
      res.writeHead(404)
      res.end()
    })
    const result = await fetchWithRetry(baseUrl, {
      maxAttempts: 5,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('http_404')
    expect(requestCount).toBe(1)
  })

  it('an unexpected non-retryable status (403) also returns after exactly one attempt', async () => {
    let requestCount = 0
    await startServer((_req, res) => {
      requestCount += 1
      res.writeHead(403)
      res.end()
    })
    const result = await fetchWithRetry(baseUrl, {
      maxAttempts: 5,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('http_other')
    expect(requestCount).toBe(1)
  })
})

describe('fetchWithRetry — transient failures retry and can recover', () => {
  it('a 429 burst followed by recovery succeeds, honoring Retry-After', async () => {
    let requestCount = 0
    const sleeps: number[] = []
    await startServer((_req, res) => {
      requestCount += 1
      if (requestCount < 3) {
        res.writeHead(429, { 'retry-after': '0' })
        res.end()
        return
      }
      res.writeHead(200)
      res.end('recovered')
    })
    const result = await fetchWithRetry(baseUrl, {
      maxAttempts: 5,
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
      random: fixedRandom,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.attempts).toBe(3)
      expect(await result.response.text()).toBe('recovered')
    }
    expect(requestCount).toBe(3)
    // Both retry delays honored the server's Retry-After: 0 header rather than falling back to
    // the (nonzero, jittered) exponential backoff schedule.
    expect(sleeps).toEqual([0, 0])
  })

  it('a 5xx burst followed by recovery succeeds — no false permanent loss of a card that eventually works', async () => {
    let requestCount = 0
    await startServer((_req, res) => {
      requestCount += 1
      if (requestCount < 3) {
        res.writeHead(503)
        res.end()
        return
      }
      res.writeHead(200)
      res.end('recovered')
    })
    const result = await fetchWithRetry(baseUrl, {
      maxAttempts: 5,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(true)
    expect(requestCount).toBe(3)
  })

  it('exhausts maxAttempts and reports failure when the server never recovers', async () => {
    let requestCount = 0
    await startServer((_req, res) => {
      requestCount += 1
      res.writeHead(503)
      res.end()
    })
    const result = await fetchWithRetry(baseUrl, {
      maxAttempts: 3,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('http_5xx')
      expect(result.attempts).toBe(3)
    }
    expect(requestCount).toBe(3)
  })

  it('a network-level connection failure (nothing listening) is classified "network" and retried up to the limit', async () => {
    // Never start a server — connecting to an arbitrary local port that nothing is bound to
    // fails at the TCP layer, real network-error classification, no mocking.
    const result = await fetchWithRetry('http://127.0.0.1:1', {
      maxAttempts: 2,
      sleep: noSleep,
      random: fixedRandom,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('network')
      expect(result.attempts).toBe(2)
    }
  })
})

describe('parseRetryAfterMs', () => {
  it('parses a non-negative integer-seconds header', () => {
    expect(parseRetryAfterMs('5')).toBe(5000)
    expect(parseRetryAfterMs('0')).toBe(0)
  })
  it('parses an HTTP-date header as a delta from now, clamped to >= 0', () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const parsed = parseRetryAfterMs(future)
    expect(parsed).not.toBeNull()
    expect(parsed).toBeGreaterThan(0)
    expect(parsed).toBeLessThanOrEqual(10_000)

    const past = new Date(Date.now() - 10_000).toUTCString()
    expect(parseRetryAfterMs(past)).toBe(0)
  })
  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs('')).toBeNull()
    expect(parseRetryAfterMs('not-a-number-or-date')).toBeNull()
  })
})

describe('computeBackoffDelayMs', () => {
  it('is bounded above by maxDelayMs regardless of attempt number', () => {
    const delay = computeBackoffDelayMs(50, 500, 15_000, () => 0.999999)
    expect(delay).toBeLessThanOrEqual(15_000)
  })
  it('grows exponentially with attempt number before hitting the cap', () => {
    const at1 = computeBackoffDelayMs(1, 500, 60_000, () => 1)
    const at2 = computeBackoffDelayMs(2, 500, 60_000, () => 1)
    const at3 = computeBackoffDelayMs(3, 500, 60_000, () => 1)
    expect(at2).toBeGreaterThan(at1)
    expect(at3).toBeGreaterThan(at2)
  })
  it('is zero when random() returns 0 (full jitter can legitimately produce no delay)', () => {
    expect(computeBackoffDelayMs(3, 500, 15_000, () => 0)).toBe(0)
  })
})
