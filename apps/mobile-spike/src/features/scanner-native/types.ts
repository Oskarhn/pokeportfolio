import type { RankedScannerCandidate, ScannerConfidenceTier } from '@shared/domain/scanner/types'

/**
 * Native recognition confidence states (P182 mission's own state list). `engine.ts`'s
 * `ScannerConfidenceTier` ('high'|'medium'|'low'|'none') answers ONE question — given usable
 * signals, how well do they agree — and has no reason to know about anything upstream of that
 * (a photo too dark to read, a cancelled scan, a native runtime failure). Those are pipeline-level
 * outcomes wrapped AROUND an unchanged `engine.ts` call, never folded into it.
 */
export type RecognitionConfidenceState =
  'HIGH' | 'MEDIUM' | 'LOW' | 'NO_MATCH' | 'ABSTAIN_QUALITY' | 'ERROR' | 'CANCELLED'

export function confidenceStateFromTier(tier: ScannerConfidenceTier): RecognitionConfidenceState {
  switch (tier) {
    case 'high':
      return 'HIGH'
    case 'medium':
      return 'MEDIUM'
    case 'low':
      return 'LOW'
    case 'none':
      return 'NO_MATCH'
  }
}

/** One evidence line the confirmation screen can show in plain language — never a raw embedding
 *  distance or model-internal number (mission §15: "no embedding distances displayed to user"). */
export interface EvidenceSummaryLine {
  readonly code:
    | 'collector-number-matched'
    | 'name-matched'
    | 'set-matched'
    | 'visual-match'
    | 'visual-text-disagreement'
    | 'low-image-quality'
  readonly detail: string
}

export interface NativeRecognitionCandidate {
  readonly cardId: string
  readonly name: string
  readonly setName: string
  readonly collectorNumber: string
  readonly language: 'en' | 'ja'
  readonly imageBaseUrl: string | null
  /** 0-100 DISPLAY score, for internal ordering/debugging only — never rendered to the user as a
   *  "confidence percentage" (mission §12: "Do not expose meaningless raw model score as a
   *  consumer-facing confidence percentage"). The user-facing signal is `RecognitionConfidenceState`. */
  readonly debugScore: number
}

export interface NativeRecognitionResult {
  readonly state: RecognitionConfidenceState
  readonly candidates: readonly NativeRecognitionCandidate[]
  /** The candidate `engine.ts` itself ranked first, before any catalog-availability filtering —
   *  mirrors P151/P161's own `scannerBestId` contract: HIGH only vouches for this exact card. */
  readonly scannerBestId: string | null
  readonly evidence: readonly EvidenceSummaryLine[]
  readonly reasonIfNotOk?: string
}

export function toEvidenceSummary(candidate: RankedScannerCandidate): EvidenceSummaryLine[] {
  const lines: EvidenceSummaryLine[] = []
  if (candidate.reasons.includes('collector-number-exact')) {
    lines.push({
      code: 'collector-number-matched',
      detail: `Printed number matches "${candidate.card.localId}".`,
    })
  } else if (
    candidate.reasons.includes('collector-number-ocr-folded') ||
    candidate.reasons.includes('collector-number-numeric-only')
  ) {
    lines.push({
      code: 'collector-number-matched',
      detail: `Printed number closely matches "${candidate.card.localId}".`,
    })
  }
  if (candidate.reasons.includes('name-exact')) {
    lines.push({ code: 'name-matched', detail: `Card name matches "${candidate.card.name}".` })
  } else if (
    candidate.reasons.includes('name-close') ||
    candidate.reasons.includes('name-partial')
  ) {
    lines.push({
      code: 'name-matched',
      detail: `Card name closely matches "${candidate.card.name}".`,
    })
  }
  if (candidate.reasons.includes('set-exact') || candidate.reasons.includes('set-close')) {
    lines.push({ code: 'set-matched', detail: `Set matches "${candidate.card.setName}".` })
  }
  if (
    candidate.reasons.includes('visual-strong') ||
    candidate.reasons.includes('visual-moderate') ||
    candidate.reasons.includes('visual-anchor-corroborated')
  ) {
    lines.push({
      code: 'visual-match',
      detail: 'The card artwork visually matches this candidate.',
    })
  }
  return lines
}
