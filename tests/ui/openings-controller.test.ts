import { describe, expect, it } from 'vitest'

import {
  getOpeningController,
  OpeningsNotIntegratedError,
} from '../../src/features/openings/controller'
import type {
  CreateOpeningInput,
  OpeningController,
  OpeningDetail,
  OpeningSource,
  VoidOpeningOutcome,
} from '../../src/features/openings/contract'

/**
 * The P51↔P53 seam (prompt §5): the UI's controller boundary is replaceable, the shipped default
 * fails HONESTLY until integration, and a blocking void answer travels verbatim to the caller
 * with no client-side workaround logic anywhere.
 */

const SOURCE: OpeningSource = {
  lotId: 'lot-1',
  holdingId: 'holding-1',
  productId: 'product-1',
  productName: 'Booster box',
  quantityAvailable: 10,
  acquiredOn: '2026-07-01',
  costKnown: true,
  unitCostNokMinor: 119900n,
}

const INPUT: CreateOpeningInput = {
  idempotencyKey: 'key',
  sourceLotId: 'lot-1',
  quantity: 2,
  openedOn: '2026-08-01',
  pulls: [],
  trackingCompleteness: 'all_cards',
}

describe('shipped controller default', () => {
  it('every action refuses honestly — no demo data, no fake success', async () => {
    const controller = getOpeningController()
    await expect(controller.getEligibleSealedSources()).rejects.toBeInstanceOf(
      OpeningsNotIntegratedError,
    )
    await expect(controller.createOpening(INPUT)).rejects.toThrow(/not connected/)
    await expect(controller.getOpening('opening-1')).rejects.toThrow(/not connected/)
    await expect(controller.voidOpening('opening-1')).rejects.toThrow(/not connected/)
  })
})

describe('the seam accepts an integration adapter (P53)', () => {
  it('a backend-backed controller satisfies the contract, including blocked voids', async () => {
    const DETAIL: OpeningDetail = {
      openingId: 'opening-9',
      productName: 'Booster box',
      openedOn: '2026-08-01',
      quantityOpened: 2,
      costKnown: true,
      costNokMinor: 239800n,
      trackingCompleteness: 'selected_pulls',
      bulkRemainderEstimateMinor: null,
      bulkRemainderCount: null,
      pulls: [
        {
          lotId: 'pull-lot-1',
          displayName: 'Charizard ex',
          subtitle: null,
          quantity: 1,
          currentValueNokMinor: null,
          soldProceedsNokMinor: undefined,
        },
      ],
      retainedTrackedValueNokMinor: undefined,
      soldPullProceedsNokMinor: undefined,
      resultNokMinor: undefined,
      voidedAt: null,
    }
    const BLOCKED: VoidOpeningOutcome = {
      blocked: true,
      blockedReason: 'A pull of this opening was sold on 12 Aug 2026 — void that sale first.',
    }

    // The exact shape the P53 integration will provide over Supabase RPCs.
    const wiredController: OpeningController = {
      getEligibleSealedSources() {
        return Promise.resolve([SOURCE])
      },
      createOpening(input) {
        expect(input.idempotencyKey).toBe('key')
        return Promise.resolve({ openingId: 'opening-9' })
      },
      getOpening() {
        return Promise.resolve(DETAIL)
      },
      voidOpening() {
        return Promise.resolve(BLOCKED)
      },
    }

    await expect(
      wiredController.getEligibleSealedSources({ holdingId: 'holding-1' }),
    ).resolves.toHaveLength(1)
    const created = await wiredController.createOpening(INPUT)
    expect(created.openingId).toBe('opening-9')

    const detail = await wiredController.getOpening(created.openingId)
    // Typed optional states survive the seam: `undefined` (adapter lacks it) is distinct from
    // `null` (genuinely unavailable) — prompt §16.
    expect(detail.retainedTrackedValueNokMinor).toBeUndefined()
    expect(detail.pulls[0]?.currentValueNokMinor).toBeNull()

    // A blocked correction surfaces the backend's reason verbatim; the client adds nothing.
    const outcome = await wiredController.voidOpening(created.openingId)
    expect(outcome.blocked).toBe(true)
    if (outcome.blocked) {
      expect(outcome.blockedReason).toMatch(/void that sale first/)
    }
  })
})
