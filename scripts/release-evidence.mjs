#!/usr/bin/env node
/**
 * Pre-release verification report (P203). Records what was actually observed about ONE commit:
 * which local gates ran on it and passed, what GitHub says about the required CI checks on that
 * exact SHA, and which test gaps are known. Writes release-evidence/<sha12>.md and .json (gitignored,
 * non-secret: statuses, durations and redacted failure tails only).
 *
 *   pnpm release:evidence                          # report only; every local gate is NOT_RUN
 *   pnpm release:evidence --run required           # typecheck, lint, format, unit tests, build
 *   pnpm release:evidence --run required,e2e,db    # plus Browser E2E and the DB suites (local stack)
 *   pnpm release:evidence --sha <40-hex>           # CI status of another commit (local gates NOT_RUN)
 *   pnpm release:evidence --no-ci                  # skip the GitHub query (CI items are NOT_RUN)
 *
 * Exit code: 0 READY, 1 FAILED, 2 INCOMPLETE (something did not run or is not green yet), 3 the
 * checkout moved while gates ran (the evidence is void).
 *
 * This script never deploys. It runs only the fixed `pnpm` argv in LOCAL_GATES, reads GitHub through
 * `gh api` (the operator's own authentication; it never sees or stores a token) and writes two files.
 * A gate that was not run is NOT_RUN, never PASS: see scripts/lib/release-evidence.mjs.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_GATES,
  classifyCiChecks,
  decideVerdict,
  isFullSha,
  redact,
  renderMarkdown,
  scanSkipSites,
  tailRedacted,
} from './lib/release-evidence.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const isWindows = process.platform === 'win32'

function git(...args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function parseArgs(argv) {
  const options = { sha: undefined, run: [], ci: true, outDir: join(repoRoot, 'release-evidence') }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--sha') options.sha = argv[++i]
    else if (arg === '--run') options.run = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg === '--no-ci') options.ci = false
    else if (arg === '--out-dir') options.outDir = resolve(repoRoot, argv[++i] ?? '')
    else throw new Error(`unknown argument: ${arg}`)
  }
  const requested = new Set()
  for (const name of options.run) {
    if (name === 'required') {
      for (const [key, gate] of Object.entries(LOCAL_GATES)) if (gate.required) requested.add(key)
    } else if (name === 'all') {
      for (const key of Object.keys(LOCAL_GATES)) requested.add(key)
    } else if (name in LOCAL_GATES) {
      requested.add(name)
    } else {
      throw new Error(
        `unknown gate "${name}"; known: required, all, ${Object.keys(LOCAL_GATES).join(', ')}`,
      )
    }
  }
  options.requested = requested
  return options
}

function runGate(key, gate) {
  const started = Date.now()
  const result = spawnSync('pnpm', gate.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: isWindows,
    env: { ...process.env, ...gate.env },
    maxBuffer: 256 * 1024 * 1024,
  })
  const seconds = Math.round((Date.now() - started) / 1000)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const passed = result.status === 0
  return {
    key,
    label: gate.label,
    required: gate.required,
    status: passed ? 'PASS' : 'FAIL',
    seconds,
    detail: passed ? 'exit 0' : `exit ${String(result.status ?? result.signal)}`,
    ...(passed ? {} : { tail: tailRedacted(output) }),
  }
}

function notRun(key, gate, detail) {
  return { key, label: gate.label, required: gate.required, status: 'NOT_RUN', detail }
}

function readCheckRuns(sha) {
  const result = spawnSync(
    'gh',
    ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs'],
    { cwd: repoRoot, encoding: 'utf8', shell: isWindows },
  )
  if (result.status !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function collectTestFiles() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|mts)$/.test(entry)) {
        files.push({
          path: relative(repoRoot, full).replace(/\\/g, '/'),
          source: readFileSync(full, 'utf8'),
        })
      }
    }
  }
  for (const root of ['tests', 'test']) walk(join(repoRoot, root))
  return files
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const head = git('rev-parse', 'HEAD')
  const sha = options.sha ?? head
  if (!isFullSha(sha)) throw new Error('--sha must be a full lowercase 40-character commit SHA')
  const headMatches = sha === head
  const statusBefore = git('status', '--porcelain')
  const dirtyBefore = statusBefore !== ''

  const localGates = []
  for (const [key, gate] of Object.entries(LOCAL_GATES)) {
    if (!options.requested.has(key)) {
      localGates.push(notRun(key, gate, 'not requested (--run)'))
    } else if (!headMatches) {
      localGates.push(notRun(key, gate, 'checkout is at a different commit'))
    } else if (dirtyBefore) {
      localGates.push(
        notRun(key, gate, 'working tree is dirty; refusing to attribute a result to a commit'),
      )
    } else {
      process.stderr.write(`running ${key}: pnpm ${gate.args.join(' ')}\n`)
      localGates.push(runGate(key, gate))
    }
  }

  if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain') !== statusBefore) {
    process.stderr.write('the checkout moved or changed while gates ran; evidence is void\n')
    process.exit(3)
  }

  const ci = options.ci
    ? classifyCiChecks(readCheckRuns(sha))
    : classifyCiChecks([]).map((c) => ({
        ...c,
        status: 'NOT_RUN',
        detail: 'not queried (--no-ci)',
      }))

  const items = [
    ...localGates.map((g) => ({ name: g.label, required: g.required, status: g.status })),
    ...ci.map((c) => ({ name: `CI ${c.name}`, required: true, status: c.status })),
  ]
  const { verdict, reasons } = decideVerdict(items, {
    shaIsFull: isFullSha(sha),
    clean: !dirtyBefore,
    headMatches,
  })

  const report = {
    sha,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    clean: !dirtyBefore,
    generatedAt: new Date().toISOString(),
    node: process.version,
    verdict,
    reasons,
    localGates,
    ci,
    knownGaps: JSON.parse(
      readFileSync(join(repoRoot, 'scripts/lib/release-evidence-gaps.json'), 'utf8'),
    ),
    skipSites: scanSkipSites(collectTestFiles()),
  }

  mkdirSync(options.outDir, { recursive: true })
  const base = join(options.outDir, sha.slice(0, 12))
  writeFileSync(`${base}.json`, `${redact(JSON.stringify(report, null, 2))}\n`)
  writeFileSync(`${base}.md`, redact(renderMarkdown(report)))
  process.stdout.write(`${verdict}  ${sha}\n${relative(repoRoot, base)}.md\n`)
  for (const reason of reasons) process.stdout.write(`  - ${reason}\n`)
  process.exit(verdict === 'READY' ? 0 : verdict === 'FAILED' ? 1 : 2)
}

try {
  main()
} catch (error) {
  process.stderr.write(
    `release-evidence: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(3)
}
