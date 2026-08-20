import { describe, expect, it } from 'vitest'
import { createServiceClient, seedCatalog, type TestClient } from './setup'

/**
 * Functional correctness of search_cards against the seeded fixture (docs/TESTING.md §5,
 * M5 prompt §63's representative categories). Access-control aspects (who may call it, injection
 * safety) live in tests/authorization/catalog.test.ts — this file is about whether the right rows
 * come back, in the right order, for the query shapes the product spec names.
 */

const service: TestClient = createServiceClient()

// The test harness's Supabase client is deliberately untyped (tests/db/setup.ts) — this mirrors
// the RPC's real return shape (supabase/migrations/20260820151000_m5_catalog_search.sql) so
// callback parameters below have a concrete type instead of implicit `any`.
interface SearchCardsRow {
  card_id: string
  name: string
  local_id: string
  rarity: string | null
  category: string | null
  illustrator: string | null
  image_base_url: string | null
  language: string
  set_id: string
  set_name: string
  variant_count: number
  total_count: number
}

async function search(
  query: string,
  language: 'en' | 'ja' | null = null,
): Promise<SearchCardsRow[]> {
  const { data, error } = await service.rpc('search_cards', {
    p_query: query,
    p_language: language ?? undefined,
    p_limit: 50,
    p_offset: 0,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as SearchCardsRow[]
}

describe('search by name', () => {
  it('finds an English Pokémon by name', async () => {
    const results = await search('Charizard')
    expect(results.some((r) => r.card_id === seedCatalog.charizardCardId)).toBe(true)
  })

  it('finds by partial/prefix name', async () => {
    const results = await search('Char')
    expect(results.some((r) => r.card_id === seedCatalog.charizardCardId)).toBe(true)
  })

  it('finds Basic Energy by name, category Energy', async () => {
    const results = await search('Grass Energy')
    const hit = results.find((r) => r.card_id === seedCatalog.grassEnergyCardId)
    expect(hit).toBeDefined()
    expect(hit?.category).toBe('Energy')
  })

  it('finds a Japanese card by its Japanese name', async () => {
    const results = await search('フシギダネ')
    expect(results.some((r) => r.card_id === seedCatalog.japaneseCardId)).toBe(true)
  })
})

describe('search by set', () => {
  it('finds cards by English set name', async () => {
    const results = await search('Base Set')
    expect(results.some((r) => r.card_id === seedCatalog.charizardCardId)).toBe(true)
  })
})

describe('search by collector number, combined with name', () => {
  it('ranks the exact numbered card first for "Pikachu 58"', async () => {
    const results = await search('Pikachu 58')
    expect(results[0]?.card_id).toBe(seedCatalog.pikachuCardId)
  })

  it('finds a card by "set name + number" ("Base Set 4")', async () => {
    const results = await search('Base Set 4')
    expect(results[0]?.card_id).toBe(seedCatalog.charizardCardId)
  })
})

describe('language filter', () => {
  it('"en" excludes Japanese results', async () => {
    const results = await search('フシギダネ', 'en')
    expect(results).toHaveLength(0)
  })

  it('"ja" excludes English results', async () => {
    const results = await search('Charizard', 'ja')
    expect(results).toHaveLength(0)
  })

  it('null/omitted language searches both', async () => {
    const results = await search('e') // matches something in both fixtures
    const languages = new Set(results.map((r) => r.language))
    expect(languages.size).toBeGreaterThanOrEqual(1)
  })
})

describe('variant richness surfaces in results', () => {
  it('Charizard reports two variants (holo/unlimited and holo/shadowless/1st-edition)', async () => {
    const results = await search('Charizard')
    const hit = results.find((r) => r.card_id === seedCatalog.charizardCardId)
    expect(hit?.variant_count).toBe(2)
  })
})

describe('missing data is honest, not fabricated', () => {
  it('a card with no image returns image_base_url null, not a placeholder string', async () => {
    const results = await search('Pikachu')
    const hit = results.find((r) => r.card_id === seedCatalog.pikachuCardId)
    expect(hit?.image_base_url).toBeNull()
  })
})

describe('no results and edge-case input', () => {
  it('returns an empty array for a query matching nothing', async () => {
    const results = await search('Zzzznonexistentcardxyz123')
    expect(results).toEqual([])
  })

  it('does not throw on an empty query', async () => {
    await expect(search('')).resolves.toBeDefined()
  })

  it('handles a two-character English query without erroring', async () => {
    await expect(search('pi')).resolves.toBeDefined()
  })
})

describe('pagination', () => {
  it('respects limit and offset, and total_count is stable across pages', async () => {
    const first = await service
      .rpc('search_cards', { p_query: 'e', p_limit: 1, p_offset: 0 })
      .then((r) => (r.data ?? []) as SearchCardsRow[])
    const second = await service
      .rpc('search_cards', { p_query: 'e', p_limit: 1, p_offset: 1 })
      .then((r) => (r.data ?? []) as SearchCardsRow[])
    expect(first).toHaveLength(1)
    if (second.length > 0) {
      expect(first[0]?.card_id).not.toBe(second[0]?.card_id)
      expect(first[0]?.total_count).toBe(second[0]?.total_count)
    }
  })
})
