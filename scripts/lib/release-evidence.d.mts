export const REQUIRED_CHECKS: string[]
export function isFullSha(value: unknown): boolean
export const STATUSES: string[]
export interface LocalGateDefinition {
  label: string
  args: string[]
  required: boolean
  env?: Record<string, string>
}
export const LOCAL_GATES: Record<string, LocalGateDefinition>
export function redact(text: string): string
export function tailRedacted(output: string, lines?: number): string
export interface CiCheckResult {
  name: string
  status: string
  detail: string
}
export function classifyCiChecks(
  checkRuns:
    | ReadonlyArray<{ id?: number; name?: string; status?: string; conclusion?: string | null }>
    | null
    | undefined,
  required?: string[],
): CiCheckResult[]
export function decideVerdict(
  items: ReadonlyArray<{ name: string; required: boolean; status: string }>,
  subject: { shaIsFull: boolean; clean: boolean; headMatches: boolean },
): { verdict: 'READY' | 'INCOMPLETE' | 'FAILED'; reasons: string[] }
export function scanSkipSites(files: ReadonlyArray<{ path: string; source: string }>): {
  total: number
  byFile: Array<{ path: string; count: number }>
}
export interface LocalGateResult {
  key: string
  label: string
  required: boolean
  status: string
  seconds?: number
  detail: string
  tail?: string
}
export interface KnownGap {
  id: string
  summary: string
  source: string
  asOf: string
}
export interface EvidenceReport {
  sha: string
  branch: string
  clean: boolean
  generatedAt: string
  node: string
  verdict: string
  reasons: string[]
  localGates: LocalGateResult[]
  ci: CiCheckResult[]
  knownGaps: KnownGap[]
  skipSites: { total: number; byFile: Array<{ path: string; count: number }> }
}
export function renderMarkdown(report: EvidenceReport): string
