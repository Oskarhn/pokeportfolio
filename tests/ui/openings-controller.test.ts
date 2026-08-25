import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  BoughtAndOpenedInput,
  CreateOpeningInput,
  OpeningController,
} from '../../src/features/openings/contract'

/**
 * The integrated controller contract (I1, P53 §16/§28/§29). The real adapter in
 * src/features/openings/controller.ts is exercised against a MOCKED `src/data/opening` module —
 * proving the mapping layer (typed optionality, error mapping, blocked-void outcomes) without a
 * live backend. The DB-gated suites (tests/db + tests/m16-independent) prove the backend itself.
 */

const createOpeningRecord = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const createProvisionalRecord = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const fetchOpening = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const listOpeningPulls = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const listOpeningSources = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const voidOpeningRecord = vi.fn<(...args: unknown[]) => Promise<void>>()

vi.mock('../../src/data/opening', () => ({
  createOpening: (...args: unknown[]) => createOpeningRecord(...args),
  createProvisionalOpening: (...args: unknown[]) => createProvisionalRecord(...args),
  getOpening: (...args: unknown[]) => fetchOpening(...args),
  listOpeningPulls: (...args: unknown[]) => listOpeningPulls(...args),
  listOpeningSources: (...args: unknown[]) => listOpeningSources(...args),
  voidOpening: (...args: unknown[]) => voidOpeningRecord(...args),
}))

const { getOpeningController } = await import('../../src/features/openings/controller')

function sourceRow() {
  return {
    lotId: 'lot-1',
    holdingId: 'holding-1',
    productId: 'product-1',
    productName: 'Prismatic ETB',
    productType: 'elite_trainer_box',
    imageUrl: null,
    acquiredOn: '2026-07-01',
    quantityAvailable: 3,
    costKnown: true,
    // The canonical 29995-øre lot shape: unit basis 9998 + exhaustion residual 1.
    effectiveUnitBasisNokMinor: 9998n,
    exhaustionResidualNokMinor: 1n,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('integrated opening controller (I1)', () => {
  it('maps list_opening_sources rows into the feature OpeningSource shape verbatim', async () => {
    listOpeningSources.mockResolvedValue([sourceRow()])
    const controller: OpeningController = getOpeningController()
    const sources = await controller.getEligibleSealedSources({ holdingId: 'holding-1' })
    expect(listOpeningSources).toHaveBeenCalledWith({ holdingId: 'holding-1' })
    expect(sources).toHaveLength(1)
    expect(sources[0]?.lotId).toBe('lot-1')
    expect(sources[0]?.costKnown).toBe(true)
    expect(sources[0]?.effectiveUnitBasisNokMinor).toBe(9998n)
    expect(sources[0]?.exhaustionResidualNokMinor).toBe(1n)
  })

  it('createOpening forwards the idempotency key and pull array to the data layer', async () => {
    createOpeningRecord.mockResolvedValue({ id: 'opening-1' })
    const controller = getOpeningController()
    const input: CreateOpeningInput = {
      idempotencyKey: 'key-1',
      sourceLotId: 'lot-1',
      quantity: 2,
      openedOn: '2026-08-01',
      pulls: [{ cardVariantId: 'v-1', condition: 'NM', quantity: 1 }],
      trackingCompleteness: 'all_cards',
    }
    await expect(controller.createOpening(input)).resolves.toEqual({ openingId: 'opening-1' })
    expect(createOpeningRecord).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'key-1', sourceLotId: 'lot-1', quantity: 2 }),
    )
  })

  it('createBoughtAndOpened forwards the exact total paid', async () => {
    createProvisionalRecord.mockResolvedValue({ id: 'opening-9' })
    const controller = getOpeningController()
    const input: BoughtAndOpenedInput = {
      idempotencyKey: 'key-2',
      sealedProductId: 'product-1',
      quantity: 3,
      totalPaidNokMinor: 29995n,
      purchasedOn: '2026-08-01',
      pulls: [],
      trackingCompleteness: 'all_cards',
    }
    await expect(controller.createBoughtAndOpened(input)).resolves.toEqual({
      openingId: 'opening-9',
    })
    expect(createProvisionalRecord).toHaveBeenCalledWith(
      expect.objectContaining({ totalPaidNokMinor: 29995n }),
    )
  })

  it('getOpening composes the detail from get_opening plus its per-pull lines', async () => {
    fetchOpening.mockResolvedValue({
      id: 'opening-1',
      openedOn: '2026-08-01',
      sealedProductId: 'product-1',
      sealedProductName: 'Prismatic ETB',
      sourceLotId: 'lot-1',
      quantityOpened: 2,
      costSource: 'from_lot',
      costNokMinor: 19996n,
      trackingCompleteness: 'selected_pulls',
      bulkRemainderEstimateNokMinor: null,
      bulkRemainderCount: null,
      provisionalPurchaseId: 'purchase-1',
      reconciledAt: null,
      reconciledToPurchaseId: null,
      notes: null,
      voidedAt: null,
      createdAt: '2026-08-01T10:00:00Z',
      retainedTrackedValueNokMinor: 50000n,
      pricedPullLotCount: 1,
      unpricedPullLotCount: 0,
      soldPullLotCount: 0,
      netProceedsFromSoldPullsNokMinor: 0n,
      openingReturnNokMinor: 30004n,
    })
    listOpeningPulls.mockResolvedValue([
      {
        lotId: 'pull-lot-1',
        displayName: 'Charizard ex',
        subtitle: 'Obsidian Flames · 125',
        imageUrl: null,
        condition: 'NM',
        quantity: 1,
        quantityRemaining: 1,
      },
    ])
    const controller = getOpeningController()
    const detail = await controller.getOpening('opening-1')
    // Provisional provenance surfaces as the typed marker; reconciled would suppress it.
    expect(detail.costProvisional).toBe(true)
    expect(detail.costKnown).toBe(true)
    expect(detail.costNokMinor).toBe(19996n)
    expect(detail.resultNokMinor).toBe(30004n)
    expect(detail.pulls).toEqual([
      expect.objectContaining({ lotId: 'pull-lot-1', displayName: 'Charizard ex' }),
    ])
    expect(listOpeningPulls).toHaveBeenCalledWith('opening-1')
  })

  it('a refused void becomes { blocked: true } with the concise reason — not a thrown error', async () => {
    voidOpeningRecord.mockRejectedValue(
      new Error(
        'opening x cannot be voided: a pulled card already has a downstream disposal (sale y) — void that transaction first',
      ),
    )
    const controller = getOpeningController()
    const outcome = await controller.voidOpening('opening-1')
    expect(outcome.blocked).toBe(true)
    expect(outcome.blockedReason).toMatch(/has been sold/)
  })

  it('already-voided is surfaced as a blocked outcome too', async () => {
    voidOpeningRecord.mockRejectedValue(new Error('opening x is already voided'))
    const controller = getOpeningController()
    const outcome = await controller.voidOpening('opening-1')
    expect(outcome).toEqual({
      blocked: true,
      blockedReason: 'This opening has already been corrected.',
    })
  })

  it('over-opening maps to an honest availability message', async () => {
    createOpeningRecord.mockRejectedValue(
      new Error('only 1 of the selected lot remain available, but 2 were requested'),
    )
    const controller = getOpeningController()
    await expect(
      controller.createOpening({
        idempotencyKey: 'k',
        sourceLotId: 'lot-1',
        quantity: 2,
        openedOn: '2026-08-01',
        pulls: [],
        trackingCompleteness: 'all_cards',
      }),
    ).rejects.toThrow(/Not enough unopened units left/)
  })
})
