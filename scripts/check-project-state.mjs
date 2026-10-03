/**
 * Static, offline validation of docs/PROJECT_STATE.json against scripts/lib/project-state-schema.mjs.
 * No network access; safe for CI and local pre-commit use.
 *
 * Usage: node scripts/check-project-state.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateProjectState } from './lib/project-state-schema.mjs'
import { reportAndExit } from './lib/verifier-summary.mjs'

const root = process.cwd()
const path = join(root, 'docs', 'PROJECT_STATE.json')
const results = []

if (!existsSync(path)) {
  results.push({ pass: false })
  console.log('FAIL  docs/PROJECT_STATE.json not found')
  reportAndExit(results)
  process.exit(process.exitCode)
}

let state
try {
  state = JSON.parse(readFileSync(path, 'utf-8'))
} catch (error) {
  results.push({ pass: false })
  console.log(`FAIL  docs/PROJECT_STATE.json is not valid JSON: ${error.message}`)
  reportAndExit(results)
  process.exit(process.exitCode)
}

const handoverPath = join(root, 'HANDOVER.md')
const handoverText = existsSync(handoverPath) ? readFileSync(handoverPath, 'utf-8') : null

const errors = validateProjectState(state, {
  docExists: (relPath) => existsSync(join(root, relPath)),
  handoverText,
})

if (errors.length === 0) {
  results.push({ pass: true })
  console.log('PASS  docs/PROJECT_STATE.json is schema-valid and internally consistent')
} else {
  for (const message of errors) {
    results.push({ pass: false })
    console.log(`FAIL  ${message}`)
  }
}

reportAndExit(results)
