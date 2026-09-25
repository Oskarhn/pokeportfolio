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
 * THE NATIVE APP HAS NO RECOGNIZER. The web scanner (OCR + visual index in a worker, M15) does not
 * run in React Native, and none has been ported. The only implementation here is therefore
 * {@link NATIVE_RECOGNITION_UNAVAILABLE}, which answers `not_available` for every photo, and the UI
 * routes the person to manual search. `not_available` is deliberately a different state from a
 * scanner's `no_match`: "we could not match this photo" would be a false claim.
 */

export interface RecognitionAnalysis {
  readonly confidence: ScanConfidence
  readonly candidates: readonly ScanCandidate[]
  readonly scannerBestId?: string | null
}

export type RecognitionOutcome =
  | { readonly status: 'not_available'; readonly reason: 'no_native_recognizer' }
  | { readonly status: 'analysed'; readonly outcome: ScanOutcome }

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
