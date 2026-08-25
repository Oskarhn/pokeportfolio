import { supabase } from './supabase-client'

/**
 * The unified History read surface (P43, 20260901120010_p43_reset_and_history.sql). One bounded,
 * keyset-paginated RPC over the canonical event sources that exist today — purchases, sales,
 * non-purchase acquisitions ("Added") and active manual valuations. Components call these, never
 * `supabase.rpc('list_history_events')` directly — same rule as every other src/data module.
 *
 * Voided/corrected entries are a display filter (p_includeVoided), never an accounting change:
 * hiding them alters no total anywhere (DECISIONS.md D-084's CORRECTION vs DISPLAY-FILTER
 * distinction).
 */

export type HistoryEventKind = 'purchase' | 'sale' | 'acquisition' | 'valuation'

export interface HistoryEvent {
  kind: HistoryEventKind
  primaryId: string
  /** The holding the event belongs to, where one exists (acquisitions and valuations). */
  secondaryId: string | null
  occurredOn: string
  recordedAt: string
  title: string
  subtitle: string
  amountNokMinor: bigint | null
  status: 'active' | 'voided'
  href: string
}

interface HistoryEventRow {
  event_kind: string
  primary_id: string
  secondary_id: string | null
  occurred_on: string
  recorded_at: string
  title: string
  subtitle: string
  amount_nok_minor: string | null
  status: string
  href: string
}

function mapEvent(row: HistoryEventRow): HistoryEvent {
  return {
    kind: row.event_kind as HistoryEventKind,
    primaryId: row.primary_id,
    secondaryId: row.secondary_id,
    occurredOn: row.occurred_on,
    recordedAt: row.recorded_at,
    title: row.title,
    subtitle: row.subtitle,
    amountNokMinor: row.amount_nok_minor === null ? null : BigInt(row.amount_nok_minor),
    status: row.status === 'voided' ? 'voided' : 'active',
    href: row.href,
  }
}

export interface HistoryQuery {
  kind?: HistoryEventKind
  includeVoided?: boolean
  limit?: number
  /** Keyset cursor: the previous page's last event's recordedAt/primaryId pair. */
  before?: { recordedAt: string; primaryId: string }
}

export async function listHistoryEvents(query: HistoryQuery = {}): Promise<HistoryEvent[]> {
  const { data, error } = await supabase
    .rpc('list_history_events', {
      p_kind: query.kind,
      p_include_voided: query.includeVoided ?? false,
      p_limit: query.limit,
      p_before_at: query.before?.recordedAt,
      p_before_id: query.before?.primaryId,
    })
    .overrideTypes<HistoryEventRow[], { merge: false }>()
  if (error) throw new Error(error.message)
  return data.map(mapEvent)
}
