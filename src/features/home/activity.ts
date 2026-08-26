import type { RecentActivityItem } from '../../data/dashboard'

/**
 * Home's Recent Activity row contract, PURE (P59 §5): every activity type the backend can emit
 * renders a nonblank label and, where a detail surface exists, a clickable route. M16's backend
 * arm emits one 'opening' row per active opening; before this union was extended the client
 * rendered those rows blank and dead (P58 F1). The amount shown beside an opening is its
 * analytical cost — it renders here but is never summed into any Home total
 * (FINANCIAL_MODEL §5.4 / F8 scope).
 */
export const ACTIVITY_LABEL: Record<RecentActivityItem['type'], string> = {
  purchase: 'Recorded purchase',
  sale: 'Sold',
  valuation: 'Set valuation',
  acquisition: 'Acquired',
  opening: 'Opened',
}

export function recentActivityRoute(item: RecentActivityItem):
  | {
      to: '/purchases/$purchaseId'
      params: { purchaseId: string }
    }
  | {
      to: '/sales/$saleId'
      params: { saleId: string }
    }
  | {
      to: '/openings/$openingId'
      params: { openingId: string }
    }
  | {
      to: '/portfolio/$holdingId'
      params: { holdingId: string }
    }
  | null {
  switch (item.type) {
    case 'purchase':
      return { to: '/purchases/$purchaseId', params: { purchaseId: item.primaryId } }
    case 'sale':
      return { to: '/sales/$saleId', params: { saleId: item.primaryId } }
    case 'opening':
      return { to: '/openings/$openingId', params: { openingId: item.primaryId } }
    case 'valuation':
    case 'acquisition':
      return item.secondaryId
        ? { to: '/portfolio/$holdingId', params: { holdingId: item.secondaryId } }
        : null
  }
}
