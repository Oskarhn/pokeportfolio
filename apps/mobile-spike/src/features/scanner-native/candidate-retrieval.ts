import { getCardsByIds, searchCards, type CatalogCard } from '@shared/data/catalog'
import type { ScannerCandidateRecord } from '@shared/domain/scanner/types'

/**
 * Hybrid retrieval (mirrors the web scanner's own P76 §16 approach): text search recall (via the
 * existing `search_cards` RPC, when OCR read a plausible name/number) UNION the visual channel's
 * top-K catalog ids (via `getCardsByIds`), deduplicated by card id. `engine.ts` only SCORES —
 * fetching/merging identity is this module's job, same layer boundary the web scanner documents.
 *
 * `variantCount` is not returned by `getCardsByIds` (unlike `search_cards`, which computes it) —
 * a visual-only candidate that never matched by text therefore carries `variantCount: 0` here.
 * `engine.ts` never reads this field in its scoring (informational only per its own doc); the real
 * printing count is always re-fetched from `getCardVariants` once a card is CONFIRMED, before any
 * price lookup or write — see `PriceCheckFlowStore`/AddIntentScreen. Disclosed limitation, not a
 * silent one: docs/mobile/P182_PORTABILITY_AUDIT.md.
 */
export async function retrieveCandidates(input: {
  readonly ocrName: string | null
  readonly ocrCollectorNumber: string | null
  readonly visualCardIds: readonly string[]
}): Promise<ScannerCandidateRecord[]> {
  const byId = new Map<string, ScannerCandidateRecord>()

  const textQuery = [input.ocrName, input.ocrCollectorNumber]
    .filter((s) => s !== null)
    .join(' ')
    .trim()
  if (textQuery.length >= 2) {
    const page = await searchCards({ query: textQuery, language: 'en', limit: 25 })
    for (const result of page.results) {
      byId.set(result.cardId, {
        cardId: result.cardId,
        name: result.name,
        localId: result.localId,
        rarity: result.rarity,
        category: result.category,
        illustrator: result.illustrator,
        imageBaseUrl: result.imageBaseUrl,
        language: result.language,
        setId: result.setId,
        setName: result.setName,
        variantCount: result.variantCount,
      })
    }
  }

  const missingVisualIds = input.visualCardIds.filter((id) => !byId.has(id))
  if (missingVisualIds.length > 0) {
    const cards = await getCardsByIds(missingVisualIds, 'en')
    for (const card of cards) {
      byId.set(card.id, toCandidateRecord(card))
    }
  }

  return [...byId.values()]
}

function toCandidateRecord(card: CatalogCard): ScannerCandidateRecord {
  return {
    cardId: card.id,
    name: card.name,
    localId: card.localId,
    rarity: card.rarity,
    category: card.category,
    illustrator: card.illustrator,
    imageBaseUrl: card.imageBaseUrl,
    language: card.language,
    setId: card.setId,
    setName: card.setName,
    variantCount: 0,
  }
}
