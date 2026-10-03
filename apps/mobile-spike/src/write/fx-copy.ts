import { formatMoney } from '../money/format-money'
import type { FxWriteState } from './fx-for-write'
import type { Money } from '../features/price-check/p165-domain/money'

/**
 * The one place that turns an {@link FxWriteState} into what the purchase/sale screens show.
 * Mirrors `price-copy.ts`'s `nokText` wording so the same rate reads the same way whether the
 * person sees it on Price Check or on a write form — never a second, differently-worded FX
 * vocabulary for the identical `fx_rates` row.
 */
export function fxWriteNotice(
  state: FxWriteState,
  nokReference: Money | null,
): { text: string; tone: 'info' | 'warning' | 'danger' } | null {
  switch (state.kind) {
    case 'not_needed':
      return null
    case 'loading':
      return { text: 'Looking up today’s exchange rate…', tone: 'info' }
    case 'ready': {
      const ref = nokReference !== null ? ` — ${formatMoney(nokReference)} NOK reference` : ''
      const staleNote = state.stale ? ' (this rate is more than a week old)' : ''
      return {
        text: `Rate ${state.rateToNok} NOK per unit (Norges Bank, ${state.rateDate})${staleNote}${ref}`,
        tone: state.stale ? 'warning' : 'info',
      }
    }
    case 'missing':
      return {
        text: 'No exchange rate is available for this currency yet. Choose NOK, or try again once a rate has been fetched.',
        tone: 'danger',
      }
    case 'malformed':
      return {
        text: 'The stored exchange rate for this currency is not valid, so this purchase cannot be recorded in this currency right now.',
        tone: 'danger',
      }
    case 'read_failed':
      return {
        text: 'Could not read the exchange rate — check your connection and try again.',
        tone: 'danger',
      }
  }
}
