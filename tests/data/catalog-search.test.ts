import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CatalogQueryError,
  setImageUrl,
  searchCards,
  searchSets,
  listRecentSets,
} from '../../src/data/catalog'
import { chooseSetVisual, initialsFor } from '../../src/features/catalog/set-visuals'
import { isAuthFailure, withAuthRetry } from '../../src/data/auth-retry'

/**
 * Deterministic, no-network tests for the P27 Search owner-feedback fixes: set-image URL
 * normalization against the real TCGdex asset-CDN shapes (probed 2026-08-24 — bare paths 404,
 * `.png`/`.webp` 200), the showcase's English-only pinning at the query layer, and the one-shot
 * defensive auth-retry behind the reported (never reproduced) "errored once, worked on the
 * second attempt" transient.
 */

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  refreshSession: vi.fn(),
}))

vi.mock('../../src/data/supabase-client', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { refreshSession: mocks.refreshSession },
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

/** Minimal chainable stand-in for the supabase-js PostgREST builder: records every filter call,
 *  then resolves like the real builder does when awaited. */
function fakeBuilder(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[][]> = {}
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'order', 'limit', 'eq', 'ilike']) {
    builder[method] = (...args: unknown[]) => {
      ;(calls[method] ??= []).push(args)
      return builder
    }
  }
  builder['then'] = (
    resolve?: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject)
  return {
    builder: builder as never,
    eqArgs: () => calls['eq'] ?? [],
    orderArgs: () => calls['order'] ?? [],
    limitArgs: () => calls['limit'] ?? [],
  }
}

describe('setImageUrl — TCGdex asset URL normalization', () => {
  it('appends .webp to a real English logo path (the deployed broken shape)', () => {
    // Real value stored in card_sets.logo_url for Base Set, probed 2026-08-24:
    // verbatim → 404; this output → 200 image/webp.
    expect(setImageUrl('https://assets.tcgdex.net/en/base/base1/logo')).toBe(
      'https://assets.tcgdex.net/en/base/base1/logo.webp',
    )
  })

  it('appends .webp to a symbol path under the /univ/ asset tree', () => {
    expect(setImageUrl('https://assets.tcgdex.net/univ/base/base2/symbol')).toBe(
      'https://assets.tcgdex.net/univ/base/base2/symbol.webp',
    )
  })

  it('leaves URLs that already carry an image extension untouched', () => {
    expect(setImageUrl('https://assets.tcgdex.net/en/sv/sv01/logo.png')).toBe(
      'https://assets.tcgdex.net/en/sv/sv01/logo.png',
    )
    expect(setImageUrl('https://example.test/art.webp')).toBe('https://example.test/art.webp')
  })

  it('inserts .webp before a query string, never after it', () => {
    expect(setImageUrl('https://assets.tcgdex.net/en/base/base1/logo?v=2')).toBe(
      'https://assets.tcgdex.net/en/base/base1/logo.webp?v=2',
    )
  })

  it('treats a query string as absent when testing for an existing extension', () => {
    // The extension lives on the path; `?v=2` must not defeat the already-normalized check.
    expect(setImageUrl('https://assets.tcgdex.net/en/sv/sv01/logo.png?v=2')).toBe(
      'https://assets.tcgdex.net/en/sv/sv01/logo.png?v=2',
    )
  })

  it('inserts .webp before a fragment', () => {
    expect(setImageUrl('https://example.test/logo#spec')).toBe(
      'https://example.test/logo.webp#spec',
    )
  })

  it('normalizes relative paths the same way — absoluteness is not part of the contract', () => {
    expect(setImageUrl('/en/base/base1/logo')).toBe('/en/base/base1/logo.webp')
    expect(setImageUrl('/en/base/base1/logo?v=2#frag')).toBe('/en/base/base1/logo.webp?v=2#frag')
  })

  it('maps absent upstream values to null — never to a fabricated URL or empty src', () => {
    expect(setImageUrl(null)).toBeNull()
    expect(setImageUrl(undefined)).toBeNull()
    expect(setImageUrl('')).toBeNull()
  })
})

describe('chooseSetVisual — deliberate fallbacks, never a broken-image icon', () => {
  it('prefers the logo when the set has both visuals', () => {
    const choice = chooseSetVisual('/logo.webp', '/symbol.webp', 'Base Set')
    expect(choice).toEqual({ kind: 'image', url: '/logo.webp', label: 'Base Set' })
  })

  it('falls back to the symbol for sets without a logo', () => {
    const choice = chooseSetVisual(null, '/symbol.webp', 'Jungle')
    expect(choice.kind).toBe('image')
    if (choice.kind === 'image') expect(choice.url).toBe('/symbol.webp')
  })

  it('resolves a set with neither visual (39 of 218 live en rows) to an initials tile', () => {
    const choice = chooseSetVisual(null, null, 'Miscellaneous Promos')
    expect(choice).toEqual({ kind: 'initials', label: 'MP' })
  })

  it('builds initials from the first two characters of a single-word name', () => {
    expect(initialsFor('Scarlet')).toBe('SC')
    expect(chooseSetVisual(null, null, 'Scarlet').label).toBe('SC')
  })
})

describe('listRecentSets — the showcase queries English only, at the source', () => {
  it('pins language=en as a structured catalog filter (never title matching)', async () => {
    const fake = fakeBuilder({ data: [], error: null })
    mocks.from.mockReturnValue(fake.builder)

    await listRecentSets({ language: 'en', limit: 300 })

    expect(fake.eqArgs()).toEqual([['language', 'en']])
    expect(mocks.from).toHaveBeenCalledWith('card_sets')
  })

  it('normalizes stale extension-less image URLs coming out of existing catalog rows', async () => {
    const fake = fakeBuilder({
      data: [
        {
          id: 'uuid-1',
          name: 'Base Set',
          language: 'en',
          released_on: '1999-01-09',
          card_count_official: 102,
          card_count_total: 102,
          logo_url: 'https://assets.tcgdex.net/en/base/base1/logo',
          symbol_url: null,
        },
        {
          id: 'uuid-2',
          name: 'Misc Promos',
          language: 'en',
          released_on: null,
          card_count_official: null,
          card_count_total: null,
          logo_url: '',
          symbol_url: '',
        },
      ],
      error: null,
    })
    mocks.from.mockReturnValue(fake.builder)

    const sets = await listRecentSets({ language: 'en', limit: 300 })

    expect(sets[0]!.logoUrl).toBe('https://assets.tcgdex.net/en/base/base1/logo.webp')
    expect(sets[0]!.symbolUrl).toBeNull()
    // Empty-string upstream values stay absent — the tile falls back to initials.
    expect(sets[1]!.logoUrl).toBeNull()
    expect(sets[1]!.symbolUrl).toBeNull()
  })

  it('still allows an unfiltered read when the caller asks for every language', async () => {
    const fake = fakeBuilder({ data: [], error: null })
    mocks.from.mockReturnValue(fake.builder)

    await listRecentSets({ language: null })

    expect(fake.eqArgs()).toEqual([])
  })

  it('orders newest-first with released_on (showcase browsing order unchanged)', async () => {
    const fake = fakeBuilder({ data: [], error: null })
    mocks.from.mockReturnValue(fake.builder)

    await listRecentSets({ language: 'en' })

    expect(fake.orderArgs()).toEqual([['released_on', { ascending: false, nullsFirst: false }]])
  })
})

describe('searchSets — same normalization on text-searched sets', () => {
  it('returns normalized image URLs so no Search surface renders the broken shape', async () => {
    const fake = fakeBuilder({
      data: [
        {
          id: 'uuid-3',
          name: 'Base Set',
          language: 'en',
          released_on: '1999-01-09',
          card_count_official: 102,
          card_count_total: 102,
          logo_url: 'https://assets.tcgdex.net/en/base/base1/logo',
          symbol_url: 'https://assets.tcgdex.net/univ/base/base2/symbol',
        },
      ],
      error: null,
    })
    mocks.from.mockReturnValue(fake.builder)

    const sets = await searchSets({ query: 'base', language: null })

    expect(sets[0]!.logoUrl).toBe('https://assets.tcgdex.net/en/base/base1/logo.webp')
    expect(sets[0]!.symbolUrl).toBe('https://assets.tcgdex.net/univ/base/base2/symbol.webp')
  })
})

describe('transient auth failure — recoverable Search state, exactly one replay', () => {
  it('classifies session-token rejections by their structured PostgREST code first', () => {
    // PGRST301 is the only structured code that means "the token was rejected — a refresh may
    // help"; every other code (RLS denial, missing grant, bad request) is never refreshable,
    // whatever its message says.
    expect(isAuthFailure(new CatalogQueryError({ message: 'JWT expired', code: 'PGRST301' }))).toBe(
      true,
    )
    expect(isAuthFailure(new CatalogQueryError({ message: 'JWT expired', code: '42P01' }))).toBe(
      false,
    )
    expect(
      isAuthFailure(new CatalogQueryError({ message: 'permission denied', code: '42501' })),
    ).toBe(false)
    // No code preserved → nothing structural to decide on; treated like any other Error below.
    expect(isAuthFailure(new CatalogQueryError({ message: 'JWT expired' }))).toBe(true)
  })

  it('keeps the narrow message fallback for errors without structured information, and never classifies configuration failures as refreshable', () => {
    expect(isAuthFailure(new Error('JWT expired'))).toBe(true)
    expect(isAuthFailure(new Error('JWS signature verification failed'))).toBe(true)
    expect(isAuthFailure(new Error('PGRST301'))).toBe(true)
    // Configuration failure: refreshSession() cannot repair the client's configured API key,
    // so this must propagate immediately (P30 review finding) instead of burning a round trip.
    expect(isAuthFailure(new Error('Invalid API key'))).toBe(false)
    expect(isAuthFailure(new Error('permission denied for function search_cards'))).toBe(false)
    expect(isAuthFailure(new Error('fetch failed'))).toBe(false)
    expect(isAuthFailure('not an error object')).toBe(false)
  })

  it('replays the operation once after refreshing the session, then succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('JWT expired'))
      .mockResolvedValueOnce('second attempt works')
    mocks.refreshSession.mockResolvedValue({ error: null })

    await expect(withAuthRetry(operation)).resolves.toBe('second attempt works')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('never retries non-auth failures and never touches the session', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('fetch failed'))
    mocks.refreshSession.mockResolvedValue({ error: null })

    await expect(withAuthRetry(operation)).rejects.toThrow('fetch failed')

    expect(operation).toHaveBeenCalledTimes(1)
    expect(mocks.refreshSession).not.toHaveBeenCalled()
  })

  it('surfaces the original error when even the refresh fails', async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('JWT expired'))
    mocks.refreshSession.mockResolvedValue({ error: new Error('offline') })

    await expect(withAuthRetry(operation)).rejects.toThrow('JWT expired')

    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('propagates the second failure after the single replay — never a retry storm', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new CatalogQueryError({ message: 'JWT expired or is invalid', code: 'PGRST301' }),
      )
      .mockRejectedValueOnce(new Error('still failing after refresh'))
    mocks.refreshSession.mockResolvedValue({ error: null })

    await expect(withAuthRetry(operation)).rejects.toThrow('still failing after refresh')

    expect(operation).toHaveBeenCalledTimes(2)
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('recovers a real Search call end-to-end when PostgREST reports PGRST301 as a structured code', async () => {
    const row = {
      card_id: 'card-uuid',
      name: 'Pikachu',
      local_id: '58',
      rarity: null,
      category: 'Pokemon',
      illustrator: null,
      image_base_url: 'https://assets.tcgdex.net/en/base/base1/58',
      language: 'en',
      set_id: 'set-uuid',
      set_name: 'Base Set',
      variant_count: 2,
      total_count: 1,
    }
    mocks.rpc
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: 'JWT expired or is invalid',
          details: null,
          hint: null,
          code: 'PGRST301',
        },
      })
      .mockResolvedValueOnce({ data: [row], error: null })
    mocks.refreshSession.mockResolvedValue({ error: null })

    const page = await searchCards({ query: 'pikachu', language: null })

    expect(page.results).toHaveLength(1)
    expect(page.results[0]!.cardId).toBe('card-uuid')
    expect(page.totalCount).toBe(1)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('still recovers through the message fallback when no code survived upstream', async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: null,
        // Non-JSON error bodies collapse to `{ message }` with no structured code.
        error: { message: 'JWT expired', details: null, hint: null, code: null },
      })
      .mockResolvedValueOnce({ data: [], error: null })
    mocks.refreshSession.mockResolvedValue({ error: null })

    await searchCards({ query: 'pikachu', language: null })

    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('never retries an invalid API key — configuration failure propagates untouched', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'Invalid API key', details: null, hint: null, code: null },
    })

    await expect(searchCards({ query: 'pikachu', language: null })).rejects.toThrow(
      'Invalid API key',
    )

    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.refreshSession).not.toHaveBeenCalled()
  })
})
