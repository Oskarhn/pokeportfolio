#!/usr/bin/env node
/**
 * Writes a Markdown test-duration and flaky-test summary for the CI job summary (P203).
 *
 *   node scripts/ci/test-summary.mjs --title "..." [--junit "Label=path.xml"]... [--playwright "Label=path.json"]...
 *
 * Prints to stdout; CI appends it to $GITHUB_STEP_SUMMARY. A missing or unreadable input is reported
 * in the summary and never fails the step: this reports on results, it is not a gate, and it must not
 * turn a real test failure into a confusing second failure.
 */

import { existsSync, readFileSync } from 'node:fs'
import { parseJUnitSuites, parsePlaywrightReport, renderSummary } from '../lib/ci-test-summary.mjs'

const args = process.argv.slice(2)
let title = 'Test results'
const junit = []
const playwright = []
for (let i = 0; i < args.length; i += 1) {
  const value = args[i + 1] ?? ''
  if (args[i] === '--title') title = value
  else if (args[i] === '--junit') junit.push(value)
  else if (args[i] === '--playwright') playwright.push(value)
  else continue
  i += 1
}

const split = (spec) => {
  const at = spec.indexOf('=')
  return at === -1
    ? { label: spec, path: spec }
    : { label: spec.slice(0, at), path: spec.slice(at + 1) }
}
const notes = []

const vitest = []
for (const spec of junit) {
  const { label, path } = split(spec)
  if (!existsSync(path)) {
    notes.push(
      `- \`${label}\`: no results file at \`${path}\` (the step did not reach its reporter)`,
    )
    continue
  }
  vitest.push({ label, suites: parseJUnitSuites(readFileSync(path, 'utf8')) })
}
const playwrightReports = []
for (const spec of playwright) {
  const { label, path } = split(spec)
  if (!existsSync(path)) {
    notes.push(
      `- \`${label}\`: no results file at \`${path}\` (the step did not reach its reporter)`,
    )
    continue
  }
  try {
    playwrightReports.push({
      label,
      report: parsePlaywrightReport(JSON.parse(readFileSync(path, 'utf8'))),
    })
  } catch (error) {
    notes.push(
      `- \`${label}\`: unreadable (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

let out = renderSummary({ title, vitest, playwright: playwrightReports })
if (notes.length > 0) out += `\n${notes.join('\n')}\n`
process.stdout.write(`${out}\n`)
