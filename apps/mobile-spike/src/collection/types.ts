import type { Money } from '@shared/domain/money'

/**
 * What the collection screens need, and nothing more. A slim row (about a dozen fields instead of the
 * shared `PortfolioTile`'s forty) keeps ten thousand holdings small in memory; the detail screen
 * fetches the rest by `holdingId`.
 */
export type PriceState = 'manual' | 'fresh' | 'stale' | 'missing'

export interface CollectionRow {
  holdingId: string
  holdingKind: 'raw_card' | 'graded_card' | 'sealed'
  title: string
  subtitle: string
  quantity: number
  /** Exact NOK minor units of the whole holding; null = no resolvable value (NEVER zero). */
  holdingValueMinor: bigint | null
  priceState: PriceState
  cardVariantId: string | null
}

export type CollectionSort = 'added_newest' | 'value_desc'

/** Opaque to everything except the adapter that produced it. */
export type CollectionCursor = unknown

export interface CollectionPage {
  rows: CollectionRow[]
  nextCursor: CollectionCursor
}

export interface CollectionCounts {
  uniqueHoldingCount: number
  physicalCardCount: number
  pricedHoldingCount: number
  unpricedHoldingCount: number
  portfolioValueMinor: bigint
}

export interface HoldingDetail {
  holdingId: string
  title: string
  subtitle: string
  quantity: number
  lotCount: number
  finish: 'normal' | 'holo' | 'reverse' | 'other' | null
  condition: string | null
  cardVariantId: string | null
  priceState: PriceState
  unitValueMinor: bigint | null
  holdingValueMinor: bigint | null
  provider: string | null
  sourceCurrency: string | null
  sourceValueMinor: bigint | null
  snapshotDate: string | null
  providerUpdatedAt: string | null
}

export interface CollectionPort {
  listPage(input: {
    sort: CollectionSort
    cursor: CollectionCursor
    limit: number
  }): Promise<CollectionPage>
  counts(): Promise<CollectionCounts>
  getDetail(holdingId: string): Promise<HoldingDetail | null>
}

export function nokMoney(minor: bigint | null): Money | null {
  return minor === null ? null : { minorUnits: minor, currency: 'NOK' }
}
