/**
 * Independent M16 economic oracle.
 *
 * Written implementation-blind from FINANCIAL_MODEL.md (§4.3, §5, §8 E4/E5/E13),
 * DATA_MODEL.md (§5.6/§5.7/§5.8), DECISIONS.md (D-002, D-021, D-060) and the P52
 * adversarial brief — deliberately WITHOUT deriving anything from implementation
 * SQL. Where this file and an implementation disagree, one of them is wrong and
 * the disagreement is a finding, never something to reconcile silently.
 *
 * Everything here is pure arithmetic on integer minor units. No float anywhere.
 */

/** A known-basis acquisition lot reduced to the figures the residual rule needs. */
export interface KnownLot {
  /** Original lot quantity (the divisor the per-unit basis was floored against). */
  readonly quantity: number
  /** Frozen NOK attributable cost of the whole lot (`attributable_cost_nok_minor`). */
  readonly attributableCostNokMinor: number
}

/** Per-unit floor division + leftover residual, per FINANCIAL_MODEL §4.3 / D-060. */
export function unitBasisAndResidual(lot: KnownLot): { unit: number; residual: number } {
  if (!Number.isInteger(lot.quantity) || lot.quantity <= 0) {
    throw new Error(`invalid lot quantity: ${lot.quantity}`)
  }
  if (!Number.isInteger(lot.attributableCostNokMinor) || lot.attributableCostNokMinor < 0) {
    throw new Error(`invalid attributable cost: ${lot.attributableCostNokMinor}`)
  }
  const unit = Math.floor(lot.attributableCostNokMinor / lot.quantity)
  const residual = lot.attributableCostNokMinor - unit * lot.quantity
  return { unit, residual }
}

/**
 * Expected frozen cost of each sequential disposal of a known-basis lot
 * (DATA_MODEL §5.7 residual-consumption rule, restated independently):
 *
 *   basis_i = unit × q_i + residual   -- residual only on the disposal that
 *                                      -- reduces quantity_remaining to exactly 0
 *
 * The residual is consumed EXACTLY ONCE per lot lifetime: quantity_remaining
 * reaches zero monotonically at most once, so Σ basis over ALL disposals equals
 * the lot's attributable cost exactly, whatever the split.
 */
export function expectedFrozenCosts(
  lot: KnownLot,
  disposalQuantities: readonly number[],
): number[] {
  const { unit, residual } = unitBasisAndResidual(lot)
  let remainingBefore = lot.quantity
  const frozen: number[] = []
  for (const q of disposalQuantities) {
    if (!Number.isInteger(q) || q <= 0) {
      throw new Error(`invalid disposal quantity: ${q}`)
    }
    if (q > remainingBefore) {
      throw new Error(
        `disposal of ${q} exceeds remaining ${remainingBefore} — over-open must be impossible`,
      )
    }
    const exhausts = remainingBefore - q === 0
    frozen.push(unit * q + (exhausts ? residual : 0))
    remainingBefore -= q
  }
  return frozen
}

/**
 * Same rule extended with lot_cost_adjustments (DATA_MODEL §5.6): adjustments
 * floor-divide per unit against the ORIGINAL quantity, and the adjustment
 * residual joins the lot's own residual on the exhausting disposal only.
 */
export function expectedFrozenCostsWithAdjustments(
  lot: KnownLot,
  adjustmentsTotalNokMinor: number,
  disposalQuantities: readonly number[],
): number[] {
  const { unit, residual } = unitBasisAndResidual(lot)
  const adjPerUnit = Math.floor(adjustmentsTotalNokMinor / lot.quantity)
  const adjResidual = adjustmentsTotalNokMinor - adjPerUnit * lot.quantity
  let remainingBefore = lot.quantity
  const frozen: number[] = []
  for (const q of disposalQuantities) {
    if (!Number.isInteger(q) || q <= 0 || q > remainingBefore) {
      throw new Error(`invalid disposal quantity: ${q}`)
    }
    const exhausts = remainingBefore - q === 0
    frozen.push((unit + adjPerUnit) * q + (exhausts ? residual + adjResidual : 0))
    remainingBefore -= q
  }
  return frozen
}

/**
 * §4 RESIDUAL ORACLE — the exact hard-coded case the contract fixes:
 * 3 sealed units, total attributable basis 29995 øre → unit 9998, residual +1.
 * Opening 2 first freezes 19996; the final 1 exhausts and takes 9999 (unit+residual).
 * Sum: 29995 exactly. The listed values are WRONG answers this suite must reject.
 */
export const RESIDUAL_ORACLE_CASE = {
  lot: { quantity: 3, attributableCostNokMinor: 29995 },
  unitCostBasisNokMinor: 9998,
  residualNokMinor: 1,
  openTwoFirst_firstOpeningFrozen: 19996,
  openTwoFirst_finalOpeningFrozen: 9999,
  combinedTotalNokMinor: 29995,
  /** Values that indicate a broken residual rule, in the open-2-first order. */
  rejectedFrozenValues: [19995, 19997, 19966, 29994, 29996],
} as const

// ---------------------------------------------------------------------------
// Opening result — FINANCIAL_MODEL §5.3, verbatim semantics
// ---------------------------------------------------------------------------

export interface OpeningResultInputs {
  /** Current NOK value of tracked pulls still held (unpriced excluded, counted elsewhere). */
  readonly retainedTrackedValueNokMinor: number
  /** Σ sale-line net proceeds whose lot carries this opening_id. */
  readonly netProceedsFromSoldPullsNokMinor: number
  /** User estimate; null when not supplied. Never conflated with an explicit 0. */
  readonly bulkRemainderEstimateNokMinor: number | null
  /** Opening cost; null iff cost_source = 'unknown' (M1: NULL ≠ 0). */
  readonly openingCostNokMinor: number | null
}

/**
 * opening_return = retained + sold proceeds + bulk estimate (0 if absent) − opening cost.
 * Undefined (null) whenever the opening cost is undefined — never fabricated from a zero.
 */
export function openingReturnNokMinor(inputs: OpeningResultInputs): number | null {
  if (inputs.openingCostNokMinor === null) return null
  const bulk = inputs.bulkRemainderEstimateNokMinor ?? 0
  return (
    inputs.retainedTrackedValueNokMinor +
    inputs.netProceedsFromSoldPullsNokMinor +
    bulk -
    inputs.openingCostNokMinor
  )
}

/** ROI is undefined without a cost; otherwise exact ratio in percent (read-time figure). */
export function openingRoiPercent(
  openingReturnNokMinorValue: number | null,
  openingCostNokMinor: number | null,
): number | null {
  if (openingReturnNokMinorValue === null || openingCostNokMinor === null) return null
  if (openingCostNokMinor === 0) return null
  return (openingReturnNokMinorValue / openingCostNokMinor) * 100
}

/** TTEP = CMV + NSP − CS (FINANCIAL_MODEL §2.6). Portfolio scope, canonical ledger inputs. */
export function ttepNokMinor(cmvNokMinor: number, nspNokMinor: number, csNokMinor: number): number {
  return cmvNokMinor + nspNokMinor - csNokMinor
}

/**
 * F8 DOUBLE-COUNT CONSTRUCTION (§19 of the brief).
 *
 * A user whose entire activity is ONE opening: buy an ETB for 799.00, open it,
 * keep pulls worth 500.00, sell one pull for 45.00 net. At portfolio scope:
 *
 *   TTEP           = CMV + NSP − CS = 50000 + 4500 − 79900 = −25400
 *   opening_return = 50000 + 4500 + 0 − 79900          = −25400
 *
 * The two figures COINCIDE only because this opening is the user's whole
 * portfolio — they are different scopes over the SAME kroner. Adding them
 * counts the purchase money twice. Nothing may ever display their sum.
 */
export const F8_DOUBLE_COUNT_CASE = {
  cmvNokMinor: 50_000,
  nspNokMinor: 4_500,
  csNokMinor: 79_900,
  openingCostNokMinor: 79_900,
  retainedTrackedValueNokMinor: 50_000,
  netProceedsFromSoldPullsNokMinor: 4_500,
  bulkRemainderEstimateNokMinor: null,
  expectedTtepNokMinor: -25_400,
  expectedOpeningReturnNokMinor: -25_400,
} as const

// ---------------------------------------------------------------------------
// Tracking completeness, estimates, unknown cost — the honesty surface
// ---------------------------------------------------------------------------

export const TRACKING_COMPLETENESS_VALUES = ['all_cards', 'selected_pulls', 'unknown'] as const

export type TrackingCompleteness = (typeof TRACKING_COMPLETENESS_VALUES)[number]

/** Copy mandated by FINANCIAL_MODEL §5.3 for every incomplete-tracking return. */
export const INCOMPLETE_TRACKING_MARKER_COPY = 'Tracked pulls only — actual return is higher.'

/** Any completeness other than all_cards must render the marker. No exceptions. */
export function requiresIncompletenessMarker(completeness: TrackingCompleteness): boolean {
  return completeness !== 'all_cards'
}

/**
 * §9 BULK ESTIMATE — NULL and zero are distinct facts:
 *   null = "not supplied"; 0 = "explicit zero estimate".
 * Arithmetically both add 0 to the return; semantically only the explicit zero
 * may be displayed as a supplied estimate, and neither may ever touch holding
 * value, CMV, GPO or CS.
 */
export const BULK_ESTIMATE_DISTINCTION = {
  notSupplied: null,
  explicitZero: 0,
} as const

/** Both-or-neither presence of the remainder pair (the "supplied" fact itself). */
export function isEstimateSupplied(
  estimateNokMinor: number | null,
  estimateCount: number | null,
): boolean {
  return estimateNokMinor !== null && estimateCount !== null
}

/**
 * The full remainder shape DATA_MODEL §5.8 constrains: either both columns are
 * NULL (not supplied), or they form a real pair with estimate ≥ 0 AND count > 0.
 * A zero-value estimate is legal ONLY alongside a positive count.
 */
export function isValidRemainderShape(
  estimateNokMinor: number | null,
  estimateCount: number | null,
): boolean {
  const bothNull = estimateNokMinor === null && estimateCount === null
  const validPair =
    estimateNokMinor !== null &&
    estimateCount !== null &&
    Number.isInteger(estimateNokMinor) &&
    estimateNokMinor >= 0 &&
    estimateCount > 0
  return bothNull || validPair
}

// ---------------------------------------------------------------------------
// Cross-milestone integration obligations (§17/§18) — executable notes for P53
// ---------------------------------------------------------------------------

/**
 * M16 introduces NEW canonical user data, so the shipped backup format (v1,
 * D-076) cannot remain lossless. The M16 RELEASE must ship schema_version ≥ 2
 * carrying openings, their consumption rows and pull-lot linkage. A v1 backup
 * generated after M16 that silently omits openings is a BLOCKER, not a nit.
 */
export const BACKUP_MIN_SCHEMA_VERSION_AFTER_M16 = 2

/**
 * §18 — the two integration paths P53 must handle together. Neither may be
 * forgotten: reset clears openings (hard-delete exception, D-084 position in
 * the deletion order) AND backup v2 exports them (losslessness).
 */
export const P53_INTEGRATION_OBLIGATIONS = [
  'reset_my_portfolio_data removes openings, opening disposals and pull lots',
  'backup export bumps to schema_version 2 and serializes opening canonical data',
] as const

/**
 * §10 — the current schema has NO audit_events table (DATA_MODEL §7 status
 * correction). An M16 implementation that introduces a generic audit_events
 * table solely to satisfy reconciliation auditing is a scope/architecture
 * issue and must be flagged, not absorbed.
 */
export const AUDIT_EVENTS_TABLE_STATUS = 'must-not-exist-on-current-schema' as const
