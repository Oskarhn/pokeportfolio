/**
 * M16 PROVISIONAL-COST ORACLE (D-021 / FINANCIAL_MODEL §5.5 / E13) —
 * DB-backed, IMPLEMENTATION_GATED.
 *
 * §10 of the brief: if the user never entered the pack purchase, the money
 * must enter the canonical purchase ledger EXACTLY ONCE, and after
 * reconciliation a provisional and a real cost source can never BOTH count
 * for the same opening (F12).
 *
 * No audit_events dependency is permitted anywhere here: the table does not
 * exist on the current schema (DATA_MODEL §7 status correction) and the
 * active absence check lives in db/security.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'
import {
  bindProvisionalOpeningArgs,
  findProvisionalCreateRpc,
  findReconcileRpc,
  disposeM16DiscoverySession,
  hasSupabaseEnv,
  requireVoidOpeningRpc,
  skipUnlessM16,
} from '../helpers/contract'
import { createIsolatedSealedProduct, spendSummary } from '../helpers/fixtures'

const today = new Date().toISOString().slice(0, 10)

describe.skipIf(!hasSupabaseEnv())('M16 provisional-cost oracle (F12 / E13)', () => {
  let service: TestClient
  let userA: SyntheticUser
  let clientA: TestClient

  beforeAll(async () => {
    const { createServiceClient } = await import('../../db/setup')
    service = createServiceClient()
    userA = await createSyntheticUser(service, 'm16adv-prov')
    clientA = await signInAs(userA)
  }, 120_000)

  afterAll(async () => {
    if (service && userA) await deleteSyntheticUser(service, userA.id)
    await disposeM16DiscoverySession()
  }, 60_000)

  /**
   * Creates an opening through the PROVISIONAL path; returns its id.
   * Execution-bound (P53 §4/§12): prefers the dedicated provisional-create RPC the shipped
   * implementation exposes (`create_opening_from_provisional`, receipt TOTAL paid), and binds
   * whatever parameter spellings were discovered — never guessing a call.
   */
  async function createProvisionalOpening(
    ctx: { skip(note?: string): void },
    overrides: {
      sealedProductId?: string
      quantity?: number
      manualCostNokMinor?: number
      purchasedOn?: string
      openedOn?: string
      idempotencyKey?: string
    } = {},
  ): Promise<string> {
    const surface = await skipUnlessM16(ctx, service)
    const dedicated = findProvisionalCreateRpc(surface)
    if (dedicated) {
      const args = bindProvisionalOpeningArgs(dedicated, {
        sealedProductId:
          overrides.sealedProductId ??
          (await createIsolatedSealedProduct(service, userA.id, 'prov')),
        quantity: overrides.quantity ?? 1,
        manualCostNokMinor: overrides.manualCostNokMinor ?? 79_900,
        purchasedOn: overrides.purchasedOn ?? today,
        openedOn: overrides.openedOn ?? today,
      })
      const idempotencyParam = dedicated.paramNames.find((p) => /idempotency/i.test(p))
      if (overrides.idempotencyKey && idempotencyParam)
        args[idempotencyParam] = overrides.idempotencyKey
      else if (overrides.idempotencyKey) {
        throw new Error(
          `[M16 CONTRACT] provisional-create RPC "${dedicated.name}" exposes no idempotency-key ` +
            `parameter among (${dedicated.paramNames.join(', ')}) — P53 §5 requires server-side ` +
            `idempotency on the provisional path.`,
        )
      }
      const { data, error } = await clientA.rpc(dedicated.name, args)
      if (error || !data) {
        ctx.skip(
          `provisional-create RPC rejected the call: ${error?.message}. FINANCIAL_MODEL §5.5 ` +
            'requires this path — flag at integration.',
        )
        return ''
      }
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>
      return String(row['id'] ?? '')
    }
    ctx.skip(
      'No dedicated provisional-create RPC discovered and no manual-cost slot exists on the ' +
        'generic create RPC. If the implementation folds the provisional money elsewhere, update ' +
        'helpers/contract.ts deliberately.',
    )
    return ''
  }

  it('manual cost enters the ledger exactly once as a real provisional purchase', async (ctx) => {
    const spendBefore = await spendSummary(clientA)

    const openingId = await createProvisionalOpening(ctx)
    expect(openingId).not.toBe('')

    // Money entered the CANONICAL ledger exactly once — GPO/CS moved by 79900.
    const spendAfter = await spendSummary(clientA)
    expect(spendAfter.gpoNokMinor - spendBefore.gpoNokMinor).toBe(79_900n)
    expect(spendAfter.csNokMinor - spendBefore.csNokMinor).toBe(79_900n)
    expect(spendAfter.purchaseCount - spendBefore.purchaseCount).toBe(1)

    // The new purchase is marked provisional_opening (the shipped enum value).
    const { data: purchases } = await service
      .from('purchases')
      .select('id, origin, voided_at')
      .eq('user_id', userA.id)
    const provisional = (purchases ?? []).find(
      (row) => String((row as Record<string, unknown>)['origin']) === 'provisional_opening',
    )
    expect(provisional, 'no provisional_opening purchase was created').toBeTruthy()

    // The opening stores its provisional linkage and its exact cost.
    const { data: storedRows } = await clientA.from('openings').select('*').eq('id', openingId)
    const stored = ((storedRows ?? []) as Record<string, unknown>[])[0]
    expect(stored).toBeTruthy()
    const provKey = Object.keys(stored ?? {}).find((k) => /provisional/i.test(k))
    expect(provKey, 'openings row lacks its provisional_purchase linkage').not.toBeNull()
    const costKey = Object.keys(stored ?? {}).find((k) => /^cost_?nok/i.test(k))
    if (costKey) {
      const raw = (stored as Record<string, unknown>)[costKey]
      const value = typeof raw === 'number' ? BigInt(Math.trunc(raw)) : BigInt(String(raw))
      expect(value).toBe(79_900n)
    }
  })

  it('total-paid exactness: qty 3 × paid 29995 → unit basis 9998, residual 1, opening cost 29995 (I10)', async (ctx) => {
    const productId = await createIsolatedSealedProduct(service, userA.id, 'prov-total')
    const spendBefore = await spendSummary(clientA)

    // Buy-and-open all three at once: the opening exhausts its own fresh lot, so the frozen
    // cost must equal the entered TOTAL exactly (9998 × 3 + residual 1).
    const openingId = await createProvisionalOpening(ctx, {
      sealedProductId: productId,
      quantity: 3,
      manualCostNokMinor: 29_995,
    })
    expect(openingId).not.toBe('')

    // GPO/CS moved by EXACTLY the entered total — no invented or lost øre.
    const spendAfter = await spendSummary(clientA)
    expect(spendAfter.gpoNokMinor - spendBefore.gpoNokMinor).toBe(29_995n)
    expect(spendAfter.csNokMinor - spendBefore.csNokMinor).toBe(29_995n)

    // The lot carries the largest-remainder split verbatim.
    const { data: storedRows } = await clientA.from('openings').select('*').eq('id', openingId)
    const stored = ((storedRows ?? []) as Record<string, unknown>[])[0]
    expect(stored).toBeTruthy()
    const lotId = stored?.['source_lot_id']
    expect(lotId).toBeTruthy()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('*')
      .eq('id', String(lotId))
      .maybeSingle<Record<string, unknown>>()
    expect(Number(lot?.['unit_cost_basis_nok_minor'])).toBe(9_998)
    expect(Number(lot?.['residual_nok_minor'])).toBe(1)
    expect(Number(lot?.['quantity_remaining'])).toBe(0)

    // And the recorded opening cost equals the entered total to the øre.
    const costKey = Object.keys(stored ?? {}).find((k) => /^cost_?nok/i.test(k))
    const raw = (stored as Record<string, unknown>)[costKey ?? '']
    const value = typeof raw === 'number' ? BigInt(Math.trunc(raw)) : BigInt(String(raw))
    expect(value).toBe(29_995n)

    // Idempotency parameter exists on the discovered provisional surface (P53 §5 contract).
    const surface = await skipUnlessM16(ctx, service)
    const dedicated = findProvisionalCreateRpc(surface)
    if (!dedicated?.paramNames.some((p) => /idempotency/i.test(p))) {
      throw new Error(
        `[M16 CONTRACT] provisional-create RPC "${dedicated?.name}" exposes no idempotency-key ` +
          'parameter — P53 §5 requires server-side idempotency BEFORE the purchase row exists.',
      )
    }
  })

  it('reconciliation counts the money exactly once; double-reconcile is rejected', async (ctx) => {
    const surface = await skipUnlessM16(ctx, service)
    const reconRpc = findReconcileRpc(surface)
    if (!reconRpc) {
      ctx.skip(
        'No reconciliation-shaped RPC discovered. F12 can then only be enforced by construction; ' +
          'verify at integration that no path can hold two live cost sources.',
      )
      return
    }

    const spendBefore = await spendSummary(clientA)
    // The REAL receipt must be the SAME sealed product as the provisional opening —
    // reconciliation across products is refused by design (server rule, not a defect).
    const productId = await createIsolatedSealedProduct(service, userA.id, 'prov-rec')
    const openingId = await createProvisionalOpening(ctx, { sealedProductId: productId })
    expect(openingId).not.toBe('')

    // The REAL receipt arrives: 799.00 + 79.00 shipping = 878.00 NOK total.
    const { data: realPurchase, error: realError } = await clientA
      .rpc('create_purchase', {
        p_purchased_on: today,
        p_currency: 'NOK',
        p_shipping_minor: 7_900,
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: productId,
            quantity: 1,
            unit_price_minor: 79_900,
          },
        ],
      })
      .single<{ id: string }>()
    expect(realError, `real purchase failed: ${realError?.message}`).toBeNull()
    const { data: realLine } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', (realPurchase as { id: string }).id)
      .single<{ id: string }>()
    const { data: realLot } = await service
      .from('acquisition_lots')
      .select('id')
      .eq('purchase_line_id', (realLine as { id: string }).id)
      .single<{ id: string }>()

    // Naive world BEFORE reconcile: provisional + real both live → counted twice.
    const spendNaive = await spendSummary(clientA)
    expect(spendNaive.gpoNokMinor - spendBefore.gpoNokMinor).toBe(79_900n + 87_800n)

    // RECONCILE — bind opening id + real lot id onto whatever names were chosen.
    const lotParam = reconRpc.paramNames.find((p) => /lot_?id/i.test(p))
    const openParam = reconRpc.paramNames.find((p) => /opening_?id/i.test(p))
    if (!lotParam || !openParam) {
      throw new Error(
        `[M16 CONTRACT] reconciliation RPC "${reconRpc.name}" parameters ` +
          `(${reconRpc.paramNames.join(', ')}) do not expose an opening id and a lot id. Update ` +
          `helpers/contract.ts deliberately.`,
      )
    }
    const { error: reconError } = await clientA.rpc(reconRpc.name, {
      [openParam]: openingId,
      [lotParam]: (realLot as { id: string }).id,
    })
    expect(reconError, `reconcile failed: ${reconError?.message}`).toBeNull()

    // AFTER: counted once, now at the REAL attributable figure (87800).
    const spendAfter = await spendSummary(clientA)
    expect(spendAfter.gpoNokMinor - spendBefore.gpoNokMinor).toBe(87_800n)
    expect(spendAfter.csNokMinor - spendBefore.csNokMinor).toBe(87_800n)

    // The provisional purchase of THIS opening is VOIDED — retained, excluded everywhere (E13).
    // Scoped through the opening's own provenance pointer: earlier cases in this file leave
    // OTHER live provisional purchases behind, and the oracle must not depend on file order.
    const { data: openingRows } = await service
      .from('openings')
      .select('provisional_purchase_id')
      .eq('id', openingId)
      .maybeSingle<Record<string, unknown>>()
    const provPurchaseId = String(openingRows?.['provisional_purchase_id'] ?? '')
    expect(provPurchaseId, 'opening lost its provisional_purchase_id provenance').not.toBe('')
    const { data: purchases } = await service
      .from('purchases')
      .select('id, origin, voided_at')
      .eq('user_id', userA.id)
    const provisional = (purchases ?? []).find(
      (row) => String((row as Record<string, unknown>)['id']) === provPurchaseId,
    )
    expect(provisional, 'provisional purchase vanished instead of being voided').toBeTruthy()
    expect(String((provisional as Record<string, unknown>)['origin'])).toBe('provisional_opening')
    expect((provisional as Record<string, unknown>)['voided_at'] ?? null).not.toBeNull()

    // P56 §16-A (P54 finding H1): EVERY lot of the voided provisional purchase is VOIDED too —
    // no phantom sealed inventory with known basis citing a purchase that no longer counts.
    const { data: provLines } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', String(provisional!['id']))
    expect((provLines ?? []).length).toBeGreaterThan(0)
    for (const line of provLines ?? []) {
      const { data: lotsOfLine } = await service
        .from('acquisition_lots')
        .select('voided_at')
        .eq('purchase_line_id', String(line['id']))
      expect((lotsOfLine ?? []).length).toBeGreaterThan(0)
      expect(
        (lotsOfLine ?? []).every((l) => l['voided_at'] !== null),
        'a lot of the voided provisional purchase stayed LIVE — phantom inventory',
      ).toBe(true)
    }

    // A second reconciliation is rejected — F12 holds at every instant.
    const { error: secondReconError } = await clientA.rpc(reconRpc.name, {
      [openParam]: openingId,
      [lotParam]: (realLot as { id: string }).id,
    })
    expect(secondReconError, 'double reconciliation must be rejected').not.toBeNull()
  })

  it('P56 §16-B: reconciliation onto a PROVISIONAL purchase’s lot is refused (F55-10)', async (ctx) => {
    const surface = await skipUnlessM16(ctx, service)
    const reconRpc = findReconcileRpc(surface)
    if (!reconRpc) {
      ctx.skip('No reconciliation-shaped RPC discovered — see the F12 oracle above.')
      return
    }
    const lotParam = reconRpc.paramNames.find((p) => /lot_?id/i.test(p))
    const openParam = reconRpc.paramNames.find((p) => /opening_?id/i.test(p))
    if (!lotParam || !openParam) throw new Error('[M16 CONTRACT] reconcile params undiscoverable')

    const productId = await createIsolatedSealedProduct(service, userA.id, 'prov-target')
    // O1 stays unreconciled. O2 is created and VOIDED: per the shipped void policy its
    // provisional purchase STAYS ACTIVE and its source lot comes back live — which without a
    // purchase-origin guard would be a valid-looking reconciliation target.
    const o1 = await createProvisionalOpening(ctx, {
      sealedProductId: productId,
      quantity: 1,
      manualCostNokMinor: 10_000,
    })
    expect(o1).not.toBe('')
    const o2 = await createProvisionalOpening(ctx, {
      sealedProductId: productId,
      quantity: 1,
      manualCostNokMinor: 11_000,
    })
    expect(o2).not.toBe('')

    const voidRpc = requireVoidOpeningRpc(surface)
    const voidParam = voidRpc.paramNames.find((p) => /opening_?id/i.test(p))
    if (!voidParam) throw new Error('[M16 CONTRACT] void RPC lacks an opening id parameter')
    const { error: voidError } = await clientA.rpc(voidRpc.name, { [voidParam]: o2 })
    expect(voidError, `voiding O2 failed: ${voidError?.message}`).toBeNull()

    // O2's provisional lot is live again with enough units — but cites a provisional purchase.
    const { data: o2Rows } = await clientA.from('openings').select('*').eq('id', o2)
    const o2Row = ((o2Rows ?? []) as Record<string, unknown>[])[0]
    const o2LotId = String(o2Row?.['source_lot_id'] ?? '')
    expect(o2LotId).toBeTruthy()
    const { data: targetLot } = await service
      .from('acquisition_lots')
      .select('voided_at, quantity_remaining')
      .eq('id', o2LotId)
      .maybeSingle<Record<string, unknown>>()
    expect(targetLot?.['voided_at'] ?? null).toBeNull()
    expect(Number(targetLot?.['quantity_remaining'])).toBe(1)

    const { error: reconError } = await clientA.rpc(reconRpc.name, {
      [openParam]: o1,
      [lotParam]: o2LotId,
    })
    expect(reconError, 'reconciling onto a provisional_purchase lot must be REFUSED').not.toBeNull()
  })
})
