#!/usr/bin/env node
/**
 * Mutation proofs (P158 §15). Each mutant breaks ONE safety mechanism in the source, runs the
 * relevant tests, and must be KILLED by at least one assertion failure (a test that FAILS, not a
 * compile error: Babel does not type-check, so a kill here is always a behavioural failure). The file
 * is restored in a `finally`, and the run ends by asserting the working tree is byte-identical to
 * what it was when the run started.
 *
 *   node scripts/mutation-proofs.mjs            run all mutants (unit + shared tests; no Docker)
 *   node scripts/mutation-proofs.mjs --only M1  run one mutant
 *
 * Requires a clean apps/mobile-spike working tree at start (commit or stash first).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(appRoot, '.build')
mkdirSync(outDir, { recursive: true })

/** @type {{id:string, title:string, file:string, edits:[string,string][], tests:string[]}[]} */
const MUTANTS = [
  {
    id: 'M1',
    title: 'remove the identity-bound reset (A state survives into B)',
    file: 'src/wiring/runtime.ts',
    edits: [['registry.resetAll()', 'void 0']],
    tests: ['tests/unit/identity-isolation.test.ts', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M2',
    title: 'format money through Number() (loses digits above 2^53)',
    file: 'src/money/format-money.ts',
    edits: [
      [
        'const whole = dot === -1 ? decimal : decimal.slice(0, dot)',
        'const whole = String(Number(dot === -1 ? decimal : decimal.slice(0, dot)))',
      ],
    ],
    tests: ['tests/unit/format-money.test.ts'],
  },
  {
    id: 'M3a',
    title: 'NULL formatted as zero',
    file: 'src/money/format-money.ts',
    edits: [
      [
        'if (value === null || value === undefined) return ABSENT',
        "if (value === null || value === undefined) return formatMoney({ minorUnits: 0n, currency: 'NOK' })",
      ],
    ],
    tests: ['tests/unit/format-money.test.ts', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M3b',
    title: 'NULL holding value read as zero in the collection adapter',
    file: 'src/collection/shared-data-adapter.ts',
    edits: [
      [
        'holdingValueMinor: tile.holdingValueMinor,',
        'holdingValueMinor: tile.holdingValueMinor ?? 0n,',
      ],
    ],
    tests: ['tests/unit/shared-data-reuse.test.ts'],
  },
  {
    id: 'M4a',
    title: 'accept an unsafe JSON integer in a response (rounded amount reaches the UI)',
    file: 'src/net/exact-transport-guard.ts',
    edits: [
      ['if (literal !== null) throw new UnsafeNumericResponseError(literal)', 'void literal'],
    ],
    tests: ['tests/unit/money-transport.test.ts', 'tests/unit/shared-data-reuse.test.ts'],
  },
  {
    id: 'M4b',
    title: 'accept an unsafe JSON number as money in the wire parser',
    file: 'src/money/wire.ts',
    edits: [['if (!Number.isSafeInteger(value)) {', 'if (false as boolean) {']],
    tests: ['tests/unit/money-transport.test.ts', 'tests/unit/price-check.test.ts'],
  },
  {
    id: 'M5',
    title: 'price the WRONG catalog variant (first variant instead of the chosen one)',
    file: 'src/state/price-check-store.ts',
    edits: [
      [
        'await this.lookup(data.card.cardId, resolution.variant.variantId)',
        'await this.lookup(data.card.cardId, data.variants[0]?.variantId ?? resolution.variant.variantId)',
      ],
    ],
    tests: ['tests/unit/price-check.test.ts', 'tests/unit/native-app.test.tsx'],
  },
  {
    id: 'M6a',
    title: 'Price Check imports an acquisition module',
    file: 'src/price-check/released-adapter.ts',
    edits: [
      [
        "import { getCardVariantPriceHistory } from '@shared/data/pricing'",
        "import { getCardVariantPriceHistory } from '@shared/data/pricing'\nimport { createPurchase } from '@shared/data/purchases'\nvoid createPurchase",
      ],
    ],
    tests: ['tests/unit/price-check.test.ts'],
  },
  {
    id: 'M6b',
    title: 'read-only request policy disabled (a financial write RPC would reach the wire)',
    file: 'src/net/spike-fetch.ts',
    edits: [['assertReadOnlyRequest(method, url)', 'void method']],
    tests: ['tests/unit/shared-data-reuse.test.ts'],
  },
  {
    id: 'M7a',
    title: 'stale response for A is committed after B signed in',
    file: 'src/state/lease-run.ts',
    edits: [
      [
        "const value = await work()\n    if (!lease.isCurrent()) return { kind: 'stale' }",
        'const value = await work()',
      ],
    ],
    tests: ['tests/unit/identity-isolation.test.ts'],
  },
  {
    id: 'M7b',
    title: 'stale FAILURE for A is committed after B signed in',
    file: 'src/state/lease-run.ts',
    edits: [
      [
        "    if (!lease.isCurrent()) return { kind: 'stale' }\n    if (error instanceof AuthIdentityChangedError)",
        '    if (error instanceof AuthIdentityChangedError)',
      ],
    ],
    tests: ['tests/unit/identity-isolation.test.ts'],
  },
  {
    id: 'M8',
    title: 'a Production / non-local backend URL is accepted',
    file: 'src/config/backend-config.ts',
    edits: [
      ['if (PRODUCTION_HOSTS.some((pattern) => pattern.test(host))) {', 'if (false as boolean) {'],
      ['if (!isLocalHost(host)) {', 'if (false as boolean) {'],
    ],
    tests: ['tests/unit/backend-config.test.ts'],
  },
]

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null

function git(args) {
  return spawnSync('git', args, { cwd: appRoot, encoding: 'utf8' })
}

function isClean() {
  return git(['status', '--porcelain', '--', '.']).stdout.trim() === ''
}

if (!isClean()) {
  console.error('working tree of apps/mobile-spike is not clean; commit or stash first')
  process.exit(2)
}

function runJest(tests) {
  // No --json: the JSON reporter itself throws on a failing BigInt assertion in the parent process.
  return spawnSync(
    'pnpm',
    [
      'exec',
      'jest',
      '--selectProjects',
      'unit',
      '--verbose',
      // In-band + tests/support/bigint-json.ts keep failing BigInt assertions readable (jest#11617).
      '--runInBand',
      ...tests,
    ],
    { cwd: appRoot, encoding: 'utf8', shell: process.platform === 'win32' },
  )
}

/** Names of tests that FAILED, from the verbose reporter ("  × name (12 ms)"). */
function failedNames(output) {
  return [...output.matchAll(/^\s+×\s+(.*?)(?:\s+\(\d+ ms\))?\r?$/gm)].map((m) => m[1])
}

// Baseline: every mutant's test files must pass unmutated, or a "kill" would mean nothing.
const baselineFiles = [...new Set(MUTANTS.flatMap((m) => m.tests))]
const baseline = runJest(baselineFiles)
if (baseline.status !== 0) {
  console.error('baseline run FAILED; refusing to run mutants')
  process.exit(2)
}

const results = []
for (const m of MUTANTS) {
  if (only !== null && m.id !== only) continue
  const path = join(appRoot, m.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  for (const [find, replace] of m.edits) {
    if (mutated.split(find).length !== 2) {
      console.error(`${m.id}: pattern not found exactly once in ${m.file}: ${find.slice(0, 60)}`)
      process.exit(2)
    }
    mutated = mutated.replace(find, () => replace)
  }
  try {
    writeFileSync(path, mutated)
    const r = runJest(m.tests)
    const failed = failedNames(`${r.stdout}
${r.stderr}`)
    const suiteCrash = r.status !== 0 && failed.length === 0
    results.push({
      id: m.id,
      title: m.title,
      file: m.file,
      killed: r.status !== 0 && failed.length > 0,
      // A suite that failed to even load is NOT accepted as a kill.
      suiteCrash,
      failingTests: failed.slice(0, 6),
      failingCount: failed.length,
    })
  } finally {
    writeFileSync(path, original)
  }
  const last = results[results.length - 1]
  console.log(
    `${m.id} ${last.killed ? 'KILLED  ' : 'SURVIVED'} ${m.title} (${last.failingCount} failing)`,
  )
}

const clean = isClean()
writeFileSync(
  join(outDir, 'mutation-results.json'),
  JSON.stringify({ results, treeCleanAfter: clean }, null, 2),
)
console.log(
  `\nmutants killed: ${results.filter((r) => r.killed).length}/${results.length}; tree clean afterwards: ${clean}`,
)
process.exit(results.every((r) => r.killed) && clean ? 0 : 1)
