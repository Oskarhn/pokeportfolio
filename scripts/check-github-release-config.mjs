#!/usr/bin/env node
/**
 * Read-only, NAMES-ONLY check of the repository's GitHub Actions configuration for the CI
 * Production deploy job (P163; replaces the P160 value-reading variable check):
 *
 *   node scripts/check-github-release-config.mjs [owner/repo]
 *
 * Uses the authenticated `gh` CLI. `--jq` runs inside `gh`, so only NAMES ever reach this process:
 * the variables endpoint returns values as well, and they are dropped before output. Nothing is
 * written and nothing on GitHub is changed. Prints a name and a category per finding.
 * Exit 0 = every required secret exists and no legacy `VITE_*` variable remains; 1 = not.
 *
 * This proves presence, not correctness. Whether a secret holds the right value is judged by the
 * deploy job's first guard at run time and, for rotation, by the owner's dashboards only.
 */
import { execFileSync } from 'node:child_process'
import { evaluateReleaseConfig } from './lib/release-config-check.mjs'

/** @param {string[]} args */
function gh(args) {
  // stderr is discarded on purpose: an error body must never be able to quote a value.
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** @param {string} out */
const lines = (out) =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

try {
  const repo =
    process.argv[2] ??
    gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
  const secrets = lines(
    gh(['api', `repos/${repo}/actions/secrets`, '--paginate', '--jq', '.secrets[].name']),
  )
  const variables = lines(
    gh(['api', `repos/${repo}/actions/variables`, '--paginate', '--jq', '.variables[].name']),
  )
  const result = evaluateReleaseConfig({ secrets, variables })
  if (result.ok) {
    console.log('check-github-release-config: OK (names only; values are not checked here)')
  } else {
    console.log(`check-github-release-config: FAIL (${String(result.findings.length)} finding(s))`)
    for (const f of result.findings) console.log(`  ${f.name}: ${f.category}`)
  }
  process.exit(result.ok ? 0 : 1)
} catch {
  console.log('check-github-release-config: FAIL (internal_error) — no details printed.')
  process.exit(1)
}
