import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * M7: custom collections (CRUD + cross-tenant attacks, DATA_MODEL.md §5.2.1) and the
 * `list_portfolio`/`portfolio_counts` RPCs (sort, filter, keyset pagination, isolation).
 * docs/TESTING.md §4-5, SECURITY.md §3.3.
 */

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser
let clientA: TestClient
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'm7-portfolio-a')
  userB = await createSyntheticUser(service, 'm7-portfolio-b')
  clientA = await signInAs(userA)
  clientB = await signInAs(userB)
})

afterAll(async () => {
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

interface AddResult {
  holding_id: string
  lot_id: string
}

async function addCard(
  client: TestClient,
  args: Record<string, unknown>,
): Promise<{ data: AddResult | null; error: { message: string } | null }> {
  const result = await client.rpc('add_card_acquisition', args).maybeSingle()
  return { data: result.data as AddResult | null, error: result.error }
}

interface PortfolioRow {
  holding_id: string
  card_name: string | null
  quantity: number
  condition: string | null
  is_favorite: boolean
}

/** Thin wrapper, same convention as `addCard` above — the clients in this directory are
 *  deliberately untyped (tests/db/setup.ts's own note), so the RPC's result is cast rather than
 *  inferred. */
async function listPortfolio(
  client: TestClient,
  args: Record<string, unknown>,
): Promise<{ data: PortfolioRow[]; error: { message: string } | null }> {
  const result = await client.rpc('list_portfolio', args)
  return { data: (result.data ?? []) as PortfolioRow[], error: result.error }
}

describe('custom_collections: CRUD', () => {
  it('creates, renames, browses and deletes a collection', async () => {
    const { data: created, error: createError } = await clientA
      .from('custom_collections')
      .insert({ name: 'Trade Binder' })
      .select('id, name')
      .single()
    expect(createError).toBeNull()
    expect(created?.name).toBe('Trade Binder')

    const { error: renameError } = await clientA
      .from('custom_collections')
      .update({ name: 'Binder A' })
      .eq('id', created!.id)
    expect(renameError).toBeNull()

    const { data: listed } = await clientA
      .from('custom_collections')
      .select('id, name')
      .eq('id', created!.id)
    expect(listed).toEqual([{ id: created!.id, name: 'Binder A' }])

    const { error: deleteError } = await clientA
      .from('custom_collections')
      .delete()
      .eq('id', created!.id)
    expect(deleteError).toBeNull()

    const { data: afterDelete } = await clientA
      .from('custom_collections')
      .select('id')
      .eq('id', created!.id)
    expect(afterDelete).toEqual([])
  })

  it('adds and removes a holding from a collection; one holding may belong to several', async () => {
    const added = await addCard(clientA, {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    const { data: c1 } = await clientA
      .from('custom_collections')
      .insert({ name: 'Collection one' })
      .select('id')
      .single()
    const { data: c2 } = await clientA
      .from('custom_collections')
      .insert({ name: 'Collection two' })
      .select('id')
      .single()

    const { error: insert1 } = await clientA
      .from('custom_collection_members')
      .insert({ collection_id: c1!.id, holding_id: added.data!.holding_id })
    const { error: insert2 } = await clientA
      .from('custom_collection_members')
      .insert({ collection_id: c2!.id, holding_id: added.data!.holding_id })
    expect(insert1).toBeNull()
    expect(insert2).toBeNull()

    const { data: memberships } = await clientA
      .from('custom_collection_members')
      .select('collection_id')
      .eq('holding_id', added.data!.holding_id)
    expect(memberships).toHaveLength(2)

    const { error: removeError } = await clientA
      .from('custom_collection_members')
      .delete()
      .eq('collection_id', c1!.id)
      .eq('holding_id', added.data!.holding_id)
    expect(removeError).toBeNull()

    const { data: remaining } = await clientA
      .from('custom_collection_members')
      .select('collection_id')
      .eq('holding_id', added.data!.holding_id)
    expect(remaining).toEqual([{ collection_id: c2!.id }])
  })
})

describe('custom_collections: cross-tenant attacks', () => {
  it("a stranger cannot read another user's collection", async () => {
    const { data: mine } = await clientA
      .from('custom_collections')
      .insert({ name: 'Private binder' })
      .select('id')
      .single()

    const { data: strangerView, error } = await clientB
      .from('custom_collections')
      .select('id')
      .eq('id', mine!.id)
    expect(error).toBeNull()
    expect(strangerView).toEqual([])
  })

  it("a stranger cannot delete another user's collection", async () => {
    const { data: mine } = await clientA
      .from('custom_collections')
      .insert({ name: 'Not yours' })
      .select('id')
      .single()

    await clientB.from('custom_collections').delete().eq('id', mine!.id)

    const { data: stillThere } = await service
      .from('custom_collections')
      .select('id')
      .eq('id', mine!.id)
    expect(stillThere).toHaveLength(1)
  })

  it("a stranger cannot add their own holding to another user's collection", async () => {
    const { data: mine } = await clientA
      .from('custom_collections')
      .insert({ name: 'Off limits' })
      .select('id')
      .single()
    const strangersCard = await addCard(clientB, {
      p_card_variant_id: seedCatalog.japaneseVariantId,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })

    const { error } = await clientB
      .from('custom_collection_members')
      .insert({ collection_id: mine!.id, holding_id: strangersCard.data!.holding_id })
    expect(error).not.toBeNull()
  })

  it("a stranger cannot add another user's holding to their own collection", async () => {
    const myCard = await addCard(clientA, {
      p_card_variant_id: seedCatalog.charizardVariantId,
      p_condition: 'EX',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    const { data: strangersCollection } = await clientB
      .from('custom_collections')
      .insert({ name: "B's collection" })
      .select('id')
      .single()

    const { error } = await clientB
      .from('custom_collection_members')
      .insert({ collection_id: strangersCollection!.id, holding_id: myCard.data!.holding_id })
    expect(error).not.toBeNull()
  })

  it("a stranger cannot remove membership from another user's collection", async () => {
    const myCard = await addCard(clientA, {
      p_card_variant_id: seedCatalog.pikachuVariantId,
      p_condition: 'LP',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    const { data: mine } = await clientA
      .from('custom_collections')
      .insert({ name: 'Guarded' })
      .select('id')
      .single()
    const { error: setupError } = await clientA
      .from('custom_collection_members')
      .insert({ collection_id: mine!.id, holding_id: myCard.data!.holding_id })
    expect(setupError).toBeNull()

    await clientB
      .from('custom_collection_members')
      .delete()
      .eq('collection_id', mine!.id)
      .eq('holding_id', myCard.data!.holding_id)

    const { data: stillMember } = await service
      .from('custom_collection_members')
      .select('collection_id')
      .eq('collection_id', mine!.id)
      .eq('holding_id', myCard.data!.holding_id)
    expect(stillMember).toHaveLength(1)
  })
})

describe('list_portfolio: isolation, sort and filter', () => {
  it("never returns another user's holdings", async () => {
    const strangersCard = await addCard(clientB, {
      p_card_variant_id: seedCatalog.grassEnergyVariantId,
      p_condition: 'NM',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })

    const { data, error } = await listPortfolio(clientA, { p_sort: 'name_asc', p_limit: 100 })
    expect(error).toBeNull()
    expect(data.some((row) => row.holding_id === strangersCard.data!.holding_id)).toBe(false)
  })

  it('name_asc sorts alphabetically by the card or manual name', async () => {
    const { data, error } = await listPortfolio(clientA, { p_sort: 'name_asc', p_limit: 100 })
    expect(error).toBeNull()
    const names = data.map((row) => (row.card_name ?? '').toLowerCase())
    expect(names).toEqual([...names].sort())
  })

  it('filters by favourite', async () => {
    const favCard = await addCard(clientA, {
      p_card_variant_id: seedCatalog.charizardShadowlessFirstEditionVariantId,
      p_condition: 'MT',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
      p_is_favorite: true,
    })

    const { data, error } = await listPortfolio(clientA, {
      p_sort: 'name_asc',
      p_limit: 100,
      p_favorite: true,
    })
    expect(error).toBeNull()
    expect(data.every((row) => row.is_favorite)).toBe(true)
    expect(data.some((row) => row.holding_id === favCard.data!.holding_id)).toBe(true)
  })

  it('filters by a custom collection', async () => {
    const card = await addCard(clientA, {
      p_card_variant_id: seedCatalog.japaneseVariantId,
      p_condition: 'GD',
      p_origin: 'pre_tracking',
      p_cost_basis_state: 'unknown',
      p_quantity: 1,
      p_acquired_on: today,
    })
    const { data: collection } = await clientA
      .from('custom_collections')
      .insert({ name: 'Filter test collection' })
      .select('id')
      .single()
    const { error: setupError } = await clientA
      .from('custom_collection_members')
      .insert({ collection_id: collection!.id, holding_id: card.data!.holding_id })
    expect(setupError).toBeNull()

    const { data, error } = await listPortfolio(clientA, {
      p_sort: 'name_asc',
      p_limit: 100,
      p_custom_collection_id: collection!.id,
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data[0]?.holding_id).toBe(card.data!.holding_id)
  })

  it('keyset pagination returns every matching holding exactly once, in order', async () => {
    const { data: fullPage, error: fullError } = await listPortfolio(clientA, {
      p_sort: 'name_asc',
      p_limit: 100,
    })
    expect(fullError).toBeNull()
    expect(fullPage.length).toBeGreaterThan(1)

    const seen: string[] = []
    let cursor: {
      p_cursor_holding_id?: string
      p_cursor_name?: string
    } = {}
    for (let i = 0; i < fullPage.length + 1; i += 1) {
      const { data: page, error } = await listPortfolio(clientA, {
        p_sort: 'name_asc',
        p_limit: 1,
        ...cursor,
      })
      expect(error).toBeNull()
      const first = page[0]
      if (!first) break
      seen.push(first.holding_id)
      cursor = {
        p_cursor_holding_id: first.holding_id,
        p_cursor_name: first.card_name ?? '',
      }
    }

    expect(seen).toEqual(fullPage.map((row) => row.holding_id))
    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('natural_sort_key (M7.1 prompt §41/§72)', () => {
  it('orders numeric runs numerically, not lexically, and keeps a stable alphanumeric fallback', async () => {
    const { data, error } = await clientA.rpc('natural_sort_key', { p_text: '4/102' })
    expect(error).toBeNull()
    expect(data).toBe('00000004/00000102')

    const cases: [string, string][] = [
      ['9', '00000009'],
      ['10', '00000010'],
      ['H31', 'h00000031'],
      ['TG12', 'tg00000012'],
      ['SV049', 'sv00000049'],
    ]
    for (const [input, expected] of cases) {
      const result = await clientA.rpc('natural_sort_key', { p_text: input })
      expect(result.error).toBeNull()
      expect(result.data).toBe(expected)
    }
  })
})

describe('list_portfolio: number_asc/number_desc (M7.1 prompt §41/§72)', () => {
  it('sorts manual-card holdings by collector number, numerically within digit runs', async () => {
    const numbers = ['9', '10', '2']
    const holdingIds: string[] = []
    for (const number of numbers) {
      const { data: manual, error: manualError } = await clientA
        .from('manual_card_definitions')
        .insert({ name: `Number sort test ${number}`, collector_number: number })
        .select('id')
        .single()
      expect(manualError).toBeNull()
      const added = await addCard(clientA, {
        p_manual_card_id: manual!.id,
        p_condition: 'NM',
        p_origin: 'pre_tracking',
        p_cost_basis_state: 'unknown',
        p_quantity: 1,
        p_acquired_on: today,
      })
      expect(added.error).toBeNull()
      holdingIds.push(added.data!.holding_id)
    }

    const { data, error } = await listPortfolio(clientA, { p_sort: 'number_asc', p_limit: 500 })
    expect(error).toBeNull()
    const ours = data
      .filter((row) => holdingIds.includes(row.holding_id))
      .map((row) => row.holding_id)
    // Ascending: "2" then "9" then "10" — a plain string sort would put "10" before "2".
    expect(ours).toEqual([holdingIds[2], holdingIds[0], holdingIds[1]])

    const { data: desc, error: descError } = await listPortfolio(clientA, {
      p_sort: 'number_desc',
      p_limit: 500,
    })
    expect(descError).toBeNull()
    const oursDesc = desc
      .filter((row) => holdingIds.includes(row.holding_id))
      .map((row) => row.holding_id)
    expect(oursDesc).toEqual([holdingIds[1], holdingIds[0], holdingIds[2]])
  })
})

describe('portfolio_counts', () => {
  it("counts only the caller's own open holdings", async () => {
    const result = await clientA.rpc('portfolio_counts').single()
    const counts = result.data as {
      physical_card_count: string
      unique_holding_count: string
    } | null
    expect(result.error).toBeNull()
    const { data: rows } = await listPortfolio(clientA, { p_sort: 'name_asc', p_limit: 1000 })

    expect(Number(counts!.unique_holding_count)).toBe(rows.length)
    expect(Number(counts!.physical_card_count)).toBe(
      rows.reduce((sum, row) => sum + row.quantity, 0),
    )
  })
})
