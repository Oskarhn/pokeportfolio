import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCardsByIds } from '../../src/data/catalog'

/**
 * F-28/F-29/P88 §16 — retrieval consistency between the scanner's visual-shortlist enrichment
 * channel and the text-search channel of the same scan. `search_cards` (backing text search)
 * already filters `is_active` and an optional `p_language`; `getCardsByIds` (backing the visual
 * shortlist's unknown-id enrichment, controller.ts) previously filtered neither — a deactivated
 * or wrong-language card could surface as a scan candidate through the visual channel even though
 * ordinary catalog search would never return it.
 */

const mocks = vi.hoisted(() => ({ from: vi.fn() }))

vi.mock('../../src/data/supabase-client', () => ({
  supabase: { from: mocks.from },
}))

afterEach(() => {
  vi.clearAllMocks()
})

const CARD_ROW = {
  id: 'card-1',
  name: 'Pikachu',
  local_id: '58',
  rarity: null,
  category: null,
  illustrator: null,
  image_base_url: null,
  language: 'en',
  set_id: 'set-1',
  card_sets: { name: 'Base Set' },
}

/** Minimal chainable stand-in for the supabase-js PostgREST builder, recording every `.eq()` call
 *  (id filter uses `.in()`, tracked separately) so tests can assert the exact filters issued. */
function fakeBuilder(result: { data: unknown; error: unknown }) {
  const eqCalls: unknown[][] = []
  const inCalls: unknown[][] = []
  const builder: Record<string, unknown> = {}
  builder['select'] = () => builder
  builder['in'] = (...args: unknown[]) => {
    inCalls.push(args)
    return builder
  }
  builder['eq'] = (...args: unknown[]) => {
    eqCalls.push(args)
    return builder
  }
  builder['then'] = (
    resolve?: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject)
  return { builder: builder as never, eqCalls, inCalls }
}

describe('getCardsByIds — F-28 is_active filter', () => {
  it('always filters is_active = true, mirroring search_cards', async () => {
    const { builder, eqCalls } = fakeBuilder({ data: [CARD_ROW], error: null })
    mocks.from.mockReturnValue(builder)
    await getCardsByIds(['card-1'])
    expect(eqCalls).toContainEqual(['is_active', true])
  })

  it('an id that fails is_active=true (deactivated since the index was built) is simply absent, never fabricated', async () => {
    // The real filter runs server-side; this pins the CLIENT contract — an empty result for an
    // id that was requested is handled as "not found," same as any other catalog gap.
    const { builder } = fakeBuilder({ data: [], error: null })
    mocks.from.mockReturnValue(builder)
    const result = await getCardsByIds(['inactive-card'])
    expect(result).toEqual([])
  })
})

describe('getCardsByIds — F-29 optional language filter', () => {
  it('filters by language when one is supplied, mirroring search_cards p_language', async () => {
    const { builder, eqCalls } = fakeBuilder({ data: [CARD_ROW], error: null })
    mocks.from.mockReturnValue(builder)
    await getCardsByIds(['card-1'], 'en')
    expect(eqCalls).toContainEqual(['language', 'en'])
  })

  it('omits the language filter when none is supplied (every language, matching prior behaviour)', async () => {
    const { builder, eqCalls } = fakeBuilder({ data: [CARD_ROW], error: null })
    mocks.from.mockReturnValue(builder)
    await getCardsByIds(['card-1'])
    expect(eqCalls.some((call) => call[0] === 'language')).toBe(false)
  })
})

describe('getCardsByIds — bounds', () => {
  it('never queries for an empty id list', async () => {
    const result = await getCardsByIds([])
    expect(result).toEqual([])
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('requests the requested ids via .in()', async () => {
    const { builder, inCalls } = fakeBuilder({ data: [CARD_ROW], error: null })
    mocks.from.mockReturnValue(builder)
    await getCardsByIds(['card-1', 'card-2'])
    expect(inCalls).toContainEqual(['id', ['card-1', 'card-2']])
  })
})
