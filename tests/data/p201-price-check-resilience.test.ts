import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PriceCheckError,
  fetchCardPriceResponse,
  parseProviderFailures,
  type SearchPricesInvoker,
} from '../../src/data/price-check'
import {
  buildRawSection,
  unavailableReasonForFailures,
} from '../../src/domain/price-check/raw-section'

vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))

/**
 * P201 — Price Check under a slow, stuck or failing price source. Every outcome is a named state;
 * none of them is "no price", and a person is never left looking at a spinner for minutes.
 */

const CARD = '11111111-1111-4111-8111-111111111111'
const NOW = () => Date.parse('2026-10-09T10:00:00Z')

afterEach(() => {
  vi.useRealTimers()
})

/** An invoker that never answers until its signal aborts, then rejects like fetch does. */
const hanging: SearchPricesInvoker = (_name, options) =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'))
    })
  })

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PriceCheckError) return error.reason
    return `non-PriceCheckError:${(error as Error).name}`
  }
  return 'resolved'
}

describe('a stuck lookup times out instead of loading for ever', () => {
  it('reports "timeout" after the bound, as a named failure', async () => {
    vi.useFakeTimers()
    const pending = reasonOf(fetchCardPriceResponse(CARD, { invoke: hanging, timeoutMs: 5000 }))
    await vi.advanceTimersByTimeAsync(4999)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('timeout')
  })

  it("the caller's own cancellation stays a silent AbortError, never a timeout", async () => {
    const caller = new AbortController()
    const pending = reasonOf(
      fetchCardPriceResponse(CARD, { invoke: hanging, signal: caller.signal, timeoutMs: 60_000 }),
    )
    caller.abort()
    expect(await pending).toBe('non-PriceCheckError:AbortError')
  })

  it('an answer that arrives in time is returned and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const invoke: SearchPricesInvoker = () =>
      Promise.resolve({ data: { ok: true, results: [], providerErrorCount: 0 }, error: null })
    const response = await fetchCardPriceResponse(CARD, { invoke, now: NOW, timeoutMs: 5000 })
    expect(response.rows).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an already-cancelled call never reaches the network', async () => {
    const caller = new AbortController()
    caller.abort()
    const invoke = vi.fn<SearchPricesInvoker>()
    expect(await reasonOf(fetchCardPriceResponse(CARD, { invoke, signal: caller.signal }))).toBe(
      'non-PriceCheckError:AbortError',
    )
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('provider failure classes reach the person as the right explanation', () => {
  it.each([
    [{ rate_limited: 1 }, 'rate_limited'],
    [{ timeout: 1 }, 'timeout'],
    [{ budget_exhausted: 1 }, 'timeout'],
    [{ server_error: 1 }, 'provider_error'],
    [{ network: 1 }, 'provider_error'],
    [{ invalid_json: 1 }, 'provider_error'],
    [{ not_found: 1 }, 'no_variant_price'],
    [{ not_found: 1, server_error: 1 }, 'provider_error'],
    [{ something_new: 3 }, 'provider_error'],
    [{}, 'provider_error'],
    [undefined, 'provider_error'],
  ])('%j → %s', (failures, reason) => {
    expect(unavailableReasonForFailures(failures)).toBe(reason)
  })

  it('a prototype member can never be read as a failure class', () => {
    expect(unavailableReasonForFailures({})).toBe('provider_error')
    const hostile = JSON.parse('{"__proto__": {"rate_limited": 5}}') as Record<string, number>
    expect(unavailableReasonForFailures(hostile)).toBe('provider_error')
  })

  it('buildRawSection names a rate limit and still never shows a price for that card', () => {
    const { section } = buildRawSection(
      {
        fetchedAt: '2026-10-09T10:00:00.000Z',
        rows: [{ cardVariantId: 'v1', observations: [] }],
        providerErrorCount: 1,
        providerFailures: { rate_limited: 1 },
      },
      { variantId: 'v1', finish: 'normal' },
    )
    expect(section).toMatchObject({ status: 'unavailable', unavailable: 'rate_limited' })
    expect(section.observations).toEqual([])
  })

  it('an older function that reports no classes still yields the generic provider error', () => {
    const { section } = buildRawSection(
      {
        fetchedAt: '2026-10-09T10:00:00.000Z',
        rows: [],
        providerErrorCount: 2,
      },
      { variantId: 'v1', finish: 'normal' },
    )
    expect(section.unavailable).toBe('provider_error')
  })

  it('fetchCardPriceResponse carries the reported classes through, validated', async () => {
    const invoke: SearchPricesInvoker = () =>
      Promise.resolve({
        data: {
          ok: true,
          results: [],
          providerErrorCount: 1,
          providerFailures: { rate_limited: 1, bogus: -4, text: 'x', float: 1.5 },
        },
        error: null,
      })
    const response = await fetchCardPriceResponse(CARD, { invoke, now: NOW })
    expect(response.providerFailures).toEqual({ rate_limited: 1 })
  })

  it.each([
    [null, undefined],
    ['rate_limited', undefined],
    [[1, 2], undefined],
    [{}, undefined],
    [{ a: Number.NaN }, undefined],
    [{ a: Number.MAX_SAFE_INTEGER + 2 }, undefined],
    [{ a: 2 }, { a: 2 }],
  ])('parseProviderFailures(%j)', (input, expected) => {
    expect(parseProviderFailures(input)).toEqual(expected)
  })
})
