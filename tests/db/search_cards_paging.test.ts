import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceClient, mustDelete, seedCatalog, type TestClient } from './setup'

/**
 * search_cards pages with OFFSET, so its ORDER BY must be a total order (P169 F1, fixed by
 * 20260926120000_p173_search_cards_stable_paging.sql). The fixture is the shape that broke it: many
 * cards with the SAME name and the SAME collector number in different sets, so every sort key ties
 * and only the final unique key (`c.id`) decides the order.
 *
 * Before the fix the order among such rows was whatever the plan produced. Random card ids inserted
 * in random order made "ascending by id" fail with overwhelming probability, so this test is not
 * satisfied by luck (the mutant that drops `c.id asc` from the migration fails the ordering and the
 * page-walk assertions).
 */

const service: TestClient = createServiceClient()

interface Row {
  card_id: string
  name: string
  local_id: string
  set_id: string
  total_count: number
}

const NAME = 'P173 Pager Mon'
const TIED_SETS = 30
const PAGE = 7

const setIds: string[] = []
const cardIds: string[] = []

async function page(limit: number, offset: number, query = NAME): Promise<Row[]> {
  const { data, error } = await service.rpc('search_cards', {
    p_query: query,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as Row[]
}

async function walk(limit: number, query = NAME): Promise<Row[]> {
  const all: Row[] = []
  for (let offset = 0; offset < 500; offset += limit) {
    const rows = await page(limit, offset, query)
    all.push(...rows)
    if (rows.length < limit) break
  }
  return all
}

beforeAll(async () => {
  for (let i = 0; i < TIED_SETS; i += 1) {
    const { data: set, error: setError } = await service
      .from('card_sets')
      .insert({
        series_id: seedCatalog.cardSeriesId,
        slug: `p173-paging-${String(i)}`,
        name: `Zz Paging Set ${String(i)}`,
        language: 'en',
        tcgdex_set_id: `p173pg${String(i)}`,
      })
      .select('id')
      .single()
    if (setError) throw new Error(`set insert: ${setError.message}`)
    setIds.push(set.id)
    const { data: card, error: cardError } = await service
      .from('cards')
      .insert({
        set_id: set.id,
        local_id: '025',
        name: NAME,
        language: 'en',
        rarity: 'Common',
        category: 'Pokemon',
      })
      .select('id')
      .single()
    if (cardError) throw new Error(`card insert: ${cardError.message}`)
    cardIds.push(card.id)
  }
})

afterAll(async () => {
  await mustDelete(service.from('cards').delete().in('id', cardIds), 'paging fixture cards')
  await mustDelete(service.from('card_sets').delete().in('id', setIds), 'paging fixture sets')
})

describe('search_cards over a complete tie (same name, same number, different sets)', () => {
  it('orders tied rows by card id, ascending', async () => {
    const rows = await walk(PAGE)
    const ids = rows.map((r) => r.card_id)
    expect(ids).toEqual([...ids].sort())
  })

  it('pages neither repeat nor skip a row (7 per page over 30 tied rows)', async () => {
    const rows = await walk(PAGE)
    const ids = rows.map((r) => r.card_id)
    expect(ids).toHaveLength(TIED_SETS)
    expect(new Set(ids).size).toBe(TIED_SETS)
    expect([...ids].sort()).toEqual([...cardIds].sort())
    // Every page reports the same total.
    for (const offset of [0, 7, 14, 21, 28]) {
      const rowsAtOffset = await page(PAGE, offset)
      for (const r of rowsAtOffset) expect(r.total_count).toBe(TIED_SETS)
    }
  })

  it('returns the same sequence however the walk is chunked, and on every repeat', async () => {
    const reference = (await walk(PAGE)).map((r) => r.card_id)
    for (const limit of [1, 4, 11, 30, 100]) {
      expect((await walk(limit)).map((r) => r.card_id)).toEqual(reference)
    }
    for (let repeat = 0; repeat < 4; repeat += 1) {
      expect((await walk(PAGE)).map((r) => r.card_id)).toEqual(reference)
    }
  })

  it('still ranks the exact collector number first, then by name (ordering of distinct rows unchanged)', async () => {
    const rows = await page(50, 0, `${NAME} 025`)
    expect(rows.length).toBeGreaterThanOrEqual(TIED_SETS)
    // Every tied fixture row matches the number exactly; the seeded Pikachu #58 is not among them.
    const fixtureIds = new Set(cardIds)
    const leading = rows.slice(0, TIED_SETS)
    expect(leading.every((r) => fixtureIds.has(r.card_id))).toBe(true)
    const ids = leading.map((r) => r.card_id)
    expect(ids).toEqual([...ids].sort())
  })
})
