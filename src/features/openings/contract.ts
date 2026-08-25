/**
 * The boundary between M16's opening UI (this feature) and the opening backend (P50's
 * `src/domain/opening/**` + `src/data/opening/**`, wired by the P53 integration session).
 *
 * The UI knows nothing about Supabase, RPC names or serialization — it calls an
 * {@link OpeningController} and renders whatever typed answer comes back. This file is
 * deliberately feature-local: nothing in src/data imports it, and the integrator replaces
 * `controller.ts` next door in exactly one place (the same seam shape M13's export feature used).
 *
 * Financial honesty is baked into these types, not policed by components:
 *   - money is integer NOK minor units, never float;
 *   - `null` cost means "not recorded" and must render as such — never as 0;
 *   - `undefined` on the optional result fields means "the backend adapter does not provide this
 *     yet" (P53 may add it) — distinct from `null`, which means "genuinely unavailable"
 *     (FINANCIAL_MODEL.md §5.3: return/ROI are undefined when cost is unknown).
 */

/** One sealed acquisition lot that can still be opened. Built from the lot's frozen facts only —
 *  the UI never recomputes a cost it was not given. */
export interface OpeningSource {
  lotId: string
  holdingId: string
  productId: string | null
  productName: string
  productTypeName?: string | null
  setName?: string | null
  imageUrl?: string | null
  /** Units still open on this lot (D1 invariant). The wizard clamps against this. */
  quantityAvailable: number
  acquiredOn: string
  /** True exactly when the lot carries a known, frozen unit cost the opening can inherit. */
  costKnown: boolean
  /** Per-unit NOK basis when costKnown; null/absent otherwise — never zero to mean free. */
  unitCostNokMinor?: bigint | null
}

/** A card pulled from the opening, as captured by the wizard before anything is saved. */
export interface OpeningPullInput {
  cardVariantId?: string
  manualCardId?: string
  condition?: string
  quantity: number
}

export type TrackingCompleteness = 'all_cards' | 'selected_pulls' | 'unknown'

export interface CreateOpeningInput {
  /** Client-generated key so a retried submission can never record the same opening twice. */
  idempotencyKey: string
  sourceLotId: string
  quantity: number
  /** ISO date (yyyy-mm-dd). May be backdated; the backend remains authoritative. */
  openedOn: string
  pulls: OpeningPullInput[]
  trackingCompleteness: TrackingCompleteness
  /** Optional estimate for untracked leftovers — an estimate, never a cost-basis figure.
   *  Sent together with bulkRemainderCount or not at all (both-or-neither, DATA_MODEL §5.8). */
  bulkRemainderEstimateMinor?: bigint
  bulkRemainderCount?: number
  notes?: string
}

export interface CreatedOpening {
  openingId: string
}

export interface OpeningPullLine {
  lotId: string
  displayName: string
  subtitle?: string | null
  imageUrl?: string | null
  quantity: number
  quantityRemaining?: number | null
  /** Current resolved value of what is still held — undefined until the adapter provides it,
   *  null when genuinely unpriced (never fabricated to 0). */
  currentValueNokMinor?: bigint | null
  /** Net proceeds if (part of) this pull has been sold — same undefined/null split. */
  soldProceedsNokMinor?: bigint | null
}

export interface OpeningDetail {
  openingId: string
  productName: string
  openedOn: string
  quantityOpened: number
  /** False means no purchase cost is recorded for this opening — display "not recorded", never 0. */
  costKnown: boolean
  /** Total opening cost in NOK minor units; null exactly when costKnown is false. */
  costNokMinor: bigint | null
  /** D-021 provisional-cost marker ("entered manually — not linked to a purchase"), when the
   *  adapter exposes provenance. */
  costProvisional?: boolean | undefined
  trackingCompleteness: TrackingCompleteness
  bulkRemainderEstimateMinor: bigint | null
  bulkRemainderCount: number | null
  pulls: OpeningPullLine[]
  /** Σ current value of retained tracked pulls — optional until P53 wires the result query. */
  retainedTrackedValueNokMinor?: bigint | null
  /** Σ net proceeds from sold pulls of this opening — same optionality. */
  soldPullProceedsNokMinor?: bigint | null
  /**
   * FINANCIAL_MODEL §5.3's opening return:
   *   retained + sold proceeds + bulk estimate − opening cost.
   * `undefined` = adapter cannot compute it yet (P53); `null` = genuinely unavailable because the
   * opening cost is unknown. Never 0-based, never fabricated.
   */
  resultNokMinor?: bigint | null
  voidedAt?: string | null
}

/** Outcome of asking to void/correct an opening. Blocking logic lives entirely in the backend:
 *  the client shows `blockedReason` verbatim and offers no workaround (prompt §19). */
export interface VoidOpeningOutcome {
  blocked: boolean
  blockedReason?: string | null
}

/**
 * The narrow seam every opening screen talks through. P53 replaces the stub implementation;
 * tests inject mocks of this interface (no production DB dependency anywhere in the feature).
 */
export interface OpeningController {
  /** Sealed lots with remaining units, newest-provenance information included. When
   *  `filter.holdingId` is given, only lots of that holding come back (Holding Detail entry). */
  getEligibleSealedSources(filter?: { holdingId?: string }): Promise<OpeningSource[]>
  createOpening(input: CreateOpeningInput): Promise<CreatedOpening>
  getOpening(openingId: string): Promise<OpeningDetail>
  voidOpening(openingId: string, reason?: string): Promise<VoidOpeningOutcome>
}
