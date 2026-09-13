/**
 * M16 ECONOMIC ORACLE — DB-backed, IMPLEMENTATION_GATED.
 *
 * The central invariant: OPENING DOES NOT CREATE SPEND. For a linked sealed
 * purchase, GPO before = GPO after and CS before = CS after, byte-exact.
 * Opening changes OWNERSHIP FORM only. Pulled-card individual cost basis is
 * NULL — never zero. The opening owns the analytical cost.
 *
 * Everything here skips on current main (no openings schema) and runs for real
 * against an M16 branch. Divergence from the contract fails as [M16 CONTRACT].
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'
import {
  bindOpeningCreateArgs,
  bindOpeningIdOnlyArgs,
  disposeM16DiscoverySession,
  findReadRpcs,
  hasSupabaseEnv,
  requireCreateOpeningRpc,
  resolvePullSurface,
  skipUnlessM16,
} from '../helpers/contract'
import {
  createIsolatedSealedProduct,
  createSealedPurchase,
  disposalsForLot,
  findKey,
  findMoney,
  lotById,
  pullLotsForOpening,
  spendSummary,
  type RowLike,
  type SpendSummary,
} from '../helpers/fixtures'

const today = new Date().toISOString().slice(0, 10)

describe.skipIf(!hasSupabaseEnv())('M16 economic oracle — opening does not create spend', () => {
  let service: TestClient
  let userA: SyntheticUser
  let clientA: TestClient

  beforeAll(async () => {
    const { createServiceClient } = await import('../../db/setup')
    service = createServiceClient()
    userA = await createSyntheticUser(service, 'm16adv-eco')
    clientA = await signInAs(userA)

    // price_snapshots is shared market data keyed on the fixed seedCatalog variant id, not
    // scoped to this file's synthetic user — it is not reset between test files within one
    // database lifetime. Two cases below (P56 §16-C, §20) depend on seedCatalog.japaneseVariantId
    // genuinely having NO price observation, which is only guaranteed on a pristine database:
    // tests/db/m91_value_pagination.test.ts plants a real (zero-value) snapshot for this exact
    // variant, and when that file runs earlier in the same database (e.g. as part of the full
    // `pnpm test:db` suite, with no reset before this file runs) it survives and makes this file's
    // "genuinely unpriced" precondition false — a shared-catalog test-isolation gap, not a product
    // defect. Same convention m91 itself already uses for the variants its own fixture depends on.
    await service
      .from('price_snapshots')
      .delete()
      .eq('card_variant_id', seedCatalog.japaneseVariantId)
  }, 120_000)

  afterAll(async () => {
    if (service && userA) await deleteSyntheticUser(service, userA.id)
    await disposeM16DiscoverySession()
  }, 60_000)

  /** Seeds product + 10-pack/59900 øre purchase; returns the ids the cases need. */
  async function seedTenPackPurchase(): Promise<{
    productId: string
    purchaseId: string
    lotId: string
    spendBefore: SpendSummary
    purchaseRowBefore: RowLike
  }> {
    const productId = await createIsolatedSealedProduct(service, userA.id, 'eco')
    const spendBefore = await spendSummary(clientA)
    const sealed = await createSealedPurchase(clientA, service, {
      productId,
      quantity: 10,
      unitPriceMinor: 5990,
      purchasedOn: today,
    })
    expect(sealed.quantityRemaining).toBe(10)
    expect(sealed.unitCostBasisNokMinor).toBe(5990)
    expect(sealed.residualNokMinor).toBe(0)

    const { data: purchaseRow, error } = await service
      .from('purchases')
      .select('*')
      .eq('id', sealed.purchaseId)
      .single<RowLike>()
    if (error || !purchaseRow) throw new Error(`cannot read purchase row: ${error?.message}`)

    return {
      productId,
      purchaseId: sealed.purchaseId,
      lotId: sealed.lotId,
      spendBefore,
      purchaseRowBefore: purchaseRow,
    }
  }

  async function openUnits(
    ctx: { skip(note?: string): void },
    consumptions: readonly { lotId: string; quantity: number }[],
    openedOn = today,
    pulls: readonly {
      cardVariantId?: string
      manualCardId?: string
      quantity: number
      condition?: string
    }[] = [],
  ): Promise<string> {
    const surface = await skipUnlessM16(ctx, service)
    const createRpc = requireCreateOpeningRpc(surface)
    const { data, error } = await clientA.rpc(
      createRpc.name,
      bindOpeningCreateArgs(createRpc, { openedOn, consumptions, pulls }),
    )
    if (error || !data) throw new Error(`create_opening failed: ${error?.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as RowLike | undefined
    const id = row ? row['id'] : undefined
    if (!id) throw new Error('[M16 CONTRACT] create_opening returned no id')
    return String(id)
  }

  /**
   * Attaches a pull EXECUTION-BOUND to whichever dialect exists (P53 §4/§15): in the shipped
   * folded world, pulls ride creation, so this helper creates the opening WITH its pulls.
   * Dedicated add-pull surfaces (if a future branch ships one) are driven via bindAddPullArgs
   * with an explicit opening id instead.
   */
  async function openWithPull(
    ctx: { skip(note?: string): void },
    lotId: string,
    pull: { cardVariantId?: string; manualCardId?: string; quantity: number; condition?: string },
  ): Promise<string> {
    const surface = await skipUnlessM16(ctx, service)
    const surfaceBinding = resolvePullSurface(surface)
    if (surfaceBinding.mode === 'dedicated') {
      throw new Error('dedicated pull surface must be driven with an explicit openingId')
    }
    return openUnits(ctx, [{ lotId, quantity: 1 }], today, [pull])
  }

  it('E1 master: open 2 of 10 → spend byte-identical, lot intact, one canonical disposal', async (ctx) => {
    const seeded = await seedTenPackPurchase()
    const spendAfterPurchase = await spendSummary(clientA)
    expect(spendAfterPurchase.gpoNokMinor - seeded.spendBefore.gpoNokMinor).toBe(59_900n)
    expect(spendAfterPurchase.csNokMinor - seeded.spendBefore.csNokMinor).toBe(59_900n)

    const openingId = await openUnits(ctx, [{ lotId: seeded.lotId, quantity: 2 }])

    // §3 — THE invariant: GPO and CS are identical before/after the opening.
    const spendAfterOpening = await spendSummary(clientA)
    expect(spendAfterOpening.gpoNokMinor).toBe(spendAfterPurchase.gpoNokMinor)
    expect(spendAfterOpening.csNokMinor).toBe(spendAfterPurchase.csNokMinor)
    expect(spendAfterOpening.hsNokMinor).toBe(spendAfterPurchase.hsNokMinor)
    expect(spendAfterOpening.purchaseCount).toBe(spendAfterPurchase.purchaseCount)

    // No new purchase row; the original receipt is untouched by the opening.
    const { data: purchaseRowAfter } = await service
      .from('purchases')
      .select('*')
      .eq('id', seeded.purchaseId)
      .single<RowLike>()
    expect(purchaseRowAfter).toEqual(seeded.purchaseRowBefore)

    // §5 state transition — same lot ROW (no delete/recreate), quantity decreased.
    const lotAfter = await lotById(service, seeded.lotId)
    expect(lotAfter.id).toBe(seeded.lotId)
    expect(lotAfter.quantity_remaining).toBe(8)
    expect(lotAfter.unit_cost_basis_nok_minor).toBe(5990)
    expect(lotAfter.residual_nok_minor).toBe(0)
    expect(lotAfter.cost_basis_state).toBe('known')

    // Exactly ONE canonical opened-disposal exists, frozen cost exact.
    const disposals = await disposalsForLot(clientA, seeded.lotId)
    const liveOpened = disposals.filter((d) => d.kind === 'opened' && d.voided_at === null)
    expect(liveOpened).toHaveLength(1)
    expect(liveOpened[0]?.quantity).toBe(2)
    expect(liveOpened[0]?.disposed_on).toBe(today)
    expect(liveOpened[0]?.opening_id).toBe(openingId)
    expect(liveOpened[0]?.cost_basis_at_disposal_nok_minor).toBe(11_980)

    // The openings row: owner, exact cost, provenance, completeness surface.
    const { data: stored, error: readError } = await clientA
      .from('openings')
      .select('*')
      .eq('id', openingId)
      .maybeSingle<RowLike>()
    expect(readError, `owner read of openings failed: ${readError?.message}`).toBeNull()
    const row = stored as RowLike | null
    expect(row, 'openings row must be owner-readable').toBeTruthy()
    expect(row?.['user_id']).toBe(userA.id)
    expect(findMoney(row as RowLike, [/cost.*nok.*minor/i, /^cost_?nok/i, /^cost/i])).toBe(11_980n)
    const costSourceKey = findKey(row as RowLike, /cost_?source/i)
    expect(costSourceKey, 'cost_source must exist on openings').not.toBeNull()
    expect(String((row as RowLike)[costSourceKey as string])).toBe('from_lot')
    const completenessKey = findKey(row as RowLike, /complet/i)
    expect(completenessKey, 'tracking completeness must exist on openings (§8)').not.toBeNull()

    // A bare opening owns cost but produces NO inventory yet.
    expect(await pullLotsForOpening(clientA, openingId)).toHaveLength(0)
  })

  it('§6 pull basis: NULL never zero; provenance retained; acquired_on = opened_on', async (ctx) => {
    const seeded = await seedTenPackPurchase()
    // Pulls ride creation (folded, execution-bound — P53 §4/§15).
    const openingId = await openUnits(ctx, [{ lotId: seeded.lotId, quantity: 1 }], today, [
      { cardVariantId: seedCatalog.charizardVariantId, quantity: 3, condition: 'NM' },
    ])

    const pulls = await pullLotsForOpening(clientA, openingId)
    expect(pulls.length).toBeGreaterThanOrEqual(1)
    for (const pull of pulls) {
      expect(pull.origin).toBe('opening')
      expect(pull.cost_basis_state).toBe('unallocated_opening')
      expect(pull.unit_cost_basis_minor).toBeNull() // NEVER 0 to mean free (M1/M2)
      expect(pull.unit_cost_basis_nok_minor).toBeNull()
      expect(pull.opening_id).toBe(openingId)
      expect(pull.acquired_on).toBe(today)
      expect(pull.voided_at).toBeNull()
    }
    expect(pulls.reduce((sum, p) => sum + p.quantity, 0)).toBe(3)
  })

  it('§6 selling a pull later: proceeds real, basis stays unknown, attribution survives', async (ctx) => {
    const seeded = await seedTenPackPurchase()
    const openingId = await openWithPull(ctx, seeded.lotId, {
      cardVariantId: seedCatalog.charizardVariantId,
      quantity: 1,
      condition: 'NM',
    })
    const pulls = await pullLotsForOpening(clientA, openingId)
    const pullLot = pulls[0]
    if (!pullLot) throw new Error('pull lot missing')

    const { data: sale, error: saleError } = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_idempotency_key: crypto.randomUUID(),
        p_lines: [{ lot_id: pullLot.id, quantity: 1, unit_gross_minor: 45_000 }],
      })
      .single<{ id: string }>()
    expect(saleError, `create_sale failed: ${saleError?.message}`).toBeNull()

    const { data: saleLine, error: lineError } = await service
      .from('sale_lines')
      .select('net_proceeds_nok_minor, cost_basis_at_sale_nok_minor, realized_result_nok_minor')
      .eq('sale_id', (sale as { id: string }).id)
      .single<{
        net_proceeds_nok_minor: number
        cost_basis_at_sale_nok_minor: number | null
        realized_result_nok_minor: number | null
      }>()
    expect(lineError).toBeNull()
    expect(saleLine?.net_proceeds_nok_minor).toBe(45_000) // sale proceeds are REAL money
    expect(saleLine?.cost_basis_at_sale_nok_minor).toBeNull() // basis remains unknown
    expect(saleLine?.realized_result_nok_minor).toBeNull() // NO fabricated realized profit

    // Provenance survives the sale; no zero-basis fabrication appears anywhere.
    const freshPulls = await pullLotsForOpening(clientA, openingId)
    const soldLot = freshPulls.find((p) => p.id === pullLot.id)
    expect(soldLot?.opening_id).toBe(openingId)
    expect(soldLot?.unit_cost_basis_minor).toBeNull()

    // And the whole chain left the spending ledger exactly where it started +1 purchase.
    const spendNow = await spendSummary(clientA)
    expect(spendNow.gpoNokMinor - seeded.spendBefore.gpoNokMinor).toBe(59_900n)
    expect(spendNow.csNokMinor - seeded.spendBefore.csNokMinor).toBe(59_900n)
  })

  it('P56 §16-C: coverage counts are RETAINED-only — a fully-sold pull leaves them but stays in sold provenance', async (ctx) => {
    const surface = await skipUnlessM16(ctx, service)
    // The Opening-Detail read: a read-shaped RPC keyed by an opening id.
    const detailRpc = findReadRpcs(surface).find((r) =>
      r.paramNames.some((p) => /opening_?id/i.test(p)),
    )
    if (!detailRpc) {
      throw new Error(
        '[M16 CONTRACT] no opening-detail read RPC discovered among (' +
          surface.openingRpcs.map((r) => r.name).join(', ') +
          ') — FINANCIAL_MODEL §5.3 requires one.',
      )
    }

    const seeded = await seedTenPackPurchase()
    // Two pulls: Charizard (valued manually, then FULLY sold) and the Japanese variant
    // (no market observations exist for it on this stack — genuinely unpriced, retained).
    const openingId = await openUnits(ctx, [{ lotId: seeded.lotId, quantity: 1 }], today, [
      { cardVariantId: seedCatalog.charizardVariantId, quantity: 1, condition: 'NM' },
      { cardVariantId: seedCatalog.japaneseVariantId, quantity: 1, condition: 'NM' },
    ])
    const pulls = await pullLotsForOpening(clientA, openingId)
    expect(pulls).toHaveLength(2)
    // Identify which pull lot is the Charizard one via its holding's variant.
    const variantOfPull = new Map<string, string>()
    for (const pull of pulls) {
      const { data: holding, error: hError } = await service
        .from('holdings')
        .select('card_variant_id')
        .eq('id', pull.holding_id)
        .single<{ card_variant_id: string | null }>()
      if (hError || !holding?.card_variant_id) {
        throw new Error(`cannot resolve pull holding variant: ${hError?.message}`)
      }
      variantOfPull.set(pull.id, holding.card_variant_id)
    }
    const charizardPull = pulls.find(
      (p) => variantOfPull.get(p.id) === seedCatalog.charizardVariantId,
    )
    if (!charizardPull) throw new Error('charizard pull missing')

    // Manual valuation makes the Charizard pull PRICED deterministically before the sale.
    const { error: mvError } = await clientA.rpc('set_manual_valuation', {
      p_holding_id: charizardPull.holding_id,
      p_value_minor: 10_000,
      p_effective_from: today,
    })
    expect(mvError, `set_manual_valuation failed: ${mvError?.message}`).toBeNull()

    const { error: saleError } = await clientA.rpc('create_sale', {
      p_sold_on: today,
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [{ lot_id: charizardPull.id, quantity: 1, unit_gross_minor: 12_000 }],
    })
    expect(saleError, `create_sale failed: ${saleError?.message}`).toBeNull()

    const { data, error } = await clientA.rpc(detailRpc.name, {
      ...bindOpeningIdOnlyArgs(detailRpc, openingId),
    })
    if (error || !data) throw new Error(`detail read failed: ${error?.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as RowLike

    // Coverage keys are located BY NAME PATTERN, never assumed exact:
    //   priced/unpriced counts must EXCLUDE the sold-out pull (retained frame);
    //   the sold-provenance count must INCLUDE it.
    const pricedKey = findKey(row, /^priced.*pull.*count$/i)
    const unpricedKey = findKey(row, /^unpriced.*pull.*count$/i)
    const soldKey = findKey(row, /^sold.*pull.*count$/i)
    if (!pricedKey || !unpricedKey || !soldKey) {
      throw new Error(
        `[M16 CONTRACT] detail read "${detailRpc.name}" lacks priced/unpriced/sold pull-count ` +
          `fields (row keys: ${Object.keys(row).join(', ')}).`,
      )
    }
    expect(Number(row[unpricedKey as string])).toBe(1) // the retained, unpriced Japanese pull
    expect(Number(row[pricedKey as string])).toBe(0) // sold-out Charizard EXCLUDED
    expect(Number(row[soldKey as string])).toBe(1) // …but present as sold provenance

    // Retained tracked value excludes the sold lot entirely; proceeds include its sale.
    const retained = findMoney(row, [/retained/i])
    if (retained !== null) expect(retained).toBe(0n)
    const proceeds = findMoney(row, [/net.*proceeds|proceeds/i])
    expect(proceeds, 'sold-pull proceeds must be reported').not.toBeNull()
    expect(proceeds!).toBeGreaterThan(0n)
  })

  it('§20 unpriced bulk pulls: opening completes; absent price ≠ zero price', async (ctx) => {
    const seeded = await seedTenPackPurchase()
    // Japanese variant: no provider observations exist for it on an ephemeral
    // stack and none are seeded here — value ABSENT, never zero.
    const openingId = await openUnits(ctx, [{ lotId: seeded.lotId, quantity: 1 }], today, [
      { cardVariantId: seedCatalog.japaneseVariantId, quantity: 12, condition: 'NM' },
    ])

    const pulls = await pullLotsForOpening(clientA, openingId)
    const bulk = pulls.find((p) => p.quantity === 12)
    expect(bulk, '12 duplicates stay ONE grouped lot (D-017 without fragmentation)').toBeTruthy()
    expect(bulk?.origin).toBe('opening')
    expect(bulk?.unit_cost_basis_minor).toBeNull()
    expect(bulk?.cost_basis_state).toBe('unallocated_opening')

    // Absent price: zero snapshot rows AND zero basis fabrication.
    const { count: snapshotCount } = await service
      .from('price_snapshots')
      .select('*', { count: 'exact', head: true })
      .eq('card_variant_id', seedCatalog.japaneseVariantId)
    expect(snapshotCount ?? 0).toBe(0)
  })
})
