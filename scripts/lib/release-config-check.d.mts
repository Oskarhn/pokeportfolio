export const REQUIRED_SECRETS: readonly string[]
export const LEGACY_VARIABLES: readonly string[]
export interface ConfigFinding {
  name: string
  category: 'secret_missing' | 'legacy_variable_present'
}
export function evaluateReleaseConfig(present: {
  secrets: readonly string[]
  variables: readonly string[]
}): { ok: boolean; findings: ConfigFinding[] }
