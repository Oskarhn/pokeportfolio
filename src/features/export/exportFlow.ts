/**
 * The two-step export flow state machine (M13 integration, D-078) — pure, DOM-free, unit-tested.
 *
 * WHY two steps: `navigator.share()` must run inside a transient user activation. Generating an
 * export takes many database round trips, so a single "create then share" tap can lose that
 * activation before the sheet opens and throw NotAllowedError on installed iOS PWAs. The flow
 * therefore splits:
 *
 *   idle → preparing → ready → delivering → success | cancelled | delivery-error
 *                    ↘ prepare-failed
 *
 * Step 1 ("Create backup" / "Prepare CSV export") generates artifacts completely.
 * Step 2 ("Save / Share …") is a fresh tap whose handler calls the delivery path immediately
 * with the already-built files — fresh transient activation, every time.
 *
 * Artifacts live in component state ONLY (never localStorage/IndexedDB), are replaced on a new
 * generation and dropped on discard/unmount.
 */

import type { ExportArtifact, ExportKind } from './contract'
import type { DeliveryOutcome } from './fileDelivery'

/** A completed delivery — cancellation becomes its own state, never "success". */
export type CompletedDelivery = Exclude<DeliveryOutcome, { method: 'cancelled' }>

export type ExportFlowState =
  | { phase: 'idle' }
  | { phase: 'preparing'; kind: ExportKind }
  | { phase: 'ready'; kind: ExportArtifactKind; artifacts: readonly ExportArtifact[] }
  | { phase: 'delivering'; kind: ExportArtifactKind; artifacts: readonly ExportArtifact[] }
  | { phase: 'success'; kind: ExportArtifactKind; outcome: CompletedDelivery }
  | { phase: 'cancelled'; kind: ExportArtifactKind }
  /** Generation failed — artifacts absent; retry regenerates. */
  | { phase: 'prepare-failed'; kind: ExportKind; message: string }
  /** Delivery failed — artifacts RETAINED so the user can retry delivery or download instead. */
  | {
      phase: 'delivery-failed'
      kind: ExportArtifactKind
      artifacts: readonly ExportArtifact[]
      message: string
    }

/** Which user action generates artifacts. */
export type { ExportKind }

/**
 * A generated artifact set. After D-075 there are exactly two shapes: one backup JSON file, or
 * the ten-file CSV suite. The kind drives copy and delivery labels.
 */
export type ExportArtifactKind = ExportKind

export type ExportFlowEvent =
  | { type: 'PREPARE'; kind: ExportKind }
  | { type: 'PREPARED'; kind: ExportKind; artifacts: readonly ExportArtifact[] }
  | { type: 'PREPARE_FAILED'; kind: ExportKind; message: string }
  | { type: 'DELIVER' }
  | { type: 'DELIVERED'; outcome: DeliveryOutcome }
  | { type: 'DELIVERY_FAILED'; message: string }
  | { type: 'DISCARD' }

const KIND_LABELS = {
  csv: 'CSV export',
  backup: 'backup',
} as const

export function describeReady(kind: ExportArtifactKind): string {
  return KIND_LABELS[kind]
}

function sameKind(a: ExportKind, b: ExportKind): boolean {
  return a === b
}

export function reduceExportFlow(state: ExportFlowState, event: ExportFlowEvent): ExportFlowState {
  switch (event.type) {
    case 'PREPARE': {
      return { phase: 'preparing', kind: event.kind }
    }
    case 'PREPARED': {
      if (state.phase === 'preparing' && sameKind(state.kind, event.kind)) {
        return { phase: 'ready', kind: event.kind, artifacts: event.artifacts }
      }
      return state
    }
    case 'PREPARE_FAILED': {
      if (state.phase === 'preparing' && sameKind(state.kind, event.kind)) {
        return { phase: 'prepare-failed', kind: event.kind, message: event.message }
      }
      return state
    }
    case 'DELIVER': {
      // Valid from ready AND from a failed delivery (the "Try sharing again" /
      // "Download instead" actions reuse the retained artifacts).
      if (state.phase === 'ready' || state.phase === 'delivery-failed') {
        return { phase: 'delivering', kind: state.kind, artifacts: state.artifacts }
      }
      return state
    }
    case 'DELIVERED': {
      if (state.phase === 'delivering') {
        if (event.outcome.method === 'cancelled') {
          return { phase: 'cancelled', kind: state.kind }
        }
        return { phase: 'success', kind: state.kind, outcome: event.outcome }
      }
      return state
    }
    case 'DELIVERY_FAILED': {
      if (state.phase === 'delivering') {
        return {
          phase: 'delivery-failed',
          kind: state.kind,
          // Retained on purpose: retry delivery and Download instead both need the files,
          // and regeneration would repeat the fetch for nothing.
          artifacts: state.artifacts,
          message: event.message,
        }
      }
      return state
    }
    case 'DISCARD': {
      return { phase: 'idle' }
    }
  }
}
