import { convert } from '@shared/domain/fx'
import { createReleasedPriceCheckPort } from '../../src/price-check/released-adapter'
import type { PriceLookup } from '../../src/price-check/types'
import { backendDescribe, catalog, fixture, newSession, psql, realRuntime, until } from './support'

/**
 * Price Check against what the RELEASED backend (DB 104) can really supply: catalog + real
 * price_snapshots history (converted to NOK by the server). Includes the read-only invariants:
 * the request log holds only reads, and the ledger tables are byte-identical afterwards.
 */
backendDescribe('Price Check (released interface) against the real local backend', () => {
  const { a } = fixture().users
  const cat = catalog()

  async function ready() {
    const session = newSession()
    const runtime = realRuntime(session)
    await runtime.auth.signIn(a.email, a.password)
    await until(() => runtime.auth.getSnapshot().userId === a.id)
    return { session, runtime, port: createReleasedPriceCheckPort() }
  }

  const available = (r: PriceLookup) => {
    if (r.status !== 'available') throw new Error(`expected available, got ${r.reason}`)
    return r
  }

  it('search finds the synthetic card and its two variants are distinct identities', async () => {
    const { port } = await ready()
    const hits = await port.searchCards('Twin Finish')
    expect(hits.map((h) => h.name)).toContain('P158 Twin Finish')
    expect(hits.find((h) => h.name === 'P158 Twin Finish')?.variantCount).toBe(2)
    const loaded = await port.loadCard(cat.S01?.cardId as string)
    expect(loaded?.variants.map((v) => v.finish).sort()).toEqual(['holo', 'normal'])
  })

  it('two finishes of ONE card have DIFFERENT prices, each equal to the exact shared-domain conversion', async () => {
    const { port } = await ready()
    const cardId = cat.S01?.cardId as string
    const normal = available(await port.lookup(cardId, cat.S01?.variants.normal as string))
    const holo = available(await port.lookup(cardId, cat.S01?.variants.holo as string))

    // Seeded: EUR 1234 (normal) and 98765 (holo) minor units, fx 11.5 NOK per EUR.
    const expectedNormal = convert({ minorUnits: 1234n, currency: 'EUR' }, '11.5', 'NOK').minorUnits
    const expectedHolo = convert({ minorUnits: 98765n, currency: 'EUR' }, '11.5', 'NOK').minorUnits
    expect(normal.observations).toHaveLength(1)
    expect(normal.observations[0]?.nok?.minorUnits).toBe(expectedNormal)
    expect(holo.observations[0]?.nok?.minorUnits).toBe(expectedHolo)
    expect(expectedNormal).not.toBe(expectedHolo)
    // Honest about what this endpoint cannot say.
    expect(normal.observations[0]).toMatchObject({
      source: null,
      metric: null,
      kind: 'unknown',
      condition: null,
      synthetic: false,
    })
    expect(normal.graded).toEqual({ status: 'unavailable', reason: 'graded_source_not_configured' })
  })

  it('a value at 2^58 scale: the SERVER conversion equals the exact domain conversion', async () => {
    const { port } = await ready()
    const r = available(
      await port.lookup(cat.S03?.cardId as string, cat.S03?.variants.normal as string),
    )
    const expected = convert(
      { minorUnits: 288230376151711745n, currency: 'EUR' },
      '11.5',
      'NOK',
    ).minorUnits
    expect(r.observations[0]?.nok?.minorUnits).toBe(expected)
  })

  it('the released history RPC returns ONE provider per variant: the profile preference (use_eu_pricing, default Cardmarket)', async () => {
    const { port } = await ready()
    // S06 has BOTH a Cardmarket (EUR) and a TCGplayer (USD) snapshot, but get_card_variant_price_history
    // resolves the provider by the caller's profile (D-052), so a released-interface Price Check cannot
    // show the two side by side. P153's observations[] can; see docs/mobile/PRICE_CHECK_CONTRACT.md.
    const r = available(
      await port.lookup(cat.S06?.cardId as string, cat.S06?.variants.normal as string),
    )
    expect(r.observations.map((o) => o.provider)).toEqual(['tcgdex_cardmarket'])
    expect(r.observations[0]?.nok?.minorUnits).toBe(
      convert({ minorUnits: 4200n, currency: 'EUR' }, '11.5', 'NOK').minorUnits,
    )
  })

  it('a variant with no snapshot is "no price", never zero', async () => {
    const { port } = await ready()
    expect(
      await port.lookup(cat.S02?.cardId as string, cat.S02?.variants.normal as string),
    ).toMatchObject({ status: 'unavailable', reason: 'no_variant_price' })
  })

  it("a holding's variant id resolves back to its card (Card detail -> Price Check)", async () => {
    const { port } = await ready()
    expect(await port.resolveVariant(cat.S01?.variants.holo as string)).toEqual({
      cardId: cat.S01?.cardId,
      variantId: cat.S01?.variants.holo,
    })
    expect(await port.resolveVariant('00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('READ-ONLY INVARIANT: a full Price Check journey sends only reads and leaves every ledger table byte-identical', async () => {
    const TABLES = [
      'holdings',
      'acquisition_lots',
      'manual_valuations',
      'manual_card_definitions',
      'lot_cost_adjustments',
      'purchases',
      'purchase_lines',
      'sales',
      'sale_lines',
      'lot_disposals',
      'sealed_products',
      'openings',
      'price_snapshots',
      'fx_rates',
    ]
    const digest = () =>
      TABLES.map((t) =>
        psql(
          `select '${t}', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from (select * from public.${t}) x;`,
        ),
      ).join('\n')
    const before = digest()

    const { session, runtime } = await ready()
    session.log.length = 0
    const pc = runtime.priceCheck
    pc.setQuery('P158')
    await pc.search()
    await pc.openCard(cat.S01?.cardId as string) // two variants: choice required
    await pc.chooseVariant(cat.S01?.variants.holo as string)
    await pc.openVariant(cat.S06?.variants.normal as string)
    await pc.openCard(cat.S02?.cardId as string)
    expect(pc.getSnapshot().lookup.status).toBe('ready')

    const wire = session.log.map((e) => `${e.method} ${e.path}`)
    expect(wire.length).toBeGreaterThan(5)
    for (const call of wire) {
      expect(call).toMatch(
        /^(GET \/rest\/v1\/(cards|card_variants)|POST \/rest\/v1\/rpc\/(search_cards|get_card_variant_price_history)|POST \/auth\/v1\/token)$/,
      )
    }
    expect(wire.some((c) => /rpc\/(create|update|delete|add|record|set|reset)/.test(c))).toBe(false)
    expect(digest()).toBe(before)
  })
})
