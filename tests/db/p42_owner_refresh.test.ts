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

/**
 * P42 — the owner-reported production bug, reproduced end-to-end at the data layer and pinned
 * against regressions. Reported sequence on the deployed app: quick-add a known-cost test card
 * (Portfolio Value updates), remove it from Portfolio, then Home sat on "Updating…" for many
 * minutes and spend still showed the removed acquisition's amount.
 *
 * Hosted diagnosis (read-only, 2026-08-24) proved the LEDGER self-corrects synchronously — every
 * removed test lot's single-line parent purchase was already auto-voided, zero ghost purchases —
 * so what the owner saw was refresh latency: Home polled nothing while pending_recompute was
 * true, and the M12 worker ran only every 15 minutes. The app-layer polling and the cron cadence
 * fix live elsewhere; THIS suite pins the data-layer contract that design depends on:
 *
 *   A. quick-add known-cost → remove → parent purchase voided, GPO/CS restored to baseline
 *      EXACTLY (no ghost spend), pending flag true until drained, drain settles it, and the
 *      fully-de-tracked account ends with NO snapshot row — CMV renders "—", never a fabricated 0.
 *   B. a real multi-line purchase (card + accessory) keeps unrelated real spend when its card is
 *      removed — the auto-void must never erase lines that never produced a lot.
 *   C. already-partially-disposed inventory stays blocked from this correction path (M8.1
 *      semantics unchanged).
 *   Plus: another user's ledger is untouched throughout (no cross-user behaviour change).
 */

let service: TestClient
let userA: SyntheticUser
let clientA: TestClient
let userB: SyntheticUser
let clientB: TestClient

beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p42-owner-a')
  clientA = await signInAs(userA)
  userB = await createSyntheticUser(service, 'p42-witness-b')
  clientB = await signInAs(userB)
})

afterAll(async () => {
  // Queue rows reference auth.users; drop them explicitly first (same discipline as P28's suite),
  // then let account deletion cascade everything else.
  await service.from('portfolio_recompute_queue').delete().eq('user_id', userA.id)
  await service.from('portfolio_recompute_queue').delete().eq('user_id', userB.id)
  await deleteSyntheticUser(service, userA.id)
  await deleteSyntheticUser(service, userB.id)
})

const today = new Date().toISOString().slice(0, 10)

interface Spending {
  gpo_nok_minor: string
  cs_nok_minor: string
  hs_nok_minor: string
}

async function spendingOf(client: TestClient): Promise<Spending> {
  // SECURITY INVOKER with no service_role grant — always called as the signed-in user.
  const { data } = await client.rpc('purchase_spending_summary').single<Spending>()
  return data!
}

interface Summary {
  pending_recompute: boolean
  latest_snapshot_date: string | null
  market_value_nok_minor: string | null
}

async function summaryOf(client: TestClient): Promise<Summary> {
  const { data } = await client.rpc('get_dashboard_summary').single<Summary>()
  return data!
}

async function queueDirtyFromFor(userId: string): Promise<string | null> {
  const { data } = await service
    .from('portfolio_recompute_queue')
    .select('dirty_from')
    .eq('user_id', userId)
    .maybeSingle<{ dirty_from: string }>()
  return data?.dirty_from ?? null
}

async function parentPurchaseVoided(lotId: string): Promise<boolean | null> {
  const { data: lot } = await service
    .from('acquisition_lots')
    .select('purchase_line_id')
    .eq('id', lotId)
    .single<{ purchase_line_id: string | null }>()
  if (!lot?.purchase_line_id) return null // no parent purchase exists (unknown-cost add)
  const { data: line } = await service
    .from('purchase_lines')
    .select('purchase_id')
    .eq('id', lot.purchase_line_id)
    .single<{ purchase_id: string }>()
  const { data: purchase } = await service
    .from('purchases')
    .select('voided_at')
    .eq('id', line!.purchase_id)
    .single<{ voided_at: string | null }>()
  return purchase!.voided_at !== null
}

async function liveLotCount(holdingId: string): Promise<number> {
  const { count } = await service
    .from('acquisition_lots')
    .select('id', { count: 'exact', head: true })
    .eq('holding_id', holdingId)
    .is('voided_at', null)
  return count ?? 0
}

async function addKnownCostCard(
  client: TestClient,
  variantId: string,
  unitCostMinor: number,
): Promise<{ holdingId: string; lotId: string }> {
  const { data, error } = await client
    .rpc('add_card_acquisition', {
      p_card_variant_id: variantId,
      p_grading_state: 'raw',
      p_condition: 'NM',
      p_origin: 'purchase',
      p_cost_basis_state: 'known',
      p_unit_cost_basis_minor: unitCostMinor,
      p_quantity: 1,
      p_acquired_on: today,
    })
    .single<{ holding_id: string; lot_id: string }>()
  if (error) throw new Error(error.message)
  return { holdingId: data.holding_id, lotId: data.lot_id }
}

// ── The reported repro, end to end ─────────────────────────────────────────────────────────────

describe('P42 scenario A: quick-add known-cost card, then Remove from Portfolio', () => {
  let holdingId: string
  let lotId: string
  let baseline: Spending

  it('baseline: an empty ledger, and a witness user whose figures stay fixed throughout', async () => {
    baseline = await spendingOf(clientA)
    expect(baseline.gpo_nok_minor).toBe('0')

    // The witness owns something REAL so any cross-user bleed would be visible.
    await addKnownCostCard(clientB, seedCatalog.pikachuVariantId, 777)
    const witness = await spendingOf(clientB)
    expect(witness.gpo_nok_minor).toBe('777')
  })

  it('quick-add creates the purchase+lot and enqueues a recompute (pending flag drives the badge)', async () => {
    const added = await addKnownCostCard(clientA, seedCatalog.charizardVariantId, 12345)
    holdingId = added.holdingId
    lotId = added.lotId

    expect(await liveLotCount(holdingId)).toBe(1)
    // Field-wise, not whole-object: the summary row carries more columns than these three.
    const afterAdd = await spendingOf(clientA)
    expect(afterAdd.gpo_nok_minor).toBe('12345')
    expect(afterAdd.cs_nok_minor).toBe('12345')
    expect(afterAdd.hs_nok_minor).toBe('0')

    // Both invalidation triggers (lot INSERT + purchase INSERT) coalesce into one queue row,
    // dirtied from the acquisition date — the exact fact Home's "Updating…" badge renders.
    expect(await queueDirtyFromFor(userA.id)).toBe(today)
    expect((await summaryOf(clientA)).pending_recompute).toBe(true)
  })

  it('remove voids the lot AND its sole parent purchase — GPO/CS return to baseline exactly', async () => {
    const { data, error } = await clientA.rpc('remove_holdings_from_portfolio', {
      p_holding_ids: [holdingId],
    })
    expect(error).toBeNull()
    expect(data![0]).toMatchObject({ blocked: false, physical_count: 1 })

    expect(await liveLotCount(holdingId)).toBe(0)
    // THE GHOST-SPEND REGRESSION GUARD: a single-line known-cost purchase leaves with its lot.
    expect(await parentPurchaseVoided(lotId)).toBe(true)
    expect(await spendingOf(clientA)).toEqual(baseline)
  })

  it('still pending until the worker drains — staleness here is honest, not ghost spend', async () => {
    // The removal re-enqueued (lot UPDATE + purchase UPDATE triggers); LEAST coalescing kept the
    // earliest boundary. Until a drain runs, pending stays true — which is precisely why the UI
    // must poll while pending instead of assuming the mutation settled the dashboard.
    expect(await queueDirtyFromFor(userA.id)).toBe(today)
    expect((await summaryOf(clientA)).pending_recompute).toBe(true)
  })

  it('drain clears the queue and the fully-de-tracked account gets NO fabricated zero-CMV row', async () => {
    const { data, error } = await service.rpc('drain_portfolio_recompute_queue')
    expect(error).toBeNull()
    expect(Number(data)).toBeGreaterThanOrEqual(1)

    expect(await queueDirtyFromFor(userA.id)).toBeNull()
    const s = await summaryOf(clientA)
    expect(s.pending_recompute).toBe(false)
    // Nothing is owned on any date anymore, so nothing is derived: absent CMV renders "—"
    // upstream (the project's honesty bar) — never a snapshot row faking "worth 0 kr".
    expect(s.latest_snapshot_date).toBeNull()
    expect(s.market_value_nok_minor).toBeNull()
  })
})

// ── Real multi-line purchases are not erased by correcting one item ────────────────────────────

describe('P42 scenario B: card + accessory purchase survives removing the card', () => {
  it('removing the card lot keeps the purchase live and the accessory spend intact', async () => {
    const before = await spendingOf(clientA)
    const { data, error } = await clientA.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 2000,
        },
        { line_type: 'accessory', description: 'Deck box', quantity: 1, unit_price_minor: 400 },
      ],
    })
    expect(error).toBeNull()
    const purchaseId = (data as unknown as { id: string }).id

    const { data: cardLine } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', purchaseId)
      .eq('line_type', 'card')
      .single<{ id: string }>()
    const { data: lot } = await service
      .from('acquisition_lots')
      .select('id,holding_id')
      .eq('purchase_line_id', cardLine!.id)
      .single<{ id: string; holding_id: string }>()

    const { data: removal, error: removalError } = await clientA.rpc(
      'remove_holdings_from_portfolio',
      { p_holding_ids: [lot!.holding_id] },
    )
    expect(removalError).toBeNull()
    expect(removal![0]).toMatchObject({ blocked: false })

    const after = await spendingOf(clientA)
    // The receipt stays LIVE (the accessory line permanently blocks auto-void), so BOTH lines'
    // recorded spend legitimately remains counted — an inventory correction never rewrites money
    // history. What the assertions pin is exactly that: nothing unrelated was erased, and the
    // card's own share leaves only when the receipt itself is corrected in Purchases.
    expect(BigInt(after.gpo_nok_minor) - BigInt(before.gpo_nok_minor)).toBe(2400n)
    expect(BigInt(after.cs_nok_minor) - BigInt(before.cs_nok_minor)).toBe(2000n)
    expect(BigInt(after.hs_nok_minor) - BigInt(before.hs_nok_minor)).toBe(400n)
    // The corrected holding's lot is voided; the receipt itself remains.
    expect(await liveLotCount(lot!.holding_id)).toBe(0)
    const { data: receipt } = await service
      .from('purchases')
      .select('voided_at')
      .eq('id', purchaseId)
      .single<{ voided_at: string | null }>()
    expect(receipt!.voided_at).toBeNull()
  })
})

// ── Partially-disposed inventory stays blocked (existing semantics unchanged) ──────────────────

describe('P42 scenario C: partially-disposed inventory remains blocked', () => {
  it('a lot with quantity_remaining < quantity blocks removal and nothing is mutated', async () => {
    const before = await spendingOf(clientA)
    // Two copies, then simulate a partial disposal of one (same technique M8's own blocker
    // tests use — no real disposal path participates in this correction flow). A 1-of-1 lot is
    // fully intact by definition; the blocker needs a genuine mismatch.
    const { data, error } = await clientA
      .rpc('add_card_acquisition', {
        p_card_variant_id: seedCatalog.grassEnergyVariantId,
        p_grading_state: 'raw',
        p_condition: 'NM',
        p_origin: 'purchase',
        p_cost_basis_state: 'known',
        p_unit_cost_basis_minor: 55,
        p_quantity: 2,
        p_acquired_on: today,
      })
      .single<{ holding_id: string; lot_id: string }>()
    expect(error).toBeNull()
    const blockedHoldingId = data!.holding_id
    const blockedLotId = data!.lot_id
    await service.from('acquisition_lots').update({ quantity_remaining: 1 }).eq('id', blockedLotId)

    // The property under test is that the REMOVAL call mutates nothing — snapshot the ledger
    // AFTER this test's own setup adds its fixture, compare against that.
    const beforeRemoval = await spendingOf(clientA)

    const { data: removal, error: removalError } = await clientA.rpc(
      'remove_holdings_from_portfolio',
      { p_holding_ids: [blockedHoldingId] },
    )
    expect(removalError).toBeNull()
    expect(removal![0]).toMatchObject({ blocked: true, physical_count: 1 })
    expect(removal![0]!.blocked_reason).toMatch(/partially removed elsewhere/i)

    expect(await liveLotCount(blockedHoldingId)).toBe(1)
    expect(await parentPurchaseVoided(blockedLotId)).toBe(false)
    expect(await spendingOf(clientA)).toEqual(beforeRemoval)
  })
})

// ── No cross-user behaviour change ─────────────────────────────────────────────────────────────

describe('P42 cross-user witness', () => {
  it("the other user's ledger and holdings are untouched by everything above", async () => {
    expect((await spendingOf(clientB)).gpo_nok_minor).toBe('777')
    const { data: liveLots } = await service
      .from('acquisition_lots')
      .select('holding_id')
      .eq('user_id', userB.id)
      .is('voided_at', null)
    expect(liveLots).toHaveLength(1)
    // And B's own pending state is independent — drained clean here, never borrowed from A.
    expect(await queueDirtyFromFor(userB.id)).toBeNull()
  })
})
