/**
 * Pure evaluation of the repository's release configuration by NAME only (P163).
 *
 * The CI Production deploy job reads its public build values from four repository secrets and reads
 * no Actions variable at all. Two things can therefore be wrong on the GitHub side, and both are
 * visible from names alone — no value is ever needed, read or printed:
 *   - a required secret does not exist yet (the job would fail at its first guard), or
 *   - one of the legacy `VITE_*` variables still exists. The workflow does not read it, but the
 *     variable held a secret-shaped value in the P159/P160 incident and variables are readable and
 *     printable; leaving it in place leaves the exposure in place.
 *
 * What names cannot establish: that a secret holds the RIGHT value. The deploy job's first guard
 * judges the shape at run time; only the owner's dashboards establish rotation and correctness.
 */

/** Repository secrets the deploy job needs (the build values are public, stored as secrets for masking). */
export const REQUIRED_SECRETS = Object.freeze([
  'PRODUCTION_SUPABASE_URL',
  'PRODUCTION_SUPABASE_PUBLISHABLE_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
])

/** Actions variables that must not exist any more (superseded by the secrets above). */
export const LEGACY_VARIABLES = Object.freeze([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
])

/** @typedef {{ name: string, category: 'secret_missing' | 'legacy_variable_present' }} ConfigFinding */

/**
 * @param {{ secrets: readonly string[], variables: readonly string[] }} present names only
 * @returns {{ ok: boolean, findings: ConfigFinding[] }}
 */
export function evaluateReleaseConfig(present) {
  const secrets = new Set(present.secrets)
  const variables = new Set(present.variables)
  /** @type {ConfigFinding[]} */
  const findings = []
  for (const name of REQUIRED_SECRETS) {
    if (!secrets.has(name)) findings.push({ name, category: 'secret_missing' })
  }
  for (const name of LEGACY_VARIABLES) {
    if (variables.has(name)) findings.push({ name, category: 'legacy_variable_present' })
  }
  return { ok: findings.length === 0, findings }
}
