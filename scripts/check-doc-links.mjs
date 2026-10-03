/**
 * Verifies the P176 documentation set: relative Markdown links resolve, no committed reference
 * to an agent scratch/temp path, and no secret-shaped string. Scoped to the files P176 introduced
 * or rewrote (HANDOVER.md, docs/CURRENT_STATE/, docs/handover/, CLAUDE.md, AGENTS.md; P188 adds
 * docs/release/ and docs/mobile/) rather than
 * every pre-existing doc in `docs/`, which this task did not audit line-by-line.
 *
 * Usage: node scripts/check-doc-links.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  classifyLinkTarget,
  extractLinkTargets,
  findSecretShapes,
  referencesSandboxPath,
  stripFragment,
} from './lib/doc-link-checker.mjs'
import { reportAndExit } from './lib/verifier-summary.mjs'

const root = process.cwd()

function markdownFilesUnder(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFilesUnder(full)
    return entry.name.endsWith('.md') ? [full] : []
  })
}

const targets = [
  join(root, 'HANDOVER.md'),
  join(root, 'CLAUDE.md'),
  join(root, 'AGENTS.md'),
  ...markdownFilesUnder(join(root, 'docs', 'CURRENT_STATE')),
  ...markdownFilesUnder(join(root, 'docs', 'handover')),
  ...markdownFilesUnder(join(root, 'docs', 'release')),
  ...markdownFilesUnder(join(root, 'docs', 'mobile')),
]

const results = []

for (const filePath of targets) {
  if (!existsSync(filePath)) {
    results.push({ pass: false })
    console.log(`FAIL  ${filePath} does not exist`)
    continue
  }
  const text = readFileSync(filePath, 'utf-8')
  const relFile = filePath.slice(root.length + 1).replace(/\\/g, '/')

  for (const rawTarget of extractLinkTargets(text)) {
    const { kind } = classifyLinkTarget(rawTarget)
    if (kind !== 'relative') continue
    const withoutFragment = stripFragment(rawTarget)
    if (withoutFragment === '') continue // pure #fragment-in-same-file link, nothing to resolve
    const resolved = resolve(dirname(filePath), withoutFragment)
    const ok = existsSync(resolved)
    results.push({ pass: ok })
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${relFile} -> ${rawTarget}${ok ? '' : ' (does not resolve)'}`,
    )
  }

  const sandboxHit = referencesSandboxPath(text)
  results.push({ pass: !sandboxHit })
  console.log(`${sandboxHit ? 'FAIL' : 'PASS'}  ${relFile}: no agent scratch/temp path referenced`)

  const secretShapes = findSecretShapes(text)
  results.push({ pass: secretShapes.length === 0 })
  console.log(
    secretShapes.length === 0
      ? `PASS  ${relFile}: no secret-shaped string found`
      : `FAIL  ${relFile}: secret-shaped string found (${secretShapes.join(', ')})`,
  )
}

reportAndExit(results)
