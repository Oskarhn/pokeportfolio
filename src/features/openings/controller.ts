import {
  createProvisionalOpening,
  createOpening as createOpeningRecord,
  getOpening as fetchOpening,
  listOpeningPulls,
  listOpeningSources,
  voidOpening as voidOpeningRecord,
} from '../../data/opening'
import type {
  BoughtAndOpenedInput,
  CreateOpeningInput,
  OpeningController,
  OpeningDetail,
  OpeningSource,
  VoidOpeningOutcome,
} from './contract'

/**
 * The M16 integration adapter (P53): the single place the opening feature meets the backend.
 * Every method delegates to `src/data/opening` (the only module allowed to touch Supabase RPCs)
 * and maps results/errors into the feature-local {@link OpeningController} contract. No demo
 * data, no fake success, no raw PostgreSQL internals shown to the user (P53 §29): known server
 * outcomes become concise messages, and a blocked void comes back as
 * `{ blocked: true, blockedReason }` which the screens render verbatim.
 */

/** Server outcomes that mean "the operation was refused, nothing changed" rather than "broken". */
const BLOCKED_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  {
    // void_opening's downstream-dependency guard names the blocking sale/disposal id.
    pattern: /cannot be voided: a pulled card already has a downstream disposal/i,
    message:
      'This opening cannot be corrected yet because one of its pulled cards has been sold. Void that sale first.',
  },
  {
    pattern: /is already voided/i,
    message: 'This opening has already been corrected.',
  },
]

/** Known refusals mapped to concise user-facing sentences (P53 §29). Never logs money figures. */
export function mapOpeningErrorMessage(rawMessage: string): string {
  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.pattern.test(rawMessage)) return blocked.message
  }
  if (/idempotency-key-reuse/.test(rawMessage)) {
    return 'This opening was already recorded with different details. Check History before trying again.'
  }
  if (
    /only \d+ of the selected lot remain|of the selected lot remain available/i.test(rawMessage)
  ) {
    return 'Not enough unopened units left in that acquisition — another record may have used them first.'
  }
  if (/openings consume sealed lots only/i.test(rawMessage)) {
    return 'Only sealed products can be opened.'
  }
  if (/source lot is unavailable/.test(rawMessage)) {
    return 'That sealed product lot is no longer available to open.'
  }
  if (/sealed product .* not found or not accessible/i.test(rawMessage)) {
    return 'That sealed product could not be found in your catalog.'
  }
  if (/provisional purchase does not match/.test(rawMessage)) {
    return 'The purchase link for this opening no longer matches — refresh and try again.'
  }
  if (/not authenticated/i.test(rawMessage)) {
    return 'Your session has ended. Sign in and try again.'
  }
  return 'Something went wrong recording this opening. Nothing has been added — try again.'
}

function toFriendlyError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(mapOpeningErrorMessage(message))
}

function mapSource(row: Awaited<ReturnType<typeof listOpeningSources>>[number]): OpeningSource {
  return {
    lotId: row.lotId,
    holdingId: row.holdingId,
    productId: row.productId,
    productName: row.productName,
    productTypeName: row.productType,
    imageUrl: row.imageUrl ?? undefined,
    quantityAvailable: row.quantityAvailable,
    acquiredOn: row.acquiredOn,
    costKnown: row.costKnown,
    effectiveUnitBasisNokMinor: row.effectiveUnitBasisNokMinor,
    exhaustionResidualNokMinor: row.exhaustionResidualNokMinor,
  }
}

async function mapDetail(
  openingId: string,
  row: NonNullable<Awaited<ReturnType<typeof fetchOpening>>>,
): Promise<OpeningDetail> {
  const pullLines = await listOpeningPulls(openingId)
  return {
    openingId: row.id,
    productName: row.sealedProductName,
    openedOn: row.openedOn,
    quantityOpened: row.quantityOpened,
    costKnown: row.costSource === 'from_lot',
    costNokMinor: row.costNokMinor,
    costProvisional:
      row.provisionalPurchaseId !== null && row.reconciledAt === null ? true : undefined,
    trackingCompleteness: row.trackingCompleteness,
    bulkRemainderEstimateMinor: row.bulkRemainderEstimateNokMinor,
    bulkRemainderCount: row.bulkRemainderCount,
    pulls: pullLines.map((pull) => ({
      lotId: pull.lotId,
      displayName: pull.displayName,
      subtitle: pull.subtitle,
      imageUrl: pull.imageUrl ?? undefined,
      quantity: pull.quantity,
      quantityRemaining: pull.quantityRemaining,
      // Per-line values stay unprovided (undefined ⇒ rows hide them): aggregate retained value
      // and sold proceeds arrive from get_opening instead — one resolver call, no N+1.
    })),
    retainedTrackedValueNokMinor: row.retainedTrackedValueNokMinor,
    soldPullProceedsNokMinor: row.netProceedsFromSoldPullsNokMinor,
    resultNokMinor: row.openingReturnNokMinor,
    voidedAt: row.voidedAt,
  }
}

const integratedController: OpeningController = {
  async getEligibleSealedSources(filter) {
    try {
      const rows = await listOpeningSources(filter)
      return rows.map(mapSource)
    } catch (error) {
      throw toFriendlyError(error)
    }
  },

  async createOpening(input: CreateOpeningInput) {
    try {
      const created = await createOpeningRecord({
        sourceLotId: input.sourceLotId,
        quantity: input.quantity,
        openedOn: input.openedOn,
        trackingCompleteness: input.trackingCompleteness,
        pulls: input.pulls.map((pull) => ({
          cardVariantId: pull.cardVariantId,
          manualCardId: pull.manualCardId,
          quantity: pull.quantity,
          condition: pull.condition ?? 'NM',
        })),
        bulkRemainderEstimateNokMinor: input.bulkRemainderEstimateMinor,
        bulkRemainderCount: input.bulkRemainderCount,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
      })
      return { openingId: created.id }
    } catch (error) {
      throw toFriendlyError(error)
    }
  },

  async createBoughtAndOpened(input: BoughtAndOpenedInput) {
    try {
      const created = await createProvisionalOpening({
        sealedProductId: input.sealedProductId,
        quantity: input.quantity,
        totalPaidNokMinor: input.totalPaidNokMinor,
        purchasedOn: input.purchasedOn,
        openedOn: input.openedOn,
        trackingCompleteness: input.trackingCompleteness,
        pulls: input.pulls.map((pull) => ({
          cardVariantId: pull.cardVariantId,
          manualCardId: pull.manualCardId,
          quantity: pull.quantity,
          condition: pull.condition ?? 'NM',
        })),
        bulkRemainderEstimateNokMinor: input.bulkRemainderEstimateMinor,
        bulkRemainderCount: input.bulkRemainderCount,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
      })
      return { openingId: created.id }
    } catch (error) {
      throw toFriendlyError(error)
    }
  },

  async getOpening(openingId) {
    try {
      const row = await fetchOpening(openingId)
      if (!row) {
        throw new Error('Opening not found.')
      }
      return await mapDetail(openingId, row)
    } catch (error) {
      throw toFriendlyError(error)
    }
  },

  async voidOpening(openingId, reason): Promise<VoidOpeningOutcome> {
    try {
      await voidOpeningRecord(openingId, reason)
      return { blocked: false }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const blocked of BLOCKED_PATTERNS) {
        if (blocked.pattern.test(message)) {
          return { blocked: true, blockedReason: blocked.message }
        }
      }
      throw toFriendlyError(error)
    }
  },
}

export function getOpeningController(): OpeningController {
  return integratedController
}
