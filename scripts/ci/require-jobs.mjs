#!/usr/bin/env node
/**
 * Aggregator gate for the split CI jobs (P210).
 *
 *   NEEDS_JSON='<toJSON(needs)>' node scripts/ci/require-jobs.mjs --needs static-checks,browser-e2e
 *
 * Exit 0: every listed job succeeded. Exit 1: one did not (names and results are printed).
 * Exit 2: the invocation itself is wrong (missing or invalid input) -- also a failure, never a
 * silent pass. Decision logic and rationale: scripts/lib/ci-require-jobs.mjs.
 */
import { judgeNeeds } from '../lib/ci-require-jobs.mjs'

const args = process.argv.slice(2)
const flag = args.indexOf('--needs')
const list = flag >= 0 ? args[flag + 1] : undefined
const raw = process.env.NEEDS_JSON

if (!list) {
  process.stderr.write('require-jobs: --needs <job,job,...> is required\n')
  process.exit(2)
}
if (!raw) {
  process.stderr.write('require-jobs: NEEDS_JSON is empty\n')
  process.exit(2)
}
let needs
try {
  needs = JSON.parse(raw)
} catch {
  process.stderr.write('require-jobs: NEEDS_JSON is not valid JSON\n')
  process.exit(2)
}
const expected = list
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const { ok, problems } = judgeNeeds(needs, expected)
if (ok) {
  process.stdout.write(`all required jobs succeeded: ${expected.join(', ')}\n`)
  process.exit(0)
}
for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
process.exit(1)
