import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffDelayMs,
  DEFAULT_PROVIDER_POLICY,
  fetchJsonWithPolicy,
  parseRetryAfter,
  ProviderError,
  providerRuntime,
  type ProviderClock,
} from '../../supabase/functions/_shared/provider-http'
import { fetchCardPricing, TcgdexNotFoundError } from '../../supabase/functions/_shared/tcgdex'

/**
 * P201 — the provider HTTP policy: bounded, idempotent, classified. Everything runs on a fake
 * clock, so retries and backoff cost no wall time and the exact number of attempts and sleeps is
 * an assertion rather than a hope.
 */

interface FakeClock extends ProviderClock {
  sleeps: number[]
  advance(ms: number): void
}

function fakeClock(randomValue = 0.5): FakeClock {
  let t = 1_000_000
  const clock: FakeClock = {
    sleeps: [],
    sleep: (ms) => {
      clock.sleeps.push(ms)
      t += ms
      return Promise.resolve()
    },
    random: () => randomValue,
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
  return clock
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
}

/** A fetch that answers from a script, one entry per call, and records the call count. */
function scripted(steps: (Response | Error)[]) {
  let calls = 0
  const impl = (() => {
    const step = steps[Math.min(calls, steps.length - 1)]!
    calls++
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step.clone())
  }) as unknown as typeof fetch
  return {
    impl,
    get calls() {
      return calls
    },
  }
}

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError)
    return error as ProviderError
  }
  throw new Error('expected the call to fail')
}

describe('fetchJsonWithPolicy — success and non-retryable answers', () => {
  it('returns parsed JSON on the first attempt without sleeping', async () => {
    const clock = fakeClock()
    const fetcher = scripted([response(200, { ok: 1 })])
    await expect(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', { clock, fetchImpl: fetcher.impl }),
    ).resolves.toEqual({ ok: 1 })
    expect(fetcher.calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('does not retry a 404 and reports not_found', async () => {
    const clock = fakeClock()
    const fetcher = scripted([response(404, 'nope')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', { clock, fetchImpl: fetcher.impl }),
    )
    expect(error.kind).toBe('not_found')
    expect(fetcher.calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('does not retry another 4xx', async () => {
    const fetcher = scripted([response(403, 'forbidden')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock: fakeClock(),
        fetchImpl: fetcher.impl,
      }),
    )
    expect(error.kind).toBe('client_error')
    expect(error.status).toBe(403)
    expect(fetcher.calls).toBe(1)
  })

  it('does not retry invalid JSON: the same answer would come back', async () => {
    const fetcher = scripted([response(200, '<html>maintenance</html>')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock: fakeClock(),
        fetchImpl: fetcher.impl,
      }),
    )
    expect(error.kind).toBe('invalid_json')
    expect(fetcher.calls).toBe(1)
  })

  it('treats an empty 200 body as invalid JSON, not as an empty result', async () => {
    const fetcher = scripted([response(200, '')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock: fakeClock(),
        fetchImpl: fetcher.impl,
      }),
    )
    expect(error.kind).toBe('invalid_json')
  })
})

describe('fetchJsonWithPolicy — bounded retries', () => {
  it('retries a 503 once and succeeds, sleeping a jittered backoff within its ceiling', async () => {
    const clock = fakeClock(0.5)
    const fetcher = scripted([response(503, 'down'), response(200, { n: 2 })])
    await expect(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', { clock, fetchImpl: fetcher.impl }),
    ).resolves.toEqual({ n: 2 })
    expect(fetcher.calls).toBe(2)
    // attempt 1 ceiling = base (300) → 0.5 * 300
    expect(clock.sleeps).toEqual([150])
  })

  it('gives up after exactly maxAttempts on a persistent 5xx and reports the attempt count', async () => {
    const clock = fakeClock()
    const fetcher = scripted([response(502, 'bad gateway')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', { clock, fetchImpl: fetcher.impl }),
    )
    expect(error.kind).toBe('server_error')
    expect(error.attempts).toBe(DEFAULT_PROVIDER_POLICY.maxAttempts)
    expect(fetcher.calls).toBe(DEFAULT_PROVIDER_POLICY.maxAttempts)
    expect(clock.sleeps).toHaveLength(DEFAULT_PROVIDER_POLICY.maxAttempts - 1)
  })

  it('retries a network error and recovers', async () => {
    const fetcher = scripted([new TypeError('fetch failed'), response(200, { ok: true })])
    await expect(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock: fakeClock(),
        fetchImpl: fetcher.impl,
      }),
    ).resolves.toEqual({ ok: true })
    expect(fetcher.calls).toBe(2)
  })

  it('honours a short Retry-After on 429 and never retries sooner than asked', async () => {
    const clock = fakeClock(0)
    const fetcher = scripted([response(429, '', { 'retry-after': '2' }), response(200, { ok: 1 })])
    await fetchJsonWithPolicy('https://x.invalid/a', '/a', { clock, fetchImpl: fetcher.impl })
    expect(clock.sleeps).toEqual([2000])
  })

  it('refuses to sleep through a long Retry-After: fails at once, carrying the ask', async () => {
    const clock = fakeClock()
    const fetcher = scripted([response(429, '', { 'retry-after': '120' })])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', { clock, fetchImpl: fetcher.impl }),
    )
    expect(error.kind).toBe('rate_limited')
    expect(error.retryAfterMs).toBe(120_000)
    expect(fetcher.calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  it('stops retrying when the next sleep would pass the total budget', async () => {
    const clock = fakeClock(1)
    const fetcher = scripted([response(500, 'x')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock,
        fetchImpl: fetcher.impl,
        policy: { totalBudgetMs: 100, baseDelayMs: 300 },
      }),
    )
    expect(error.kind).toBe('server_error')
    expect(fetcher.calls).toBe(1)
  })

  it('starts no attempt after a shared batch deadline', async () => {
    const clock = fakeClock()
    const fetcher = scripted([response(200, {})])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock,
        fetchImpl: fetcher.impl,
        deadlineMs: clock.now() - 1,
      }),
    )
    expect(error.kind).toBe('budget_exhausted')
    expect(fetcher.calls).toBe(0)
  })

  it('aborts an attempt that never answers and reports a timeout', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })) as unknown as typeof fetch
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/a', {
        clock: fakeClock(),
        fetchImpl: hanging,
        policy: { attemptTimeoutMs: 15, maxAttempts: 1 },
      }),
    )
    expect(error.kind).toBe('timeout')
  })

  it('keeps the response body out of the error message', async () => {
    const fetcher = scripted([response(500, 'Bearer sk_live_TOPSECRET stack trace')])
    const error = await failureOf(
      fetchJsonWithPolicy('https://x.invalid/a', '/cards/x', {
        clock: fakeClock(),
        fetchImpl: fetcher.impl,
        policy: { maxAttempts: 1 },
      }),
    )
    expect(error.message).not.toContain('TOPSECRET')
    expect(error.message).toContain('/cards/x')
  })
})

describe('retry arithmetic', () => {
  it('parses Retry-After seconds and HTTP dates and rejects junk', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000)
    expect(parseRetryAfter(' 0 ', 0)).toBe(0)
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter('', 0)).toBeNull()
    expect(parseRetryAfter('soon', 0)).toBeNull()
    expect(parseRetryAfter('-4', 0)).toBeNull()
    const now = Date.parse('2026-10-09T12:00:00Z')
    expect(parseRetryAfter('Fri, 09 Oct 2026 12:00:07 GMT', now)).toBe(7000)
    // a date in the past means "now", never a negative sleep
    expect(parseRetryAfter('Fri, 09 Oct 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('doubles the ceiling per attempt up to maxDelayMs and never exceeds it', () => {
    const policy = { baseDelayMs: 300, maxDelayMs: 2000 }
    const max = (attempt: number) => backoffDelayMs(attempt, policy, () => 0.999999)
    expect(max(1)).toBeLessThanOrEqual(300)
    expect(max(2)).toBeLessThanOrEqual(600)
    expect(max(3)).toBeLessThanOrEqual(1200)
    expect(max(10)).toBeLessThanOrEqual(2000)
    expect(backoffDelayMs(5, policy, () => 0)).toBe(0)
  })
})

describe('TCGdex adapter on top of the policy', () => {
  beforeEach(() => {
    providerRuntime.clock = fakeClock()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    providerRuntime.clock = {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: () => Math.random(),
      now: () => Date.now(),
    }
  })

  it('keeps the dedicated not-found class for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(fetchCardPricing('en', 'zz-1')).rejects.toBeInstanceOf(TcgdexNotFoundError)
  })

  it('recovers from a transient 500 and returns the mapped pricing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('oops', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'x-1', variants: { normal: true } }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const pricing = await fetchCardPricing('en', 'x-1')
    expect(pricing.tcgdexCardId).toBe('x-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces invalid JSON as a classified provider error, not a bare SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<<<', { status: 200 })))
    await expect(fetchCardPricing('en', 'x-1')).rejects.toMatchObject({ kind: 'invalid_json' })
  })

  it('makes a bounded number of requests when the provider keeps failing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchCardPricing('en', 'x-1')).rejects.toMatchObject({ kind: 'server_error' })
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_PROVIDER_POLICY.maxAttempts)
  })
})
