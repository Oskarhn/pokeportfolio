import type { CardCondition } from '../../data/collection'
import type { PixelRect } from './guide-geometry'

/**
 * The boundary between M15's scanner UI (P66) and everything that makes scanning actually work —
 * the capture-analysis engine, the candidate search and the canonical acquisition path (P65/P67/
 * P68). The same one-place-replacement shape M13's export feature and M16's opening wizard used:
 *
 *   - The UI knows nothing about Supabase, RPC names, OCR or inference runtimes. It calls an
 *     {@link ScannerUiController} and renders whatever typed answer comes back.
 *   - `controller.ts` next door is the only file an integrator replaces; nothing in src/data or
 *     src/domain imports this module.
 *   - The integrated adapter wires the on-device Tesseract OCR engine (P68) to P67's deterministic
 *     matcher and the existing acquisition path.
 *
 * Honesty rules baked into these types:
 *   - Confidence is a coarse band supplied by the domain, never a percentage fabricated in the UI.
 *   - An absent match is NO_MATCH, never an empty-string name or a zeroed placeholder card.
 *   - A batch item stores card IDENTITY plus variant/quantity/condition — never the captured photo.
 *   - Commit results report what ACTUALLY happened per item; an interrupted request is reported
 *     as needing verification, never assumed added or assumed failed.
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
  /** Identity-level display facts come from the candidate; they are confirmed, not edited. */
  finishLabel?: string | null
  languageLabel?: string | null
}

export interface ScannerAnalysis {
  confidence: ScannerConfidence
  /** Ordered best-first. Empty exactly when confidence is NO_MATCH. Bounded to a short useful
   *  shortlist (the integrated controller caps at 5 — prompt §20). */
  candidates: ScannerCandidate[]
}

/** The bounded still frame handed to the engine — an in-memory JPEG blob plus pixel dimensions
 *  and the pixel rectangle of the physical card inside the frame (prompt §10). Nothing here is
 *  persisted anywhere; ownership passes to the callee for the duration of the call only, and the
 *  UI disposes it as soon as analysis answers. */
export interface ScannerCapture {
  blob: Blob
  width: number
  height: number
  /** Physical-card rectangle in THIS frame's pixel space. Always present — recognition must
   *  never guess geometry. */
  cardRect: PixelRect
}

export interface ScannerSearchQuery {
  name: string
  collectorNumber?: string
}

/** One selectable printing of an identified card (prompt §22): recognition resolves cards.id;
 *  the financial identity is a card_variants.id chosen from the card's ACTIVE variants using
 *  their actual attributes — never inferred from the photo. */
export interface ScannerVariantChoice {
  id: string
  label: string
}

/** One confirmed line waiting in the in-memory scan batch. Deliberately photo-free: once a card
 *  is confirmed, its captured image is disposed (prompt §21) — the batch carries identity. */
export interface ScannedBatchCard {
  candidate: ScannerCandidate
  /** The canonical card_variants.id selected at confirmation — REQUIRED before any save. */
  variantId: string
  variantLabel: string
  quantity: number
  condition: CardCondition
  /** Stable per-item idempotency key (D-096). Generated ONCE when the logical card enters the
   *  batch; survives editing condition/quantity, partial save retry, transport retry. Changes
   *  only if the user removes the item and scans/adds a new one. */
  requestKey: string
  /** Set when a previous commit attempt left this item's server outcome UNKNOWN (interrupted
   *  transport): shown prominently; never auto-retried (prompt §30). */
  needsVerification?: boolean
}

/** What the real acquisition call receives for each batch entry (mapped onto the existing
 *  add-card acquisition path — no new financial semantics are invented on this seam). */
export interface ScannerCommitItem {
  candidateId: string
  variantId: string
  quantity: number
  condition: CardCondition
  /** Client-generated idempotency key for server-side retry deduplication (D-096). */
  requestKey: string
}

/** Outcome of ONE item's commit attempt (prompt §29/§30/§31). */
export type ScannerCommitOutcomeStatus =
  /** The RPC answered successfully — the holding exists. Never resubmitted on retry. */
  | 'added'
  /** The server definitively rejected it (validation/constraint). Retryable after editing. */
  | 'failed'
  /** The connection broke before an answer: the card MAY already be saved. Marked for manual
   *  verification against the Portfolio; deliberately NOT auto-retried. */
  | 'needs_verification'

export interface ScannerCommitOutcome {
  index: number
  status: ScannerCommitOutcomeStatus
  message: string | null
}

export interface ScannerCommitResult {
  addedCount: number
  /** Per-input-item outcomes, aligned by index with the commitBatch call's items array. */
  outcomes: ScannerCommitOutcome[]
}

/**
 * The narrow seam every scanner screen talks through. The integrated adapter implements all of
 * it against the real engine/catalog/acquisition paths; tests inject mocks of this interface.
 */
export interface ScannerUiController {
  analyzeCapture(frame: ScannerCapture): Promise<ScannerAnalysis>
  searchFallback(query: ScannerSearchQuery): Promise<ScannerCandidate[]>
  /** Active printing choices for an identified card (fetched ONLY after the user picks the
   *  candidate — prompt §22/I6). Empty means the card has no active variant to add. */
  listVariantChoices(cardId: string): Promise<ScannerVariantChoice[]>
  /** Commits the whole reviewed batch through the real acquisition path. Nothing is written by
   *  anything else in the scanner. Per-item isolation: one failure never aborts the rest. */
  commitBatch(items: ScannerCommitItem[]): Promise<ScannerCommitResult>
  /** Releases the session's OCR worker and any retained engine resources. Called reliably on
   *  route exit/unmount (prompt §8/I16). Idempotent. */
  dispose(): void
}
