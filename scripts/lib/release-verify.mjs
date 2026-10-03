/**
 * Pure checks for the manual Production release (P193). `.github/workflows/deploy-production.yml`
 * deploys one explicitly named commit, and only after proving three things about it: it is a full
 * 40-hex SHA that exists, it is reachable from `main`, and the required CI jobs succeeded on exactly
 * that SHA. The I/O (git, GitHub API) lives in scripts/release-guard.mjs `verify-release-sha`; the
 * decisions live here so they are unit-testable (tests/config/release-verify.test.ts).
 */

/** The CI jobs whose success on the exact SHA is required before Production. */
export const REQUIRED_CHECKS = ['build-and-test', 'db-tests', 'native-checks']

/** @param {unknown} value @returns {boolean} true only for a full lowercase 40-hex commit SHA */
export function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

/**
 * @param {Array<{id?: number, name?: string, status?: string, conclusion?: string|null}>} checkRuns
 *   the `check_runs` array GitHub returns for a commit
 * @param {string[]} required check names that must be green
 * @returns {{ok: boolean, missing: string[], notGreen: string[]}}
 *   A name is green only when its NEWEST run (highest id, so a re-run supersedes an earlier failure
 *   and a later failure supersedes an earlier success) is completed with conclusion `success`.
 *   `skipped`, `neutral`, `cancelled`, in-progress and absent all count as not green.
 */
export function evaluateRequiredChecks(checkRuns, required = REQUIRED_CHECKS) {
  const runs = Array.isArray(checkRuns) ? checkRuns : []
  const missing = []
  const notGreen = []
  for (const name of required) {
    const named = runs.filter((r) => r && r.name === name)
    if (named.length === 0) {
      missing.push(name)
      continue
    }
    const newest = named.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a))
    if (newest.status !== 'completed' || newest.conclusion !== 'success') notGreen.push(name)
  }
  return { ok: missing.length === 0 && notGreen.length === 0, missing, notGreen }
}
