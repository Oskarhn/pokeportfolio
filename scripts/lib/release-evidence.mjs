/**
 * Pure logic behind `pnpm release:evidence` (P203): turns what was actually observed about one exact
 * commit into a non-secret report. Everything that touches git, the GitHub API or a child process
 * lives in scripts/release-evidence.mjs; the decisions live here so they are unit-testable
 * (tests/ops/release-evidence.test.ts).
 *
 * The one rule the whole module exists to keep: **an item that did not execute is never PASS**.
 * A local gate that was not requested is NOT_RUN, a CI check that GitHub has not reported is
 * MISSING, one still running is PENDING, one that could not be read is UNKNOWN. Only a gate that
 * ran on this exact commit and exited 0, or a CI check whose newest run on this exact commit
 * completed with `success`, is PASS. A report whose required items are not all PASS has the verdict
 * INCOMPLETE (nothing failed, but not everything ran) or FAILED; only an all-PASS report on a clean
 * tree is READY — and READY authorises nothing: Production is released by the separate, manually
 * dispatched deploy-production workflow.
 */

import { REQUIRED_CHECKS, isFullSha } from './release-verify.mjs'
import { redact, tailRedacted } from './redact.mjs'

export { REQUIRED_CHECKS, isFullSha, redact, tailRedacted }

/** Every status an evidence item can carry. PASS is the only one that counts as evidence. */
export const STATUSES = ['PASS', 'FAIL', 'PENDING', 'NOT_RUN', 'MISSING', 'UNKNOWN']

/**
 * Local gates the script may run. Each is a fixed argv for pnpm — there is no way to pass a command
 * in, and nothing here deploys, pushes a migration or dispatches a workflow
 * (tests/ops/release-evidence.test.ts asserts the allowlist stays that way).
 */
export const LOCAL_GATES = {
  typecheck: { label: 'Typecheck', args: ['typecheck'], required: true },
  lint: { label: 'Lint', args: ['lint'], required: true },
  format: { label: 'Format check', args: ['format:check'], required: true },
  unit: { label: 'Unit, domain, property and config tests', args: ['test'], required: true },
  build: {
    label: 'Production build (placeholder Supabase configuration)',
    args: ['build'],
    required: true,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
    },
  },
  e2e: { label: 'Browser E2E (placeholder backend)', args: ['test:e2e'], required: false },
  db: {
    label: 'Database and authorization tests (needs a local stack)',
    args: ['test:db'],
    required: false,
  },
}

/**
 * @param {Array<{id?: number, name?: string, status?: string, conclusion?: string|null}>|undefined|null}
 *   checkRuns the `check_runs` array GitHub returns for a commit; null/undefined = could not be read
 * @param {string[]} required
 * @returns {Array<{name: string, status: string, detail: string}>}
 *   Newest run per name decides (a re-run supersedes an earlier failure, a later failure supersedes
 *   an earlier success) — the same rule release-guard applies before Production.
 */
export function classifyCiChecks(checkRuns, required = REQUIRED_CHECKS) {
  if (!Array.isArray(checkRuns)) {
    return required.map((name) => ({
      name,
      status: 'UNKNOWN',
      detail: 'CI status could not be read (no GitHub access, or the commit is not on the remote)',
    }))
  }
  return required.map((name) => {
    const named = checkRuns.filter((r) => r && r.name === name)
    if (named.length === 0) {
      return {
        name,
        status: 'MISSING',
        detail: 'GitHub reports no run of this check on this commit',
      }
    }
    const newest = named.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a))
    if (newest.status !== 'completed') {
      return { name, status: 'PENDING', detail: `run is ${String(newest.status)}` }
    }
    if (newest.conclusion === 'success') {
      return { name, status: 'PASS', detail: 'newest run completed with success' }
    }
    return { name, status: 'FAIL', detail: `newest run concluded ${String(newest.conclusion)}` }
  })
}

/**
 * @param {Array<{name: string, required: boolean, status: string}>} items
 * @param {{ shaIsFull: boolean, clean: boolean, headMatches: boolean }} subject
 * @returns {{ verdict: 'READY'|'INCOMPLETE'|'FAILED', reasons: string[] }}
 */
export function decideVerdict(items, subject) {
  const reasons = []
  let failed = false
  if (!subject.shaIsFull) reasons.push('the commit is not a full 40-character SHA')
  if (!subject.clean) {
    reasons.push('the working tree has uncommitted changes, so no result describes a commit')
  }
  if (!subject.headMatches) {
    reasons.push('the checkout is not at the reported commit, so local gates could not be run')
  }
  for (const item of items) {
    if (!item.required) continue
    if (item.status === 'FAIL') {
      failed = true
      reasons.push(`${item.name}: FAIL`)
    } else if (item.status !== 'PASS') {
      reasons.push(`${item.name}: ${item.status} (not evidence)`)
    }
  }
  if (failed) return { verdict: 'FAILED', reasons }
  return { verdict: reasons.length === 0 ? 'READY' : 'INCOMPLETE', reasons }
}

const SKIP_SITE = /^[ \t]*(?:it|test|describe)\.(?:skip|fixme|todo)\b/gm

/**
 * @param {Array<{path: string, source: string}>} files test files
 * @returns {{ total: number, byFile: Array<{path: string, count: number}> }}
 *   Static skip sites. Conditional skips (`test.skip(cond, reason)`) are counted too — the report
 *   says so; a count is a pointer to where coverage is switched off, not a number of skipped tests.
 */
export function scanSkipSites(files) {
  const byFile = []
  for (const { path, source } of files) {
    const count = (source.match(SKIP_SITE) ?? []).length
    if (count > 0) byFile.push({ path, count })
  }
  byFile.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
  return { total: byFile.reduce((sum, f) => sum + f.count, 0), byFile }
}

/**
 * @param {object} report
 * @returns {string} Markdown. Contains only what is in `report`, all of it already redacted.
 */
export function renderMarkdown(report) {
  const lines = []
  lines.push(`# Release evidence — ${report.sha}`, '')
  lines.push(`**Verdict: ${report.verdict}**`, '')
  lines.push(
    '> This report authorises nothing. It records what was observed about one commit. Production is',
    '> released only by the manually dispatched `deploy-production` workflow.',
    '',
  )
  lines.push('## Subject', '')
  lines.push(`- Commit: \`${report.sha}\``)
  lines.push(`- Branch: \`${report.branch}\``)
  lines.push(`- Working tree: ${report.clean ? 'clean' : 'DIRTY'}`)
  lines.push(`- Generated: ${report.generatedAt}`)
  lines.push(`- Node: ${report.node}`, '')
  if (report.reasons.length > 0) {
    lines.push('## Why this is not READY', '')
    for (const reason of report.reasons) lines.push(`- ${reason}`)
    lines.push('')
  }
  lines.push(
    '## Local gates',
    '',
    '| Gate | Required | Status | Seconds | Detail |',
    '|---|---|---|---|---|',
  )
  for (const gate of report.localGates) {
    lines.push(
      `| ${gate.label} | ${gate.required ? 'yes' : 'no'} | ${gate.status} | ${gate.seconds ?? '—'} | ${gate.detail} |`,
    )
  }
  lines.push(
    '',
    '## Required CI checks (this exact commit)',
    '',
    '| Check | Status | Detail |',
    '|---|---|---|',
  )
  for (const check of report.ci) lines.push(`| ${check.name} | ${check.status} | ${check.detail} |`)
  lines.push('', '## Test gaps', '')
  lines.push('Declared standing gaps (maintained in scripts/lib/release-evidence-gaps.json):', '')
  for (const gap of report.knownGaps) {
    lines.push(`- **${gap.id}** — ${gap.summary} _(source: ${gap.source}, as of ${gap.asOf})_`)
  }
  lines.push(
    '',
    `Static skip sites in test code: **${report.skipSites.total}** (conditional skips included; a pointer to`,
    'where coverage can be switched off, not a count of skipped tests). Top files:',
    '',
  )
  for (const f of report.skipSites.byFile.slice(0, 10)) lines.push(`- \`${f.path}\` — ${f.count}`)
  const failing = report.localGates.filter((g) => g.status === 'FAIL' && g.tail)
  if (failing.length > 0) {
    lines.push('', '## Failure output (last lines, redacted)', '')
    for (const gate of failing) lines.push(`### ${gate.label}`, '', '```', gate.tail, '```', '')
  }
  lines.push('')
  return lines.join('\n')
}
