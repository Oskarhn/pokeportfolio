import type { CardDisplaySummary } from './navigation-types'

/**
 * P180: the one place that turns a `CardDisplaySummary` (or its absence) into the line a write
 * screen shows for "which card is this". Never falls back to `cardId`/`variantId` — those are
 * internal identifiers (RecordPurchaseScreen's pre-P180 defect was showing exactly that pair as
 * "Card variant <uuid> · <uuid>"). Without a display summary the honest fallback is a plain,
 * UUID-free sentence, matching this project's "absent data is displayed as absent" rule rather
 * than fabricating a name.
 */
export function cardIdentityLine(display: CardDisplaySummary | undefined): string {
  if (display === undefined) return 'Selected card'
  const parts = [
    display.name,
    [display.setName, `#${display.collectorNumber}`, display.languageLabel]
      .filter((p) => p !== '')
      .join(' · '),
    display.printingLabel,
  ].filter((p) => p !== '')
  return parts.join(' — ')
}
