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

/** One sealed acquisition lot that can still be opened. Carries its ALREADY-DERIVED cost
 *  components (server-derived by `list_opening_sources`, P53 §7) — the UI never recomputes a
 *  cost it was not given, and never re-implements the consumption arithmetic. */
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
  /** True exactly when the lot carries a known, frozen basis the opening can inherit.
   *  False ⇒ both components below are null and the preview is "not recorded" — never 0. */
  costKnown: boolean
  /** Derived per-unit basis: unit_cost_basis_nok + floor(Σ adjustments / original quantity).
   *  Null together with exhaustionResidualNokMinor when costKnown is false. */
  effectiveUnitBasisNokMinor?: bigint | null
  /** Lot residual + adjustment remainder — added exactly once, by the opening that exhausts
   *  the lot (FINANCIAL_MODEL §4.3). Preview arithmetic lives in src/domain/opening. */
  exhaustionResidualNokMinor?: bigint | null
  /** Owner-only parent-purchase provenance (P59): lets the reconciliation picker mirror the
   *  server's own target rule client-side (parent live, origin ≠ 'provisional_opening'). Null
   *  for lots with no purchase line. The server stays authoritative on legitimacy. */
  purchaseId?: string | null
  purchaseOrigin?: string | null
  purchasedOn?: string | null
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

/** Buy-and-open (P53 §11): "I bought these packs and opened them now." One wizard mode that
 *  collects the sealed product, the RECEIPT TOTAL paid (never a per-unit price), the purchase
 *  and opening dates, the pulls, the tracking completeness and the optional bulk estimate. The
 *  backend creates exactly ONE real provisional purchase + ONE opening, atomically, with the
 *  total preserved øre-exact (D-090). */
export interface BoughtAndOpenedInput {
  /** Client-generated submission identity — server-enforced idempotency (P53 §5). A retried
   *  request can never create a second purchase. */
  idempotencyKey: string
  sealedProductId: string
  quantity: number
  /** The exact total paid, integer NOK minor units. */
  totalPaidNokMinor: bigint
  /** ISO date (yyyy-mm-dd) of the purchase; may be backdated. */
  purchasedOn: string
  /** ISO date of the opening; defaults server-side to the purchase date when omitted. */
  openedOn?: string
  pulls: OpeningPullInput[]
  trackingCompleteness: TrackingCompleteness
  bulkRemainderEstimateMinor?: bigint
  bulkRemainderCount?: number
  notes?: string
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
  /** The sealed product this opening consumed — lets the reconciliation picker match targets of
   *  exactly the same product (the server re-verifies everything it refuses). */
  sealedProductId: string
  /** The lot the opening currently consumes — excluded from its own reconciliation targets. */
  sourceLotId: string
  productName: string
  openedOn: string
  quantityOpened: number
  /** False means no purchase cost is recorded for this opening — display "not recorded", never 0. */
  costKnown: boolean
  /** Total opening cost in NOK minor units; null exactly when costKnown is false. */
  costNokMinor: bigint | null
  /** True while the opening still cites its own provisional buy-and-open purchase and has not
   *  been reconciled; undefined once reconciled or when there is nothing provisional. */
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
  /** Coverage counts from get_opening (P56 retained-only semantics, exposed P59):
   *  priced/unpriced describe CURRENT RETAINED pull lots; sold is the separate historical
   *  provenance. Undefined only if the adapter cannot provide them yet. */
  pricedPullLotCount?: number
  unpricedPullLotCount?: number
  soldPullLotCount?: number
  /** Reconciliation provenance: set together once by reconcile_opening_cost. */
  reconciledAt?: string | null
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
  /** Sealed lots with remaining units, derived preview components included. When
   *  `filter.holdingId` is given, only lots of that holding come back (Holding Detail entry). */
  getEligibleSealedSources(filter?: { holdingId?: string }): Promise<OpeningSource[]>
  createOpening(input: CreateOpeningInput): Promise<CreatedOpening>
  /** Buy-and-open path (P53 §11): one purchase + one opening, atomically. */
  createBoughtAndOpened(input: BoughtAndOpenedInput): Promise<CreatedOpening>
  getOpening(openingId: string): Promise<OpeningDetail>
  voidOpening(openingId: string, reason?: string): Promise<VoidOpeningOutcome>
  /** Links a provisionally-costed opening to the real receipt's lot (FINANCIAL_MODEL §5.5).
   *  The server owns every legitimacy rule; the picker that chooses `realSourceLotId` only
   *  mirrors them for usability. */
  reconcileOpeningCost(openingId: string, realSourceLotId: string): Promise<CreatedOpening>
}
