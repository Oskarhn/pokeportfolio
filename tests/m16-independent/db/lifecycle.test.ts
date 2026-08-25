/**
 * M16 LIFECYCLE ORACLE — DB-backed, IMPLEMENTATION_GATED.
 *
 * §11 concurrency: genuine overlap bursts against real row locks with EXACT
 * conservation outcomes. This is behavioural evidence of serialization — no
 * claim of pg_locks proof is made; the integrator should capture lock evidence
 * when wiring these suites into CI.
 *
 * §12 void/correction: a clean void restores the source lot symmetrically; a
 * void with a sold pull must fail safely (no orphan sale_line, no resurrection
 * of an already-sold card); ledger spend never moves.
 *
 * §13 backdated timeline: snapshots before the opened_on are byte-identical
 * after a late-recorded backdated opening (no current-state projection into
 * history); the boundary date itself changes exactly once.
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
  bindAddPullArgs,
  bindOpeningCreateArgs,
  drainRecomputeQueue,
  hasSupabaseEnv,
  requireCreateOpeningRpc,
  requirePullAddRpc,
  requireVoidOpeningRpc,
  skipUnlessM16,
} from '../helpers/contract'
import {
  createIsolatedSealedProduct,
  createSealedPurchase,
  disposalsForLot,
  lotById,
  pullLotsForOpening,
  setManualValuation,
  spendSummary,
} from '../helpers/fixtures'
import { seedCatalog } from '../../db/setup'

const today = new Date().toISOString().slice(0, 10)

describe.skipIf(!hasSupabaseEnv())('M16 lifecycle oracle', () => {
  let service: TestClient
  let userA: SyntheticUser
  let clientA: TestClient

  beforeAll(async () => {
    const { createServiceClient } = await import('../../db/setup')
    service = createServiceClient()
    userA = await createSyntheticUser(service, 'm16adv-lifec')
    clientA = await signInAs(userA)
  }, 120_000)

  afterAll(async () => {
    if (service && userA) await deleteSyntheticUser(service, userA.id)
  }, 60_000)

  async function seedSealedLot(
    label: string,
    quantity: number,
    unitPriceMinor: number,
    purchasedOn = today,
  ): Promise<{ productId: string; purchaseId: string; lotId: string; holdingId: string }> {
    const productId = await createIsolatedSealedProduct(service, userA.id, label)
    const sealed = await createSealedPurchase(clientA, service, {
      productId,
      quantity,
      unitPriceMinor,
      purchasedOn,
    })
    const lot = await lotById(service, sealed.lotId)
    return {
      productId,
      purchaseId: sealed.purchaseId,
      lotId: sealed.lotId,
      holdingId: lot.holding_id,
    }
  }

  async function callCreateOpening(
    ctx: { skip(note?: string): void },
    consumptions: readonly { lotId: string; quantity: number }[],
    openedOn = today,
  ): Promise<{ ok: true; openingId: string } | { ok: false; error: string }> {
    const surface = await skipUnlessM16(ctx, service)
    const rpc = requireCreateOpeningRpc(surface)
    const args = bindOpeningCreateArgs(rpc, { openedOn, consumptions })
    const { data, error } = await clientA.rpc(rpc.name, args)
    if (error) return { ok: false, error: error.message }
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
    if (!row?.['id']) return { ok: false, error: 'no opening id returned' }
    return { ok: true, openingId: String(row['id']) }
  }

  // ---------------------------------------------------------------------------
  // §11 CONCURRENCY
  // ---------------------------------------------------------------------------

  it('§11 burst: two overlapping opens of 6 against 10 → exactly one succeeds, remaining exactly 4', async (ctx) => {
    const seeded = await seedSealedLot('conc-66', 10, 1000)
    const surface = await skipUnlessM16(ctx, service)
    const rpc = requireCreateOpeningRpc(surface)
    const mkArgs = () =>
      bindOpeningCreateArgs(rpc, {
        openedOn: today,
        consumptions: [{ lotId: seeded.lotId, quantity: 6 }],
      })

    // Both requests are IN FLIGHT simultaneously (Promise.all) — not staggered.
    const [r1, r2] = await Promise.all([
      clientA.rpc(rpc.name, mkArgs()),
      clientA.rpc(rpc.name, mkArgs()),
    ])
    const successes = [r1.error === null, r2.error === null].filter(Boolean).length
    expect(successes, 'exactly one of the two over-opens may commit').toBe(1)

    const lotAfter = await lotById(service, seeded.lotId)
    expect(lotAfter.quantity_remaining).toBe(4) // exact final quantity, never negative

    const disposals = await disposalsForLot(clientA, seeded.lotId)
    const liveOpenedQty = disposals
      .filter((d) => d.kind === 'opened' && d.voided_at === null)
      .reduce((sum, d) => sum + d.quantity, 0)
    expect(liveOpenedQty).toBe(6)
  })

  it('§11 burst: five concurrent opens demanding 20 units of 10 → Σ consumed exactly 10', async (ctx) => {
    const seeded = await seedSealedLot('conc-burst', 10, 1000)
    const surface = await skipUnlessM16(ctx, service)
    const rpc = requireCreateOpeningRpc(surface)
    const attempts = [0, 1, 2, 3, 4].map(() =>
      clientA.rpc(
        rpc.name,
        bindOpeningCreateArgs(rpc, {
          openedOn: today,
          consumptions: [{ lotId: seeded.lotId, quantity: 4 }],
        }),
      ),
    )
    const results = await Promise.all(attempts)
    const successCount = results.filter((r) => r.error === null).length

    // Deterministic under all-or-nothing consumption: floor(10/4)=2 commits of 4.
    expect(successCount).toBe(2)
    const lotAfter = await lotById(service, seeded.lotId)
    expect(lotAfter.quantity_remaining).toBe(2)
    const disposals = await disposalsForLot(clientA, seeded.lotId)
    const liveOpenedQty = disposals
      .filter((d) => d.kind === 'opened' && d.voided_at === null)
      .reduce((sum, d) => sum + d.quantity, 0)
    expect(liveOpenedQty).toBe(8) // 10 - 2: conservation is EXACT, nothing lost or invented
  })

  it('§11 open vs sale on the same sealed lot serialize; D1 holds; remaining never negative', async (ctx) => {
    const seeded = await seedSealedLot('conc-sale', 10, 1000)
    const surface = await skipUnlessM16(ctx, service)
    const rpc = requireCreateOpeningRpc(surface)

    const [openingResult, saleResult] = await Promise.all([
      clientA.rpc(
        rpc.name,
        bindOpeningCreateArgs(rpc, {
          openedOn: today,
          consumptions: [{ lotId: seeded.lotId, quantity: 6 }],
        }),
      ),
      clientA.rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_idempotency_key: crypto.randomUUID(),
        p_lines: [{ lot_id: seeded.lotId, quantity: 6, unit_gross_minor: 5000 }],
      }),
    ])

    // Either order wins; the loser fails its live re-check cleanly. A deadlock
    // abort (40P01) on one side is also an acceptable serialization outcome —
    // what may NEVER happen is both committing past available quantity.
    const committed = (openingResult.error === null ? 6 : 0) + (saleResult.error === null ? 6 : 0)
    if (committed > 6) {
      // Both succeeded only possible if serialized as 6+6=12>10 → forbidden.
      throw new Error(`[M16 CONTRACT] over-consumption committed: ${committed} of 10 units`)
    }
    const lotAfter = await lotById(service, seeded.lotId)
    expect(lotAfter.quantity_remaining).toBeGreaterThanOrEqual(0)

    // D1 recomputed from the canonical rows: quantity − Σ non-voided disposals == remaining.
    const disposals = await disposalsForLot(clientA, seeded.lotId)
    const disposed = disposals
      .filter((d) => d.voided_at === null)
      .reduce((sum, d) => sum + d.quantity, 0)
    expect(lotAfter.quantity - disposed).toBe(lotAfter.quantity_remaining)
    expect(lotAfter.quantity_remaining).toBe(10 - committed)
  })

  it('§12 clean void restores source quantity, voids pulls and disposals; ledger untouched', async (ctx) => {
    const surface = await skipUnlessM16(ctx, service)
    const seeded = await seedSealedLot('void-clean', 5, 2000)
    const created = await callCreateOpening(ctx, [{ lotId: seeded.lotId, quantity: 2 }])
    if (!created.ok) throw new Error(created.error)
    const pullRpc = surface.openingRpcs.find((r) => r.verbs.includes('pull'))
    if (pullRpc) {
      const { error: pullError } = await clientA.rpc(
        pullRpc.name,
        bindAddPullArgs(pullRpc, {
          openingId: created.openingId,
          quantity: 1,
          cardVariantId: seedCatalog.charizardVariantId,
        }),
      )
      expect(pullError, `add-pull failed: ${pullError?.message}`).toBeNull()
    }
    const spendBeforeVoid = await spendSummary(clientA)

    const voidRpc = requireVoidOpeningRpc(surface)
    const param = voidRpc.paramNames.find((p) => /opening_?id/i.test(p))
    if (!param) throw new Error('[M16 CONTRACT] void RPC lacks an opening id parameter')
    const { error: voidError } = await clientA.rpc(voidRpc.name, {
      [param]: created.openingId,
    })
    expect(voidError, `void_opening failed: ${voidError?.message}`).toBeNull()

    // Sealed shelf gets its packs back via the disposal ledger (D1 trigger).
    const lotAfter = await lotById(service, seeded.lotId)
    expect(lotAfter.quantity_remaining).toBe(5)

    // Every opened-disposal of the opening is voided; none removed.
    const disposals = await disposalsForLot(clientA, seeded.lotId)
    const openingDisposals = disposals.filter((d) => d.opening_id === created.openingId)
    expect(openingDisposals.length).toBeGreaterThanOrEqual(1)
    for (const d of openingDisposals) expect(d.voided_at).not.toBeNull()

    // Pull lots (when the pull RPC exists here) are voided too — never resurrected later.
    for (const pull of await pullLotsForOpening(clientA, created.openingId)) {
      expect(pull.voided_at).not.toBeNull()
    }

    // Ledger spend is untouched by the whole open+void round trip.
    const spendAfterVoid = await spendSummary(clientA)
    expect(spendAfterVoid.gpoNokMinor).toBe(spendBeforeVoid.gpoNokMinor)
    expect(spendAfterVoid.csNokMinor).toBe(spendBeforeVoid.csNokMinor)
  })

  it('§12 void with a sold pull fails safely: no orphan sale_line, no resurrection', async (ctx) => {
    const surface = await skipUnlessM16(ctx, service)
    const seeded = await seedSealedLot('void-sold', 3, 3000)
    const created = await callCreateOpening(ctx, [{ lotId: seeded.lotId, quantity: 1 }])
    if (!created.ok) throw new Error(created.error)
    const pullRpc = requirePullAddRpc(surface)

    const { error: pullError } = await clientA.rpc(
      pullRpc.name,
      bindAddPullArgs(pullRpc, {
        openingId: created.openingId,
        quantity: 1,
        cardVariantId: seedCatalog.charizardVariantId,
      }),
    )
    expect(pullError).toBeNull()
    const pulls = await pullLotsForOpening(clientA, created.openingId)
    const pullLot = pulls[0]
    if (!pullLot) throw new Error('pull lot missing')

    const { data: sale, error: saleError } = await clientA
      .rpc('create_sale', {
        p_sold_on: today,
        p_currency: 'NOK',
        p_idempotency_key: crypto.randomUUID(),
        p_lines: [{ lot_id: pullLot.id, quantity: 1, unit_gross_minor: 10_000 }],
      })
      .single<{ id: string }>()
    expect(saleError).toBeNull()
    const saleId = (sale as { id: string }).id

    // Naive void must FAIL — the sale blocks it.
    const voidRpc = requireVoidOpeningRpc(surface)
    const param = voidRpc.paramNames.find((p) => /opening_?id/i.test(p))
    if (!param) throw new Error('[M16 CONTRACT] void RPC lacks an opening id parameter')
    const { error: voidError } = await clientA.rpc(voidRpc.name, { [param]: created.openingId })
    expect(voidError, 'voiding an opening with a sold pull must be blocked').not.toBeNull()

    // Safe failure: the sale line still exists and references its sale;
    // the sold pull was NOT resurrected into owned inventory.
    const { count: lineCount, error: lineCountError } = await service
      .from('sale_lines')
      .select('*', { count: 'exact', head: true })
      .eq('sale_id', saleId)
    expect(lineCountError).toBeNull()
    expect(lineCount ?? 0).toBe(1)

    const freshPulls = await pullLotsForOpening(clientA, created.openingId)
    const soldStillSold = freshPulls.find((p) => p.id === pullLot.id)
    expect(soldStillSold?.quantity_remaining).toBe(0) // stays sold — no resurrection
    expect(soldStillSold?.voided_at ?? null).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // §13 BACKDATED TIMELINE
  // ---------------------------------------------------------------------------

  it('§13 backdated opening dirties history from the correct date only', async (ctx) => {
    const surface = await skipUnlessM16(ctx, service)
    const rpc = requireCreateOpeningRpc(surface)

    const ACQUIRED_ON = '2026-01-01'
    const OPENED_ON = '2026-02-10'
    const SEALED_VALUE = 100_000n

    const seeded = await seedSealedLot('backdated', 1, 99_900, ACQUIRED_ON)
    await setManualValuation(clientA, {
      holdingId: seeded.holdingId,
      valueMinor: SEALED_VALUE,
      effectiveFrom: ACQUIRED_ON,
    })

    // Snapshot the world BEFORE the opening exists, then converge the cache.
    await drainRecomputeQueue(service)
    const readSnapshots = async (): Promise<Map<string, Record<string, unknown>>> => {
      const { data, error } = await clientA
        .from('portfolio_snapshots')
        .select('*')
        .order('snapshot_date')
      if (error) throw new Error(`snapshot read failed: ${error.message}`)
      const map = new Map<string, Record<string, unknown>>()
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        map.set(String(row['snapshot_date']), row)
      }
      return map
    }
    const before = await readSnapshots()
    expect(before.has(ACQUIRED_ON)).toBe(true)

    // Backdated opening recorded LATE: consume the single sealed unit Feb 10.
    const { error: openingError } = await clientA.rpc(
      rpc.name,
      bindOpeningCreateArgs(rpc, {
        openedOn: OPENED_ON,
        consumptions: [{ lotId: seeded.lotId, quantity: 1 }],
      }),
    )
    expect(openingError, `backdated create_opening failed: ${openingError?.message}`).toBeNull()

    await drainRecomputeQueue(service)
    const after = await readSnapshots()

    // Jan 1 – Feb 9: byte-identical except computed_at — no current-state
    // projection into January.
    const cleaned = (row: Record<string, unknown>): string =>
      JSON.stringify(row, (key, value) => (key === 'computed_at' ? undefined : value))
    for (const [date, beforeRow] of before) {
      if (date >= OPENED_ON) continue
      const afterRow = after.get(date)
      expect(afterRow, `snapshot ${date} missing after recompute`).toBeTruthy()
      expect(
        cleaned(afterRow as Record<string, unknown>),
        `pre-opening snapshot ${date} changed`,
      ).toBe(cleaned(beforeRow))
    }

    // Boundary semantics: the last pre-open day still owns the sealed value;
    // from OPENED_ON the sealed unit is gone (pulls unpriced contribute counts,
    // not value).
    const cmvOf = (row: Record<string, unknown> | undefined): bigint | null => {
      if (!row) return null
      const raw = row['market_value_nok_minor']
      if (raw === null || raw === undefined) return null
      return typeof raw === 'number' ? BigInt(Math.trunc(raw)) : BigInt(String(raw))
    }
    const lastPreOpen = [...before.keys()]
      .filter((d) => d < OPENED_ON)
      .sort()
      .pop()
    expect(lastPreOpen).toBeTruthy()
    expect(cmvOf(after.get(lastPreOpen as string))).toBe(SEALED_VALUE)
    const firstOpenDay = after.get(OPENED_ON)
    expect(firstOpenDay, 'boundary snapshot missing').toBeTruthy()
    const droppedBy = (cmvOf(before.get(OPENED_ON)) ?? 0n) - (cmvOf(firstOpenDay) ?? 0n)
    expect(droppedBy).toBe(SEALED_VALUE)
  })
})
