export interface VerifierResult {
  readonly pass: boolean
  readonly skipped?: boolean
  readonly [key: string]: unknown
}

export interface VerifierSummary {
  readonly total: number
  readonly meaningfulCount: number
  readonly skippedCount: number
  readonly passedCount: number
  readonly failed: VerifierResult[]
  readonly ranNothing: boolean
  readonly ok: boolean
}

export function summarizeResults(results: readonly VerifierResult[]): VerifierSummary

export function reportAndExit(
  results: readonly VerifierResult[],
  options?: {
    readonly log?: (message: string) => void
    readonly exit?: (code: number) => void
  },
): VerifierSummary
