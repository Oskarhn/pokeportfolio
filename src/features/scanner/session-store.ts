/**
 * Scanner session defaults (prompt §25/§26/§27): origin, condition, language, storage location
 * and acquired date, set once per scanning session in a persistent header and applied to every
 * committed batch item. Session MEMORY ONLY, scoped by authenticated user id exactly like the
 * openings draftStore — private collection intent must never survive an identity change, and
 * `clearAll()` is wired into both auth paths that end a session (AuthProvider.signOut and the
 * D-093 query-cache boundary). No localStorage/sessionStorage/IndexedDB anywhere.
 *
 * Financial guard (prompt §26): the standalone scanner is an identification accelerator, NOT a
 * purchase ledger. Default origin is pre_tracking ("Existing collection"); purchase is offered
 * only with the explicit understanding that no cost is recorded here; `opening` is structurally
 * absent from the type so standalone scans can never fabricate pull provenance — M16's Opening
 * workflow owns pulled-card origins inside its own flow. No cost amount is ever collected, so
 * no zero is ever fabricated: basis state derives purely from the origin via the SHARED
 * fixedCostBasisState helper extracted from the add-card flow.
 */

import type { CardCondition, CostBasisState, LotOrigin } from '../../data/collection'
import { fixedCostBasisState as sharedFixedCostBasisState } from '../collection/origin-basis'
import { localTodayIso } from '../../platform/local-date'

/** Origins the STANDALONE scanner may offer. `opening` deliberately absent (see above). */
export type ScannerOrigin = Exclude<LotOrigin, 'opening'>

export const SCANNER_ORIGINS: readonly ScannerOrigin[] = [
  'pre_tracking',
  'gift',
  'trade_in',
  'other',
  'purchase',
]

export const SCANNER_DEFAULT_ORIGIN: ScannerOrigin = 'pre_tracking'

/**
 * The basis state the scanner commits for an origin: the SHARED add-flow mapping where it
 * decides, and 'unknown' where the full add-flow would have asked (no amounts are collected in
 * the scanner, and a missing cost is never fabricated into zero).
 */
export function scannerCostBasisState(origin: ScannerOrigin): CostBasisState {
  return sharedFixedCostBasisState(origin) ?? 'unknown'
}

export const todayIso = localTodayIso

export interface ScannerSessionDefaults {
  origin: ScannerOrigin
  condition: CardCondition
  /** V1 recognition is English-only (prompt §24); this records the session's catalog language
   *  for manual search and display. It never claims Japanese OCR exists. */
  language: 'en'
  storageLocationId: string | null
  acquiredOn: string
}

export function initialScannerDefaults(
  overrides?: Partial<Pick<ScannerSessionDefaults, 'condition' | 'storageLocationId'>>,
): ScannerSessionDefaults {
  return {
    origin: SCANNER_DEFAULT_ORIGIN,
    condition: overrides?.condition ?? 'NM',
    language: 'en',
    storageLocationId: overrides?.storageLocationId ?? null,
    acquiredOn: todayIso(),
  }
}

const sessionsByUser = new Map<string, ScannerSessionDefaults>()

/** User-scoped session-defaults holder — same discipline as openings' draftStore (§27). */
export const scannerSessionStore = {
  load(userId: string | null): ScannerSessionDefaults | null {
    return userId === null ? null : (sessionsByUser.get(userId) ?? null)
  },
  save(userId: string | null, defaults: ScannerSessionDefaults): void {
    if (userId === null) return
    sessionsByUser.set(userId, defaults)
  },
  clearAll(): void {
    sessionsByUser.clear()
  },
}
