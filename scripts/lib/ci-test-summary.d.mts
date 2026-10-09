export interface JUnitSuite {
  file: string
  seconds: number
  tests: number
  failures: number
  skipped: number
}
export interface PlaywrightSummary {
  files: Array<{ file: string; seconds: number }>
  flaky: Array<{ title: string; file: string; project: string; retries: number }>
  failed: number
  passed: number
  skipped: number
  flakyCount: number
}
export function parseJUnitSuites(xml: string): JUnitSuite[]
export function parsePlaywrightReport(report: unknown): PlaywrightSummary
export function renderSummary(
  input: {
    title: string
    vitest?: Array<{ label: string; suites: JUnitSuite[] }>
    playwright?: Array<{ label: string; report: PlaywrightSummary }>
  },
  top?: number,
): string
