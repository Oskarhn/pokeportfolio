import { describe, expect, it, vi } from 'vitest'
import {
  PriceCheckError,
  fetchCardPriceResponse,
  getLatestFxRate,
  priceCheckKeys,
  reasonForStatus,
  type SearchPricesInvoker,
} from '../../src/data/price-check'

// `src/data/price-check.ts` imports the real Supabase client, which refuses to start without
// configuration; every call below goes through an injected fake, so an empty stand-in is enough.
vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))

const CARD = '11111111-1111-4111-8111-111111111111'
const NOW = () => Date.parse('2026-09-20T10:00:00Z')

function ok(data: unknown): SearchPricesInvoker {
  return () => Promise.resolve({ data, error: null })
}
function httpError(status: number): SearchPricesInvoker {
  return () => Promise.resolve({ data: null, error: { context: { status } } })
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PriceCheckError) return error.reason
    return `non-PriceCheckError:${(error as Error).name}`
  }
  return 'resolved'
}

describe('fetchCardPriceResponse — each failure mode is named, none is "no price"', () => {
  it('stamps fetchedAt from the receipt clock and passes rows through untouched', async () => {
    const response = await fetchCardPriceResponse(CARD, {
      invoke: ok({ ok: true, results: [{ cardVariantId: 'v' }], providerErrorCount: 0 }),
      now: NOW,
    })
    expect(response).toEqual({
      fetchedAt: '2026-09-20T10:00:00.000Z',
      rows: [{ cardVariantId: 'v' }],
      providerErrorCount: 0,
    })
  })

  it('requests exactly one card per call (keeps providerErrorCount unambiguous)', async () => {
    const invoke = vi.fn<SearchPricesInvoker>(() =>
      Promise.resolve({ data: { ok: true, results: [] }, error: null }),
    )
    await fetchCardPriceResponse(CARD, { invoke, now: NOW })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]?.[1].body.cardIds).toEqual([CARD])
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
    [502, 'provider_error'],
    [400, 'provider_error'],
  ])('HTTP %i → %s', async (status, reason) => {
    expect(reasonForStatus(status)).toBe(reason)
    expect(await reasonOf(fetchCardPriceResponse(CARD, { invoke: httpError(status) }))).toBe(reason)
  })

  it('a thrown fetch failure is "network"', async () => {
    const invoke: SearchPricesInvoker = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(await reasonOf(fetchCardPriceResponse(CARD, { invoke }))).toBe('network')
  })

  it('an error object with no HTTP context is "network"', async () => {
    const invoke: SearchPricesInvoker = () =>
      Promise.resolve({ data: null, error: new Error('boom') })
    expect(await reasonOf(fetchCardPriceResponse(CARD, { invoke }))).toBe('network')
  })

  it.each([
    ['null body', null],
    ['ok:false', { ok: false, error: 'server_error' }],
    ['no results', { ok: true }],
    ['results not an array', { ok: true, results: {} }],
    ['string body', 'nope'],
  ])('malformed body (%s) → malformed_response', async (_n, data) => {
    expect(await reasonOf(fetchCardPriceResponse(CARD, { invoke: ok(data) }))).toBe(
      'malformed_response',
    )
  })

  it('carries providerErrorCount through; a garbage count is treated as 0', async () => {
    const withErrors = await fetchCardPriceResponse(CARD, {
      invoke: ok({ ok: true, results: [], providerErrorCount: 1 }),
    })
    expect(withErrors.providerErrorCount).toBe(1)
    const garbage = await fetchCardPriceResponse(CARD, {
      invoke: ok({ ok: true, results: [], providerErrorCount: 'many' }),
    })
    expect(garbage.providerErrorCount).toBe(0)
  })

  it('a cancelled lookup rejects as AbortError and never as a price failure', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await reasonOf(fetchCardPriceResponse(CARD, { signal: controller.signal, invoke: ok({}) })),
    ).toBe('non-PriceCheckError:AbortError')

    const late = new AbortController()
    const invoke: SearchPricesInvoker = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          late.abort()
          resolve({ data: { ok: true, results: [] }, error: null })
        }, 0)
      })
    // The response arrives after the caller left: it must not be delivered as a result.
    expect(await reasonOf(fetchCardPriceResponse(CARD, { signal: late.signal, invoke }))).toBe(
      'non-PriceCheckError:AbortError',
    )
  })
})

describe('getLatestFxRate', () => {
  const read = (data: { rate: unknown; rate_date: unknown } | null, error: string | null = null) =>
    vi.fn(() => Promise.resolve({ data, error: error === null ? null : { message: error } }))

  it('returns the NOK-per-major-unit rate and its date', async () => {
    const result = await getLatestFxRate('EUR', read({ rate: 11.54, rate_date: '2026-09-18' }))
    expect(result).toEqual({ ok: true, rate: { rateToNok: '11.54', rateDate: '2026-09-18' } })
  })

  it('asks for exactly the requested currency', async () => {
    const reader = read({ rate: 10.5, rate_date: '2026-09-18' })
    await getLatestFxRate('USD', reader)
    expect(reader).toHaveBeenCalledWith('USD')
  })

  it('no cached rate is "missing", a malformed one "malformed", a read failure throws', async () => {
    expect(await getLatestFxRate('EUR', read(null))).toEqual({ ok: false, reason: 'missing' })
    expect(await getLatestFxRate('EUR', read({ rate: 'x', rate_date: '2026-09-18' }))).toEqual({
      ok: false,
      reason: 'malformed',
    })
    await expect(getLatestFxRate('EUR', read(null, 'db down'))).rejects.toBeInstanceOf(
      PriceCheckError,
    )
  })

  it('never looks up NOK against itself', async () => {
    const reader = read({ rate: 1, rate_date: '2026-09-18' })
    expect(await getLatestFxRate('NOK', reader)).toEqual({ ok: false, reason: 'missing' })
    expect(reader).not.toHaveBeenCalled()
  })
})

describe('cache keys are built from exact identifiers, never a name', () => {
  it('differ per card, provider relay and currency', () => {
    expect(priceCheckKeys.raw('a')).not.toEqual(priceCheckKeys.raw('b'))
    expect(priceCheckKeys.fx('EUR')).not.toEqual(priceCheckKeys.fx('USD'))
    expect(priceCheckKeys.raw('a')).toContain('tcgdex-relay')
    expect(priceCheckKeys.fx('JPY')).toEqual(['price-check', 'fx', 'JPY', 'NOK'])
  })

  it('two cards that share a name still get distinct keys (ids, not names)', () => {
    expect(priceCheckKeys.raw('base1-4')).not.toEqual(priceCheckKeys.raw('sv3-125'))
  })
})
