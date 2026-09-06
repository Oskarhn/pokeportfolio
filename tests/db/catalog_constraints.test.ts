import { describe, expect, it } from 'vitest'
import { createServiceClient, mustDelete, seedCatalog, type TestClient } from './setup'

/**
 * M5 catalog schema corrections, exercised directly (docs/TESTING.md §5) — each test here
 * corresponds to a real defect found and fixed while building the ingest function, recorded in the
 * migration headers under supabase/migrations/2026082015*.
 */

const service: TestClient = createServiceClient()

describe('card_variants identity (finish/stamp/subtype, not a single enum)', () => {
  it('rejects a duplicate (card_id, finish, stamp, subtype, size)', async () => {
    const { error } = await service.from('card_variants').insert({
      card_id: seedCatalog.charizardCardId,
      finish: 'holo',
      stamp: '',
      subtype: 'unlimited',
      size: 'standard',
    })
    expect(error).not.toBeNull()
  })

  it('allows the same finish with a different stamp on the same card (holo, vs. holo + 1st-edition)', async () => {
    // Both rows already exist from the seed (charizardVariantId, charizardShadowlessFirstEditionVariantId)
    // — this test asserts the model can represent them as distinct rows, which is the point of the
    // finish/stamp/subtype split. Confirmed by reading both back rather than re-inserting.
    const { data, error } = await service
      .from('card_variants')
      .select('id, finish, stamp, subtype')
      .eq('card_id', seedCatalog.charizardCardId)
      .order('subtype')
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    expect(data?.[0]).toMatchObject({ finish: 'holo', subtype: 'shadowless', stamp: '1st-edition' })
    expect(data?.[1]).toMatchObject({ finish: 'holo', subtype: 'unlimited', stamp: '' })
  })
})

describe('provider product ids are informational, not unique (M5 schema correction)', () => {
  it('allows two sibling variants of the same card to share a TCGplayer product id', async () => {
    const shared = 'tcgplayer-shared-product-id-test'
    const first = await service.from('card_variants').insert({
      card_id: seedCatalog.pikachuCardId,
      finish: 'reverse',
      stamp: '',
      subtype: '',
      size: 'standard',
      tcgplayer_product_id: shared,
    })
    expect(first.error).toBeNull()

    const second = await service.from('card_variants').insert({
      card_id: seedCatalog.pikachuCardId,
      finish: 'other',
      stamp: 'test-second-finish',
      subtype: '',
      size: 'standard',
      tcgplayer_product_id: shared,
    })
    expect(second.error).toBeNull()
  })
})

describe('provider ids are scoped per language, not globally unique', () => {
  it('allows the same tcgdex_set_id in two different languages', async () => {
    // Real-world case this reproduces: TCGdex uses `neo1` for both English "Neo Genesis" and
    // Japanese "金、銀、新世界へ..." — see the M5 migration header. The seed fixture's English
    // `base1` set and Japanese `neo1` set already coexist; this asserts a *second* language row for
    // an id already used in English does not collide.
    const { error } = await service.from('card_sets').insert({
      series_id: seedCatalog.japaneseSeriesId,
      slug: 'base1',
      name: 'Base Set (test JA homonym)',
      language: 'ja',
      tcgdex_set_id: 'base1',
    })
    expect(error).toBeNull()

    await mustDelete(
      service.from('card_sets').delete().eq('tcgdex_set_id', 'base1').eq('language', 'ja'),
      "card_sets 'base1'/ja cleanup",
    )
  })

  it('rejects a genuine duplicate within the same language', async () => {
    const { error } = await service.from('card_sets').insert({
      series_id: seedCatalog.cardSeriesId,
      slug: 'base1-dup-test',
      name: 'Duplicate Base Set',
      language: 'en',
      tcgdex_set_id: 'base1',
    })
    expect(error).not.toBeNull()
  })
})

describe('cards.language must match its set (denormalization integrity trigger)', () => {
  it('rejects inserting a card whose language does not match its set', async () => {
    const { error } = await service.from('cards').insert({
      set_id: seedCatalog.cardSetId, // an 'en' set
      local_id: '999',
      name: 'Mismatched Language Card',
      language: 'ja',
    })
    expect(error).not.toBeNull()
  })

  it('rejects re-pointing a card to a set in a different language without updating language', async () => {
    const { data: created, error: insertError } = await service
      .from('cards')
      .insert({
        set_id: seedCatalog.cardSetId,
        local_id: '998',
        name: 'Temp Card For Trigger Test',
        language: 'en',
      })
      .select()
      .single()
    expect(insertError).toBeNull()

    const { error: updateError } = await service
      .from('cards')
      .update({ set_id: seedCatalog.japaneseSetId })
      .eq('id', created!.id)
    expect(updateError).not.toBeNull()

    await mustDelete(
      service.from('cards').delete().eq('id', created!.id),
      'cards cross-set cleanup',
    )
  })
})

describe('catalog_sync_runs is service-role only', () => {
  it('the service role can write a sync run row', async () => {
    const { error } = await service.from('catalog_sync_runs').insert({
      language: 'en',
      tcgdex_set_id: 'test-set',
      status: 'succeeded',
      cards_seen: 1,
      cards_upserted: 1,
      variants_upserted: 1,
    })
    expect(error).toBeNull()
    await mustDelete(
      service.from('catalog_sync_runs').delete().eq('tcgdex_set_id', 'test-set'),
      "catalog_sync_runs 'test-set' cleanup",
    )
  })
})
