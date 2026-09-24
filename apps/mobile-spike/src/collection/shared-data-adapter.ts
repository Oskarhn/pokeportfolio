import { getHoldingSummary, getHoldingValueProvenance } from '@shared/data/collection'
import {
  getPortfolioCounts,
  listPortfolio,
  portfolioDisplayName,
  portfolioSubtitle,
  type PortfolioCursor,
  type PortfolioTile,
} from '@shared/data/portfolio'
import { UnsafeMoneyTransportError } from '../money/wire'
import type {
  CollectionCounts,
  CollectionPage,
  CollectionPort,
  CollectionRow,
  CollectionSort,
  HoldingDetail,
} from './types'

/**
 * The collection port backed by the web app's RELEASED data layer (src/data/portfolio.ts,
 * src/data/collection.ts, DB 104), reused unchanged through the `@shared` alias and the
 * `./supabase-client` seam. Nothing here talks to Supabase directly.
 *
 * SPIKE_ONLY adapter: when P149 releases, this file is the ONE place that changes to its leased,
 * exact-money data functions; the port interface and every screen above it stay as they are.
 *
 * Money: `list_portfolio` and `portfolio_counts` return every money column as TEXT (`::text`), so
 * `holdingValueMinor` is an exact bigint above 2^53. The one number-typed money value on this path is
 * the keyset CURSOR's value (`Number(cursor.valueMinor)` in the shared wrapper); a value above 2^53
 * would be rounded on the way back to the server and the next page would start in the wrong place.
 * The adapter refuses that cursor explicitly (fail closed), on top of the transport guard.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * The server clamps p_limit to 100 (list_portfolio: least(greatest(p_limit, 1), 100), migration
 * 20260826120030). The shared wrapper decides "there is a next page" by `results.length === limit`,
 * so asking for more than 100 would make every list look finished after the first page (silent
 * truncation). The adapter therefore never asks for more than the server returns.
 */
export const SERVER_MAX_PAGE_SIZE = 100

function toRow(tile: PortfolioTile): CollectionRow {
  return {
    holdingId: tile.holdingId,
    holdingKind: tile.holdingKind,
    title: portfolioDisplayName(tile),
    subtitle: portfolioSubtitle(tile),
    quantity: tile.quantity,
    holdingValueMinor: tile.holdingValueMinor,
    priceState: tile.priceState,
    cardVariantId: tile.cardVariantId,
  }
}

function assertSafeCursor(sort: CollectionSort, cursor: PortfolioCursor | null): void {
  if (cursor === null) return
  if (sort !== 'value_desc') return
  const value = cursor.valueMinor
  if (value !== null && (value > MAX_SAFE || value < -MAX_SAFE)) {
    throw new UnsafeMoneyTransportError(
      'cursor.valueMinor',
      'the value cursor cannot be sent as an exact number',
    )
  }
}

export function createSharedCollectionPort(): CollectionPort {
  return {
    async listPage({ sort, cursor, limit }): Promise<CollectionPage> {
      const typed = cursor as PortfolioCursor | null
      assertSafeCursor(sort, typed)
      const page = await listPortfolio({
        sort,
        cursor: typed,
        limit: Math.min(limit, SERVER_MAX_PAGE_SIZE),
      })
      return { rows: page.results.map(toRow), nextCursor: page.nextCursor }
    },

    async counts(): Promise<CollectionCounts> {
      const c = await getPortfolioCounts()
      return {
        uniqueHoldingCount: c.uniqueHoldingCount,
        physicalCardCount: c.physicalCardCount,
        pricedHoldingCount: c.pricedHoldingCount,
        unpricedHoldingCount: c.unpricedHoldingCount,
        portfolioValueMinor: c.portfolioValueMinor,
      }
    },

    async getDetail(holdingId): Promise<HoldingDetail | null> {
      const [summary, provenance] = await Promise.all([
        getHoldingSummary(holdingId),
        getHoldingValueProvenance(holdingId),
      ])
      if (summary === null) return null
      const cardName = summary.cardName ?? summary.manualName ?? summary.sealedProductName
      const setName = summary.cardSetName ?? summary.manualSetName ?? summary.sealedSetName
      const number = summary.cardLocalId ?? summary.manualCollectorNumber
      return {
        holdingId: summary.holdingId,
        title: cardName ?? 'Unknown item',
        subtitle: setName && number ? `${setName} · #${number}` : (setName ?? ''),
        quantity: summary.quantity,
        lotCount: summary.lotCount,
        finish: summary.variantFinish,
        condition: summary.condition,
        cardVariantId: summary.cardVariantId,
        priceState: provenance.priceState,
        unitValueMinor: provenance.unitValueMinor,
        holdingValueMinor: provenance.holdingValueMinor,
        provider: provenance.provider,
        sourceCurrency: provenance.sourceCurrency,
        sourceValueMinor: provenance.sourceValueMinor,
        snapshotDate: provenance.snapshotDate,
        providerUpdatedAt: provenance.providerUpdatedAt,
      }
    },
  }
}
