export const REQUIRED_CHECKS: string[]
export function isFullSha(value: unknown): boolean
export function evaluateRequiredChecks(
  checkRuns:
    | ReadonlyArray<{
        id?: number
        name?: string
        status?: string
        conclusion?: string | null
      }>
    | undefined,
  required?: string[],
): { ok: boolean; missing: string[]; notGreen: string[] }
