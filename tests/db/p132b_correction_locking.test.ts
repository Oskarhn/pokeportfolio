import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from './setup'
import {
  connectMonitor,
  HeldLockSession,
  silenceUnhandledRejection,
  waitUntilLockWaiting,
} from './lib/held-lock-session'
import type { Client as PgClient } from 'pg'

/**
 * P132-B (output_130.txt P130-03, Step 4): correction-RPC concurrency.
 *
 * void_purchase, void_acquisition_lot, remove_holdings_from_portfolio and void_opening each decide
 * whether a lot is safe to void by reading quantity_remaining / downstream-disposal state; before
 * 20260914121000_p132_correction_lot_locking.sql, that read happened BEFORE any lock was taken,
 * racing create_sale (which correctly locks first, ascending id, then re-validates — see the
 * migration header). Each test below proves BOTH directions deterministically, with a real,
 * concurrently-open transaction held on one side and a `pg_stat_activity` lock-wait poll (never a
 * blind sleep) as the synchronization point:
 *
 *   "sale first"       — create_sale locks the lot and holds its transaction open; the correction
 *                         blocks on the SAME row; once the sale commits, the correction must see
 *                         the committed disposal and refuse — never silently void a lot a live sale
 *                         now depends on.
 *   "correction first" — the correction locks the lot and holds its transaction open; create_sale
 *                         blocks on the same row; once the correction commits, the sale must see
 *                         the voided/updated lot and refuse — never record a disposal against
 *                         inventory that no longer exists.
 *
 * Never observed, in either direction, for any of the four RPCs: a voided lot with a live
 * disposal, a quantity_remaining restored after a disposal that is still live, or a disposal
 * referencing a lot whose voided_at postdates it inconsistently. See
 * ai_outputs/Claude_outputs/output_132_b_finance.txt for the full evidence, the mutation-removal
 * proof (two of the four with the new lock stripped out, showing this exact suite fail), and the
 * seeded deadlock campaign across all four RPCs together.
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient
let monitor: PgClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p132b-lock')
  clientA = await signInAs(userA)
  monitor = await connectMonitor()
})

afterAll(async () => {
  await monitor.end()
  await deleteSyntheticUser(service, userA.id)
})

const today = new Date().toISOString().slice(0, 10)

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────

/**
 * Every call buys a DISTINCT manual card (never the shared seedCatalog variant): holdings dedupe
 * by identity (card_variant_id/sealed_product_id/manual_card_id + condition + grading state), and
 * userA is intentionally shared across every test in this file. Two calls that resolved to the
 * SAME holding would let one test's already-disposed lot silently make a LATER test's freshly
 * bought lot look "blocked" too (Pass 1 checks every live lot of the holding, not just one) —
 * a cross-test fixture collision, not an RPC bug. A fresh manual card per call guarantees a fresh
 * holding per call instead.
 */
async function buyRawCard(): Promise<{ purchaseId: string; lotId: string; holdingId: string }> {
  const { data: manual, error: manualError } = await clientA
    .from('manual_card_definitions')
    .insert({ name: 'p132b fixture card' })
    .select('id')
    .single<{ id: string }>()
  if (manualError) throw new Error(manualError.message)

  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          manual_card_id: manual.id,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 10000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)

  const { data: line, error: lineError } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  if (lineError) throw new Error(lineError.message)

  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('purchase_line_id', line.id)
    .single()
  if (lotError) throw new Error(lotError.message)

  return { purchaseId: purchase.id, lotId: lot.id, holdingId: lot.holding_id }
}

async function buySealedForOpening(): Promise<{ purchaseId: string; lotId: string }> {
  const { data: purchase, error } = await clientA
    .rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'sealed',
          sealed_product_id: seedCatalog.sealedProductId,
          quantity: 1,
          unit_price_minor: 50000,
        },
      ],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)

  const { data: line, error: lineError } = await service
    .from('purchase_lines')
    .select('id')
    .eq('purchase_id', purchase.id)
    .single()
  if (lineError) throw new Error(lineError.message)

  const { data: lot, error: lotError } = await service
    .from('acquisition_lots')
    .select('id')
    .eq('purchase_line_id', line.id)
    .single()
  if (lotError) throw new Error(lotError.message)

  return { purchaseId: purchase.id, lotId: lot.id }
}

async function openWithOnePull(sourceLotId: string): Promise<{
  openingId: string
  pullLotId: string
  pullHoldingId: string
}> {
  const { data: opening, error } = await clientA
    .rpc('create_opening', {
      p_source_lot_id: sourceLotId,
      p_quantity: 1,
      p_pulls: [{ card_variant_id: seedCatalog.pikachuVariantId, quantity: 1, condition: 'NM' }],
    })
    .single<{ id: string }>()
  if (error) throw new Error(error.message)

  const { data: pullLot, error: pullError } = await service
    .from('acquisition_lots')
    .select('id, holding_id')
    .eq('opening_id', opening.id)
    .single()
  if (pullError) throw new Error(pullError.message)

  return { openingId: opening.id, pullLotId: pullLot.id, pullHoldingId: pullLot.holding_id }
}

// ── Raw-session calls into the RPCs under test ────────────────────────────────────────────────

function sellLotInSession(session: HeldLockSession, lotId: string): Promise<{ id: string }[]> {
  return session.query<{ id: string }>(
    `select id from public.create_sale(
       p_sold_on => $1::date,
       p_currency => 'NOK',
       p_lines => $2::jsonb,
       p_idempotency_key => $3::uuid
     )`,
    [
      today,
      JSON.stringify([{ lot_id: lotId, quantity: 1, unit_gross_minor: 500 }]),
      crypto.randomUUID(),
    ],
  )
}

function voidPurchaseInSession(session: HeldLockSession, purchaseId: string) {
  return session.query('select public.void_purchase($1::uuid, null)', [purchaseId])
}

function voidAcquisitionLotInSession(session: HeldLockSession, lotId: string) {
  return session.query('select public.void_acquisition_lot($1::uuid, null)', [lotId])
}

function removeHoldingsInSession(session: HeldLockSession, holdingIds: string[]) {
  return session.query('select * from public.remove_holdings_from_portfolio($1::uuid[])', [
    holdingIds,
  ])
}

function voidOpeningInSession(session: HeldLockSession, openingId: string) {
  return session.query('select public.void_opening($1::uuid, null)', [openingId])
}

// ── Diagnostics (D1 / integrity) ──────────────────────────────────────────────────────────────

interface LotState {
  id: string
  quantity: number
  quantity_remaining: number
  voided_at: string | null
}

async function lotState(lotId: string): Promise<LotState> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select('id, quantity, quantity_remaining, voided_at')
    .eq('id', lotId)
    .single<LotState>()
  if (error) throw new Error(error.message)
  return data
}

interface DisposalState {
  id: string
  voided_at: string | null
}

async function liveDisposalsFor(lotId: string): Promise<DisposalState[]> {
  const { data, error } = await service
    .from('lot_disposals')
    .select('id, voided_at')
    .eq('lot_id', lotId)
    .is('voided_at', null)
  if (error) throw new Error(error.message)
  return data
}

/**
 * D1 (FINANCIAL_MODEL.md): a lot's quantity_remaining must always equal quantity minus the sum of
 * its own live disposals. Asserted directly against the stored column (recompute_lot_quantity_
 * remaining's job) rather than recomputed here, so this is a check on the TRIGGER's own output,
 * not a restatement of it.
 */
async function assertD1(lotId: string): Promise<void> {
  const lot = await lotState(lotId)
  const { data: disposals, error } = await service
    .from('lot_disposals')
    .select('quantity')
    .eq('lot_id', lotId)
    .is('voided_at', null)
  if (error) throw new Error(error.message)
  const disposed = (disposals as { quantity: number }[]).reduce((sum, d) => sum + d.quantity, 0)
  expect(lot.quantity_remaining, `D1 for lot ${lotId}`).toBe(lot.quantity - disposed)
}

/** Never a voided lot with a live disposal still pointing at it (the core P130-03 violation). */
async function assertNoVoidedLotWithLiveDisposal(lotId: string): Promise<void> {
  const lot = await lotState(lotId)
  const live = await liveDisposalsFor(lotId)
  if (lot.voided_at !== null) {
    expect(live, `lot ${lotId} is voided but still has a live disposal`).toHaveLength(0)
  }
}

// ── 1. void_purchase vs create_sale ───────────────────────────────────────────────────────────

describe('void_purchase vs create_sale (P130-03)', () => {
  it('sale first: void_purchase blocks, then refuses once it sees the committed sale', async () => {
    const { purchaseId, lotId } = await buyRawCard()

    const sale = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      // create_sale locks the lot as its own first act on it and holds the transaction open —
      // nothing here is committed yet.
      await sellLotInSession(sale, lotId)

      const correctionPromise = silenceUnhandledRejection(
        voidPurchaseInSession(correction, purchaseId),
      )
      await waitUntilLockWaiting(monitor, correction.pid)

      await sale.commit()

      await expect(correctionPromise).rejects.toThrow(/already been partially disposed/)
      await correction.end()

      const lot = await lotState(lotId)
      expect(lot.voided_at, 'lot must NOT be voided — a live sale depends on it').toBeNull()
      await assertD1(lotId)
      await assertNoVoidedLotWithLiveDisposal(lotId)

      const { data: purchase } = await service
        .from('purchases')
        .select('voided_at')
        .eq('id', purchaseId)
        .single()
      expect(purchase?.voided_at, 'purchase must NOT be voided').toBeNull()
    } finally {
      await sale.end()
      await correction.end()
    }
  })

  it('correction first: create_sale blocks, then refuses once it sees the voided lot', async () => {
    const { purchaseId, lotId } = await buyRawCard()

    const correction = await HeldLockSession.beginAs(userA.id)
    const sale = await HeldLockSession.beginAs(userA.id)
    try {
      await voidPurchaseInSession(correction, purchaseId)

      const salePromise = silenceUnhandledRejection(sellLotInSession(sale, lotId))
      await waitUntilLockWaiting(monitor, sale.pid)

      await correction.commit()

      await expect(salePromise).rejects.toThrow(/one or more selected lots are unavailable/)
      await sale.end()

      const lot = await lotState(lotId)
      expect(lot.voided_at, 'lot must be voided (the correction committed first)').not.toBeNull()
      const live = await liveDisposalsFor(lotId)
      expect(live, 'a voided lot must never gain a disposal').toHaveLength(0)
      await assertD1(lotId)
    } finally {
      await correction.end()
      await sale.end()
    }
  })
})

// ── 2. void_acquisition_lot vs create_sale ────────────────────────────────────────────────────

describe('void_acquisition_lot vs create_sale (P130-03)', () => {
  it('sale first: void_acquisition_lot blocks, then refuses once it sees the committed sale', async () => {
    const { lotId } = await buyRawCard()

    const sale = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      await sellLotInSession(sale, lotId)

      const correctionPromise = silenceUnhandledRejection(
        voidAcquisitionLotInSession(correction, lotId),
      )
      await waitUntilLockWaiting(monitor, correction.pid)

      await sale.commit()

      await expect(correctionPromise).rejects.toThrow(/already been partially disposed elsewhere/)
      await correction.end()

      const lot = await lotState(lotId)
      expect(lot.voided_at).toBeNull()
      await assertD1(lotId)
      await assertNoVoidedLotWithLiveDisposal(lotId)
    } finally {
      await sale.end()
      await correction.end()
    }
  })

  it('correction first: create_sale blocks, then refuses once it sees the voided lot', async () => {
    const { lotId } = await buyRawCard()

    const correction = await HeldLockSession.beginAs(userA.id)
    const sale = await HeldLockSession.beginAs(userA.id)
    try {
      await voidAcquisitionLotInSession(correction, lotId)

      const salePromise = silenceUnhandledRejection(sellLotInSession(sale, lotId))
      await waitUntilLockWaiting(monitor, sale.pid)

      await correction.commit()

      await expect(salePromise).rejects.toThrow(/one or more selected lots are unavailable/)
      await sale.end()

      const lot = await lotState(lotId)
      expect(lot.voided_at).not.toBeNull()
      expect(await liveDisposalsFor(lotId)).toHaveLength(0)
      await assertD1(lotId)
    } finally {
      await correction.end()
      await sale.end()
    }
  })
})

// ── 3. remove_holdings_from_portfolio vs create_sale ──────────────────────────────────────────

describe('remove_holdings_from_portfolio vs create_sale (P130-03)', () => {
  it('sale first: remove_holdings_from_portfolio blocks, then refuses once it sees the committed sale', async () => {
    const { lotId, holdingId } = await buyRawCard()

    const sale = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      await sellLotInSession(sale, lotId)

      const correctionPromise = removeHoldingsInSession(correction, [holdingId])
      await waitUntilLockWaiting(monitor, correction.pid)

      await sale.commit()

      // Locking closes the race for the mutating action (void_acquisition_lot itself), but Pass 1's
      // blocked-determination now runs against the locked, post-sale row too, so the call should
      // complete normally reporting `blocked: true` rather than raising — assert the softer
      // contract explicitly, not just "it throws".
      const rows = await correctionPromise
      await correction.commit()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ holding_id: holdingId, blocked: true })

      const lot = await lotState(lotId)
      expect(lot.voided_at, 'lot must NOT be voided — a live sale depends on it').toBeNull()
      await assertD1(lotId)
      await assertNoVoidedLotWithLiveDisposal(lotId)
    } finally {
      await sale.end()
      await correction.end()
    }
  })

  it('correction first: create_sale blocks, then refuses once it sees the voided lot', async () => {
    const { lotId, holdingId } = await buyRawCard()

    const correction = await HeldLockSession.beginAs(userA.id)
    const sale = await HeldLockSession.beginAs(userA.id)
    try {
      const rows = await removeHoldingsInSession(correction, [holdingId])
      expect(rows[0]).toMatchObject({ holding_id: holdingId, blocked: false })

      const salePromise = silenceUnhandledRejection(sellLotInSession(sale, lotId))
      await waitUntilLockWaiting(monitor, sale.pid)

      await correction.commit()

      await expect(salePromise).rejects.toThrow(/one or more selected lots are unavailable/)
      await sale.end()

      const lot = await lotState(lotId)
      expect(lot.voided_at).not.toBeNull()
      expect(await liveDisposalsFor(lotId)).toHaveLength(0)
      await assertD1(lotId)
    } finally {
      await correction.end()
      await sale.end()
    }
  })
})

// ── 4. void_opening vs create_sale (selling a pulled card) ────────────────────────────────────

describe('void_opening vs create_sale on a pull lot (P130-03)', () => {
  it('sale first: void_opening blocks, then refuses once it sees the committed sale', async () => {
    const { lotId: sourceLotId } = await buySealedForOpening()
    const { openingId, pullLotId } = await openWithOnePull(sourceLotId)

    const sale = await HeldLockSession.beginAs(userA.id)
    const correction = await HeldLockSession.beginAs(userA.id)
    try {
      await sellLotInSession(sale, pullLotId)

      const correctionPromise = silenceUnhandledRejection(
        voidOpeningInSession(correction, openingId),
      )
      await waitUntilLockWaiting(monitor, correction.pid)

      await sale.commit()

      await expect(correctionPromise).rejects.toThrow(/already has a downstream disposal/)
      await correction.end()

      const pull = await lotState(pullLotId)
      expect(pull.voided_at, 'pull lot must NOT be voided — a live sale depends on it').toBeNull()
      await assertD1(pullLotId)
      await assertNoVoidedLotWithLiveDisposal(pullLotId)

      const { data: opening } = await service
        .from('openings')
        .select('voided_at')
        .eq('id', openingId)
        .single()
      expect(opening?.voided_at, 'opening must NOT be voided').toBeNull()
    } finally {
      await sale.end()
      await correction.end()
    }
  })

  it('correction first: create_sale blocks, then refuses once it sees the voided pull lot', async () => {
    const { lotId: sourceLotId } = await buySealedForOpening()
    const { openingId, pullLotId } = await openWithOnePull(sourceLotId)

    const correction = await HeldLockSession.beginAs(userA.id)
    const sale = await HeldLockSession.beginAs(userA.id)
    try {
      await voidOpeningInSession(correction, openingId)

      const salePromise = silenceUnhandledRejection(sellLotInSession(sale, pullLotId))
      await waitUntilLockWaiting(monitor, sale.pid)

      await correction.commit()

      await expect(salePromise).rejects.toThrow(/one or more selected lots are unavailable/)
      await sale.end()

      const pull = await lotState(pullLotId)
      expect(
        pull.voided_at,
        'pull lot must be voided (the correction committed first)',
      ).not.toBeNull()
      expect(await liveDisposalsFor(pullLotId)).toHaveLength(0)
      await assertD1(pullLotId)

      // The SOURCE lot's quantity must be restored by D1 exactly once, from the opening's own
      // consumption disposal being voided — never twice, never left at zero forever.
      const source = await lotState(sourceLotId)
      expect(source.quantity_remaining).toBe(source.quantity)
    } finally {
      await correction.end()
      await sale.end()
    }
  })
})

// ── 5. remove_holdings_from_portfolio: reverse caller order never deadlocks ──────────────────
// A literal "reverse order" test (prompt requirement): two overlapping bulk calls, each given the
// SAME two holdings but in opposite array order, run concurrently. The lock order inside the
// function is the lot id (ascending), never the caller's array position (see the migration
// header) — so however the two calls order their input, they must serialize cleanly and never
// deadlock (Postgres error 40P01).

describe('remove_holdings_from_portfolio: reverse caller order (deadlock freedom)', () => {
  it('two overlapping bulk removals in opposite holding order never deadlock', async () => {
    const a = await buyRawCard()
    const b = await buyRawCard()

    const s1 = await HeldLockSession.beginAs(userA.id)
    const s2 = await HeldLockSession.beginAs(userA.id)
    try {
      const p1 = removeHoldingsInSession(s1, [a.holdingId, b.holdingId])
      const p2 = removeHoldingsInSession(s2, [b.holdingId, a.holdingId])

      const results = await Promise.allSettled([
        p1.then((r) => s1.commit().then(() => r)),
        p2.then((r) => s2.commit().then(() => r)),
      ])

      const deadlocked = results.filter(
        (r) => r.status === 'rejected' && /deadlock detected/i.test(String(r.reason)),
      )
      expect(deadlocked, 'ascending-id lock order must make this deadlock-free').toHaveLength(0)

      // Whichever call ran first voided both lots; the other's Pass 1 will see them already voided
      // (voided_at is not null excludes them from the "live lots" scan entirely), so it reports
      // BOTH holdings with physical_count 0 and blocked:false (there is nothing left to block on) —
      // never an error, never a partial mutation.
      for (const r of results) {
        expect(r.status).toBe('fulfilled')
      }

      const lotA = await lotState(a.lotId)
      const lotB = await lotState(b.lotId)
      expect(lotA.voided_at).not.toBeNull()
      expect(lotB.voided_at).not.toBeNull()
      await assertD1(a.lotId)
      await assertD1(b.lotId)
    } finally {
      await s1.end()
      await s2.end()
    }
  })
})
