import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceClient, mustDelete, seedCatalog, type TestClient } from './setup'

/**
 * P201 — collector-number matching in search_cards. The printed number on a card is often
 * zero-padded ("058/102"), the stored `local_id` is whatever the provider uses ("58" or "058"),
 * and the set size after the slash identifies WHICH set's card 58 is. Before the fix "Charizard 004"
 * found nothing for a set that stores "4", and "Pikachu 25" could not rank the real number 25 above
 * 125 / 250 when the set stored "025".
 *
 * Fixture isolation: two private sets and a card name no other suite uses.
 */

const service: TestClient = createServiceClient()
const NAME = 'Zorkmidian Prime'
const SLUG_A = 'p201-search-alpha'
const SLUG_B = 'p201-search-beta'
let alphaId = ''
let betaId = ''

interface Row {
  card_id: string
  local_id: string
  set_id: string
  set_name: string
}

async function search(query: string): Promise<Row[]> {
  const { data, error } = await service.rpc('search_cards', {
    p_query: query,
    p_language: 'en',
    p_limit: 50,
    p_offset: 0,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as Row[]
}

/** Local ids of the fixture's cards in the order search returned them, labelled by set. */
async function order(query: string): Promise<string[]> {
  return (await search(query))
    .filter((r) => r.set_id === alphaId || r.set_id === betaId)
    .map((r) => `${r.set_id === alphaId ? 'A' : 'B'}:${r.local_id}`)
}

beforeAll(async () => {
  const sets = await service
    .from('card_sets')
    .insert([
      {
        series_id: seedCatalog.cardSeriesId,
        slug: SLUG_A,
        name: 'P201 Alpha Set',
        language: 'en',
        card_count_official: 102,
        card_count_total: 110,
      },
      {
        series_id: seedCatalog.cardSeriesId,
        slug: SLUG_B,
        name: 'P201 Beta Set',
        language: 'en',
        card_count_official: 64,
        card_count_total: 64,
      },
    ])
    .select('id, slug')
  if (sets.error) throw new Error(sets.error.message)
  for (const row of sets.data as { id: string; slug: string }[]) {
    if (row.slug === SLUG_A) alphaId = row.id
    else betaId = row.id
  }
  const cards = [
    ...['058', '158', '580', 'TG05'].map((local_id) => ({ set_id: alphaId, local_id })),
    ...['58', '5', '4'].map((local_id) => ({ set_id: betaId, local_id })),
  ].map((c) => ({ ...c, name: NAME, language: 'en' }))
  const inserted = await service.from('cards').insert(cards)
  if (inserted.error) throw new Error(inserted.error.message)
})

afterAll(async () => {
  await mustDelete(service.from('cards').delete().in('set_id', [alphaId, betaId]), 'p201 cards')
  await mustDelete(service.from('card_sets').delete().in('id', [alphaId, betaId]), 'p201 sets')
})

describe('zero-padded and unpadded collector numbers find each other', () => {
  it('"058" finds the card stored as "58" as well as the one stored as "058"', async () => {
    const found = await order(`${NAME} 058`)
    expect(found).toContain('A:058')
    expect(found).toContain('B:58')
  })

  it('"58" finds the card stored as "058" as well as the one stored as "58"', async () => {
    const found = await order(`${NAME} 58`)
    expect(found).toContain('A:058')
    expect(found).toContain('B:58')
  })

  it('the exact number ranks above numbers that merely start or end with it', async () => {
    const found = await order(`${NAME} 58`)
    const exact = [found.indexOf('A:058'), found.indexOf('B:58')]
    for (const looseId of ['A:158', 'A:580']) {
      expect(found).toContain(looseId)
      for (const index of exact) expect(index).toBeLessThan(found.indexOf(looseId))
    }
  })

  it('"004" finds the card stored as "4"', async () => {
    expect(await order(`${NAME} 004`)).toContain('B:4')
  })

  it('a number that exists nowhere returns nothing for that name', async () => {
    expect(await order(`${NAME} 77`)).toEqual([])
  })
})

describe('the set size after the slash picks the set', () => {
  it('"58/102" ranks the 102-card set first', async () => {
    const found = await order(`${NAME} 58/102`)
    expect(found[0]).toBe('A:058')
    expect(found).toContain('B:58')
  })

  it('"058/64" ranks the 64-card set first', async () => {
    const found = await order(`${NAME} 058/64`)
    expect(found[0]).toBe('B:58')
    expect(found).toContain('A:058')
  })

  it('a set size that matches neither set does not hide the number match', async () => {
    const found = await order(`${NAME} 58/999`)
    expect(found).toEqual(expect.arrayContaining(['A:058', 'B:58']))
  })

  it('an absurdly long denominator is ignored rather than overflowing', async () => {
    const found = await order(`${NAME} 58/99999999999999999999`)
    expect(found).toEqual(expect.arrayContaining(['A:058', 'B:58']))
  })
})

describe('behaviour that must not change', () => {
  it('letter-prefixed numbers still match by suffix', async () => {
    expect(await order(`${NAME} TG05`)).toContain('A:TG05')
  })

  it('a name-only query still returns every card of that name', async () => {
    expect((await order(NAME)).length).toBe(7)
  })

  it('paging stays stable and complete across pages for a tie-heavy query', async () => {
    const pages: string[] = []
    for (let offset = 0; offset < 8; offset += 3) {
      const { data, error } = await service.rpc('search_cards', {
        p_query: NAME,
        p_language: 'en',
        p_limit: 3,
        p_offset: offset,
      })
      if (error) throw new Error(error.message)
      pages.push(...(data as { card_id: string }[]).map((r) => r.card_id))
    }
    expect(new Set(pages).size).toBe(pages.length)
    expect(pages).toHaveLength(7)
  })
})
