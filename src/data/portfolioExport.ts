import { listPortfolio, portfolioDisplayName, type PortfolioFilters } from './portfolio'
import { CONDITION_LABEL } from '../features/collection/labels'

/**
 * Minimal Portfolio CSV export (M7.1 prompt §46-47), pulled forward from M13 in the narrow sense
 * the owner asked for: the signed-in user's own current Portfolio only, safe non-secret fields,
 * current value only when genuinely known. M13 still owns the full CSV suite, versioned JSON
 * backup and the round-trip restore contract — this is not that.
 *
 * Streams pages through the existing `list_portfolio` keyset cursor rather than one unbounded
 * fetch, consistent with DATA_MODEL.md §10.1's "export is streamed/chunked, not assembled in
 * memory in one query" — this still builds one in-memory string at the end (a browser download has
 * nowhere else to stream to), but the *server* round trips stay bounded pages rather than one
 * unlimited query.
 */

const HEADERS = [
  'Card name',
  'Set',
  'Collector number',
  'Quantity',
  'Condition',
  'Variant',
  'Grade',
  'Storage',
  'Cost basis state',
  'Current value (NOK)',
] as const

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export async function buildPortfolioCsv(filters?: PortfolioFilters): Promise<string> {
  const rows: string[] = [HEADERS.join(',')]
  let cursor = null
  const seenIds = new Set<string>()

  // Bounded to a generous but finite number of pages so a pathological loop (a server-side cursor
  // bug that never terminates) cannot hang the browser tab — 10 000+ lots is the documented scale
  // target (DATA_MODEL.md §10.1) and this is 500 pages of 30, i.e. 15 000 holdings.
  for (let page = 0; page < 500; page++) {
    const result = await listPortfolio({ sort: 'name_asc', filters, cursor, limit: 100 })
    for (const tile of result.results) {
      if (seenIds.has(tile.holdingId)) continue
      seenIds.add(tile.holdingId)
      const variant = [tile.variantFinish, tile.variantSubtype, tile.variantStamp]
        .filter((v): v is string => Boolean(v) && v !== 'normal')
        .join(' · ')
      rows.push(
        [
          portfolioDisplayName(tile),
          tile.cardSetName ?? tile.manualSetName ?? '',
          tile.cardLocalId ?? tile.manualCollectorNumber ?? '',
          String(tile.quantity),
          tile.condition
            ? CONDITION_LABEL[tile.condition]
            : tile.grader
              ? `Graded (${tile.grader.toUpperCase()} ${tile.grade ?? ''})`.trim()
              : '',
          variant,
          tile.grade !== null ? String(tile.grade) : '',
          tile.hasMultipleStorageLocations ? 'Multiple locations' : '',
          tile.holdingKind === 'graded_card' && tile.resolvedValueMinor === null
            ? 'No manual value set'
            : '',
          tile.resolvedValueMinor !== null
            ? (Number(tile.resolvedValueMinor) / 100).toFixed(2)
            : '',
        ]
          .map(csvField)
          .join(','),
      )
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }

  return rows.join('\r\n')
}

/** Triggers a browser download of the built CSV — no server round trip beyond the data fetch
 *  itself, and nothing is ever written to Supabase Storage or any third party. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
