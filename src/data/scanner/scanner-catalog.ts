/**
 * Bounded candidate retrieval for the scanner (P67 §11, §12, §21, §24).
 *
 * The ONLY data file the scanner matching flow adds. It reuses the existing `search_cards`
 * surface through src/data/catalog.ts — no new RPC, no migration, no direct provider calls,
 * no second search implementation. The manual-search fallback (§24) is literally the same
 * exported `searchCards` the Catalog page already uses; nothing is duplicated here.
 *
 * Bounds: at most two queries per scan, each limited to MAX_RAW_CANDIDATES rows, merged and
 * deduplicated before ranking. An observation without a usable signal performs ZERO provider
 * calls. Provider failures are mapped to ScannerCatalogUnavailableError with a generic message
 * — raw PostgREST/network error text must never reach UI or logs that render it.
 */
import { searchCards } from '../catalog'
import {
  hasUsableSignal,
  parseScannerSignals,
  type ParsedCollectorNumber,
  type ScannerCandidateRecord,
  type ScannerObservation,
} from '../../domain/scanner'

const MAX_RAW_CANDIDATES = 40

/** Maximum characters for any scanner signal passed to the catalog. Bounded early enough that
 *  OCR text, manual fallback inputs, and catalog query strings cannot grow unbounded. */
export const MAX_SCANNER_SIGNAL_CHARS = 64

/** Thrown when the catalog cannot be reached at all. Carries NO underlying provider detail. */
export class ScannerCatalogUnavailableError extends Error {
  constructor() {
    super('Card catalog lookup failed. Check your connection and try again.')
    this.name = 'ScannerCatalogUnavailableError'
  }
}

/** Reconstructs the printed id form to embed in a search query ("SV001", "4"). */
function queryNumberText(parsed: ParsedCollectorNumber): string {
  return `${parsed.prefix}${parsed.numericText}`
}

/**
 * Returns the unpadded equivalent of a collector number for retrieval (M1, P70).
 * "049" → "49", "001" → "1"; prefixed forms like "SV049" → "SV49".
 * Returns null when the number has no leading zeros to strip (already unpadded).
 */
function unpaddedNumberText(parsed: ParsedCollectorNumber): string | null {
  const stripped = parsed.numericText.replace(/^0+/, '')
  if (stripped === parsed.numericText || stripped === '') return null
  return `${parsed.prefix}${stripped}`
}

/** "Pikachu" + "4" → "Pikachu 4" — the shape `search_cards`' trailing-number token expects. */
function composeQuery(name: string, numberText: string): string {
  return `${name} ${numberText}`
}

/** L3 (P70): Cap a query string to a safe maximum. OCR can produce arbitrarily long text;
 *  PostgREST and search_cards have no use for signals beyond MAX_SCANNER_SIGNAL_CHARS. */
function capQuery(query: string): string {
  return query.length > MAX_SCANNER_SIGNAL_CHARS ? query.slice(0, MAX_SCANNER_SIGNAL_CHARS) : query
}

/**
 * Number-first strategy (§11): when a local id was read it rides along in the query so
 * `search_cards`' own trailing-number ranking applies; a plain name query runs alongside as
 * fallback for scans where OCR mangled the digits but read the name cleanly. Name-only scans
 * issue exactly one query.
 */
export async function retrieveScannerCandidates(
  observation: ScannerObservation,
): Promise<ScannerCandidateRecord[]> {
  const signals = parseScannerSignals(observation)
  if (!hasUsableSignal(signals)) return []

  const language = signals.languageHint
  const attempts: { query: string }[] = []
  if (signals.collectorNumber !== null && signals.normalizedName !== null) {
    const numberQuery = composeQuery(
      signals.normalizedName,
      queryNumberText(signals.collectorNumber),
    )
    attempts.push({ query: capQuery(numberQuery) }, { query: capQuery(signals.normalizedName) })
    // M1 (P70): try unpadded collector number to handle leading-zero mismatches between OCR
    // output ("049") and the catalog's stored form ("49"). The padded form is tried first;
    // unpadded is a low-cost supplementary attempt that costs one extra RPC.
    const unpadded = unpaddedNumberText(signals.collectorNumber)
    if (unpadded !== null) {
      attempts.push({ query: capQuery(composeQuery(signals.normalizedName, unpadded)) })
    }
  } else if (signals.collectorNumber !== null) {
    attempts.push({ query: capQuery(queryNumberText(signals.collectorNumber)) })
    const unpadded = unpaddedNumberText(signals.collectorNumber)
    if (unpadded !== null) {
      attempts.push({ query: capQuery(unpadded) })
    }
  } else if (signals.normalizedName !== null) {
    attempts.push({ query: capQuery(signals.normalizedName) })
  }

  const settled = await Promise.allSettled(
    attempts.map((attempt) =>
      searchCards({ query: attempt.query, language, limit: MAX_RAW_CANDIDATES }),
    ),
  )

  const byCardId = new Map<string, ScannerCandidateRecord>()
  let anySucceeded = false
  for (const outcome of settled) {
    if (outcome.status === 'rejected') continue
    anySucceeded = true
    for (const row of outcome.value.results) {
      if (!byCardId.has(row.cardId)) {
        byCardId.set(row.cardId, {
          cardId: row.cardId,
          name: row.name,
          localId: row.localId,
          rarity: row.rarity,
          category: row.category,
          illustrator: row.illustrator,
          imageBaseUrl: row.imageBaseUrl,
          language: row.language,
          setId: row.setId,
          setName: row.setName,
          variantCount: row.variantCount,
        })
      }
    }
  }

  if (!anySucceeded) throw new ScannerCatalogUnavailableError()
  return [...byCardId.values()]
}
