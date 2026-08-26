import type { CardCondition } from '../../data/collection'

/**
 * The boundary between M15's scanner UI (P66) and everything that makes scanning actually work —
 * the capture-analysis engine, the candidate search and the canonical acquisition path (P65/P67/
 * P68). The same one-place-replacement shape M13's export feature and M16's opening wizard used:
 *
 *   - The UI knows nothing about Supabase, RPC names, OCR or inference runtimes. It calls an
 *     {@link ScannerUiController} and renders whatever typed answer comes back.
 *   - `controller.ts` next door is the only file an integrator replaces; nothing in src/data or
 *     src/domain imports this module.
 *   - P66 ships a placeholder adapter that answers honestly (NO_MATCH / empty search / a commit
 *     refusal) so the flow is exercisable end-to-end without pretending to recognise anything.
 *
 * Honesty rules baked into these types:
 *   - Confidence is a coarse band supplied by the domain, never a percentage fabricated in the UI.
 *   - An absent match is NO_MATCH, never an empty-string name or a zeroed placeholder card.
 *   - A batch item stores card IDENTITY plus quantity/condition — never the captured photo.
 */

/** Coarse match quality bands (prompt §14). The UI renders badges per band; it never derives or
 *  displays numeric confidence — no calibrated meaning exists for one yet. */
export type ScannerConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_MATCH'

/** One proposed card identity. Opaque to the UI: `candidateId` is whatever key P68's engine and
 *  its catalog resolution agree on, handed back verbatim by commitBatch. */
export interface ScannerCandidate {
  candidateId: string
  name: string
  setName?: string | null
  collectorNumber?: string | null
  /** Catalog-style image base URL so the existing CardImage component can render it. Null means
   *  "no image available" and renders as the neutral placeholder — never a fabricated thumbnail. */
  imageBaseUrl?: string | null
  /** Finish of this exact printing ("Holo", "Reverse holo") when the engine resolved one.
   *  Identity-level facts come from the candidate; they are confirmed, not edited here. */
  finishLabel?: string | null
  languageLabel?: string | null
}

export interface ScannerAnalysis {
  confidence: ScannerConfidence
  /** Ordered best-first. Empty exactly when confidence is NO_MATCH. */
  candidates: ScannerCandidate[]
}

/** The bounded still frame handed to the engine — an in-memory JPEG blob plus pixel dimensions.
 *  Nothing here is persisted anywhere; ownership passes to the callee for the duration of the
 *  call only, and the UI disposes it as soon as analysis answers. */
export interface ScannerCapture {
  blob: Blob
  width: number
  height: number
}

export interface ScannerSearchQuery {
  name: string
  collectorNumber?: string
}

/** One confirmed line waiting in the in-memory scan batch. Deliberately photo-free: once a card
 *  is confirmed, its captured image is disposed (prompt §21) — the batch carries identity. */
export interface ScannedBatchCard {
  candidate: ScannerCandidate
  quantity: number
  condition: CardCondition
}

/** What the real acquisition call receives for each batch entry (P68 maps these onto the
 *  existing add-card acquisition path — no new financial semantics are invented on this seam). */
export interface ScannerCommitItem {
  candidateId: string
  quantity: number
  condition: CardCondition
}

export interface ScannerCommitResult {
  addedCount: number
}

/**
 * The narrow seam every scanner screen talks through. P68 replaces the placeholder adapter in
 * exactly one place; tests inject mocks of this interface.
 */
export interface ScannerUiController {
  analyzeCapture(frame: ScannerCapture): Promise<ScannerAnalysis>
  searchFallback(query: ScannerSearchQuery): Promise<ScannerCandidate[]>
  /** Commits the whole reviewed batch through the real acquisition path. Until P68 wires it,
   *  the placeholder adapter refuses honestly instead of pretending cards were added. */
  commitBatch(items: ScannerCommitItem[]): Promise<ScannerCommitResult>
}
