import type { ScannerImageInput } from '../../photo/photo-store'
import {
  interpretScan,
  type ScanCandidate,
  type ScanConfidence,
  type ScanOutcome,
} from './p165-domain/price-check/scan'

/**
 * The seam between a native photo and Price Check. A photo is NOT an identification: only a
 * recognizer can propose card identities, and even then it never chooses a variant or a price
 * (P165 `interpretScan`, vendored unchanged: HIGH pre-selects but still needs confirmation,
 * MEDIUM/LOW need a choice, NO_MATCH falls back to manual search).
 *
 * P182: a real native recognizer exists (`../scanner-native/recognition-pipeline.ts`, on-device
 * OCR + visual embedding/search over the same pinned model and index the web scanner uses,
 * fused by the SAME `engine.ts` this app already vendors nothing new from). Four outcomes beyond
 * `analysed` exist because a native pipeline has failure/skip modes a stub never needed to model:
 * `cancelled` (a newer photo superseded this analysis — latest-capture-wins), `error` (OCR/model/
 * index failed to run at all), `abstain_quality` (the photo itself was refused before any
 * expensive inference — too large, too small, wrong shape), and `not_available` is KEPT for
 * {@link NATIVE_RECOGNITION_UNAVAILABLE}, the pre-P182 default a caller gets if no recognizer is
 * injected (still the DI default below — see `../feature.ts`).
 */

export interface RecognitionAnalysis {
  readonly confidence: ScanConfidence
  readonly candidates: readonly ScanCandidate[]
  readonly scannerBestId?: string | null
}

export type RecognitionOutcome =
  | { readonly status: 'not_available'; readonly reason: 'no_native_recognizer' }
  | { readonly status: 'analysed'; readonly outcome: ScanOutcome }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly reason: string }
  | { readonly status: 'abstain_quality'; readonly reason: string }

export interface CardRecognitionPort {
  /** False until a real native recognizer exists and has been proven on a device. */
  readonly implemented: boolean
  recognize(input: ScannerImageInput): Promise<RecognitionOutcome>
}

export const NATIVE_RECOGNITION_UNAVAILABLE: CardRecognitionPort = {
  implemented: false,
  recognize: () => Promise.resolve({ status: 'not_available', reason: 'no_native_recognizer' }),
}

/** How a FUTURE recognizer's analysis is turned into a Price Check outcome (P165 rules). */
export function toRecognitionOutcome(analysis: RecognitionAnalysis): RecognitionOutcome {
  return { status: 'analysed', outcome: interpretScan(analysis) }
}
