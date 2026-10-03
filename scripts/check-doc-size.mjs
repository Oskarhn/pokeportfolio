/**
 * Fails the build/CI if HANDOVER.md or docs/PROJECT_STATE.json grow past the P176 size budget
 * (scripts/lib/doc-size-policy.mjs). Warns (does not fail) if a docs/CURRENT_STATE/*.md file
 * exceeds its soft budget. Old, already-large canonical docs (DECISIONS.md etc.) are untouched.
 *
 * Usage: node scripts/check-doc-size.mjs
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BUDGETS, evaluateDocSize } from './lib/doc-size-policy.mjs'
import { reportAndExit } from './lib/verifier-summary.mjs'

const root = process.cwd()
const results = []

function sizeOf(path) {
  return existsSync(path) ? statSync(path).size : null
}

function record(evaluation) {
  results.push({ pass: evaluation.level !== 'fail' })
  const marker =
    evaluation.level === 'fail' ? 'FAIL' : evaluation.level === 'warn' ? 'WARN' : 'PASS'
  console.log(`${marker}  ${evaluation.message}`)
}

const handoverPath = join(root, 'HANDOVER.md')
const handoverBytes = sizeOf(handoverPath)
if (handoverBytes == null) {
  results.push({ pass: false })
  console.log('FAIL  HANDOVER.md not found at repository root')
} else {
  record(evaluateDocSize(BUDGETS.HANDOVER.label, handoverBytes, BUDGETS.HANDOVER))
}

const projectStatePath = join(root, 'docs', 'PROJECT_STATE.json')
const projectStateBytes = sizeOf(projectStatePath)
if (projectStateBytes == null) {
  results.push({ pass: false })
  console.log('FAIL  docs/PROJECT_STATE.json not found')
} else {
  record(evaluateDocSize(BUDGETS.PROJECT_STATE.label, projectStateBytes, BUDGETS.PROJECT_STATE))
}

const currentStateDir = join(root, 'docs', 'CURRENT_STATE')
if (existsSync(currentStateDir)) {
  const files = readdirSync(currentStateDir).filter((f) => f.endsWith('.md'))
  for (const file of files) {
    const bytes = sizeOf(join(currentStateDir, file))
    record(evaluateDocSize(`docs/CURRENT_STATE/${file}`, bytes, BUDGETS.CURRENT_STATE_DOC))
  }
} else {
  results.push({ pass: false })
  console.log('FAIL  docs/CURRENT_STATE/ directory not found')
}

reportAndExit(results)
