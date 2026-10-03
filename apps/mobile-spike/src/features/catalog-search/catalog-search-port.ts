import { searchCards, type CatalogLanguage } from '@shared/data/catalog'

/**
 * Catalog search over the RELEASED `search_cards` RPC (DB 104; unchanged on DB 106), reused through
 * the shared web data layer unchanged (`@shared/data/catalog`, which also brings the web's
 * auth-retry-once on a rejected token). The RPC matches the text part against card AND set names
 * (substring or trigram similarity) and a trailing number token against the collector number
 * ("4/102" matches card 4), and caps a page at 100 rows server-side.
 *
 * A hit carries everything needed to tell same-named cards apart WITHOUT a price: set, collector
 * number, language, rarity and the number of ACTIVE variants.
 */

export type { CatalogLanguage }

export interface SearchHit {
  readonly cardId: string
  readonly name: string
  readonly setId: string
  readonly setName: string
  readonly collectorNumber: string
  readonly language: CatalogLanguage
  readonly rarity: string | null
  /** Active variants only (search_cards counts `is_active`). */
  readonly activeVariantCount: number
}

export interface SearchPage {
  readonly hits: readonly SearchHit[]
  /** Total matches the server reports for this query (`count(*) over ()`). */
  readonly totalCount: number
}

export interface CatalogSearchPort {
  searchPage(params: {
    query: string
    language: CatalogLanguage | null
    offset: number
    limit: number
  }): Promise<SearchPage>
}

export function createSharedCatalogSearchPort(): CatalogSearchPort {
  return {
    async searchPage({ query, language, offset, limit }) {
      const page = await searchCards({ query, language, offset, limit })
      return {
        totalCount: page.totalCount,
        hits: page.results.map((r) => ({
          cardId: r.cardId,
          name: r.name,
          setId: r.setId,
          setName: r.setName,
          collectorNumber: r.localId,
          language: r.language,
          rarity: r.rarity,
          activeVariantCount: r.variantCount,
        })),
      }
    },
  }
}
