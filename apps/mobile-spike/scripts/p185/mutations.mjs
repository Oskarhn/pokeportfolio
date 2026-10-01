#!/usr/bin/env node
/**
 * P185 accessibility / control mutation proofs (NEW mutants only; the P184 scanner and RC suite is
 * re-run unchanged with scripts/p184/mutations.mjs). Each mutant plants ONE defect, runs the
 * relevant unit tests, and must make them FAIL by an ASSERTION. A mutant whose run reports "Test
 * suite failed to run" (syntax / import error) or fails no test is INVALID, not killed. Every file
 * is restored in a `finally`, and the run ends by checking that `git diff` of every mutated file is
 * empty.
 *
 *   node scripts/p185/mutations.mjs [regex-of-mutant-ids]
 *
 * Result: .build/p185-mutations.json (gitignored) and stdout. Needs a clean working tree for the
 * mutated files (commit first).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(appRoot, '..', '..')
const P = (p) => join(appRoot, p)
const R = (p) => join(repoRoot, p)
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null

const COMPONENTS = 'src/ui/components.tsx'
const PHOTO = 'src/features/price-check/PhotoEntryScreen.tsx'
const A11Y = [
  'tests/unit/p185-scanner-and-control-accessibility.test.tsx',
  'tests/unit/p170-integration.test.tsx',
]
const SCANNER_TESTS = A11Y

/** @type {{id:string,name:string,file:string,abs?:boolean,from:string,to:string,tests?:string[]}[]} */
const MUTANTS = [
  {
    id: 'N01',
    name: 'the HIGH confidence text is removed (confidence would be colour alone)',
    file: PHOTO,
    from: "? 'High confidence'",
    to: "? ''",
  },
  {
    id: 'N02',
    name: 'the confidence badge loses its accessible name (a screen reader hears no meaning)',
    file: PHOTO,
    from: 'accessibilityLabel={`Match confidence: ${confidenceLabel}`}',
    to: '',
  },
  {
    id: 'N03',
    name: 'the candidate accessible name loses its set and collector number',
    file: PHOTO,
    from: "accessibilityLabel={`${candidate.name}, ${candidate.setName ?? 'unknown set'}, ${candidate.collectorNumber ?? 'no printed number'}`}",
    to: 'accessibilityLabel={candidate.name}',
  },
  {
    id: 'N04',
    name: 'the recognised card identity is ellipsized again (printed number clipped at 200 % font)',
    file: PHOTO,
    from: '          wrapText\n',
    to: '',
  },
  {
    id: 'N05',
    name: 'a segmented radio shrinks below the 48 dp touch target',
    file: COMPONENTS,
    from: 'flex: 1,\n              minHeight: MIN_TOUCH,',
    to: 'flex: 1,\n              minHeight: 30,',
  },
  {
    id: 'N06',
    name: 'a RadioRow shrinks below the 48 dp touch target (printing / currency chooser)',
    file: COMPONENTS,
    from: "minHeight: MIN_TOUCH,\n        flexDirection: 'row',\n        alignItems: 'center',\n        gap: SPACE.md,\n        paddingVertical: SPACE.sm,",
    to: "minHeight: 30,\n        flexDirection: 'row',\n        alignItems: 'center',\n        gap: SPACE.md,\n        paddingVertical: SPACE.sm,",
  },
  {
    id: 'N07',
    name: 'the selected segmented option loses its selected state',
    file: COMPONENTS,
    from: 'accessibilityState={{ selected, checked: selected }}\n            accessibilityLabel={option.label}',
    to: 'accessibilityState={{ selected: false, checked: false }}\n            accessibilityLabel={option.label}',
  },
  {
    id: 'N08',
    name: 'Confirm becomes available before there is a valid (HIGH) candidate',
    file: PHOTO,
    from: '{preselected !== null ? (',
    to: "{scan.kind !== 'no_match' ? (",
  },
  {
    id: 'N09',
    name: 'a disabled button stays actionable (the disabled prop is dropped)',
    file: COMPONENTS,
    from: '      disabled={disabled}\n      onPress={onPress}\n      style={style}',
    to: '      onPress={onPress}\n      style={style}',
  },
  {
    id: 'N11',
    name: 'the switch row loses its checked state (a screen reader cannot tell on from off)',
    file: COMPONENTS,
    from: 'accessibilityState={{ checked: value, disabled: disabled === true }}',
    to: 'accessibilityState={{ disabled: disabled === true }}',
  },
  {
    id: 'N12',
    name: 'the switch row shrinks back to the native Switch size (below 48 dp)',
    file: COMPONENTS,
    from: "minHeight: MIN_TOUCH,\n        flexDirection: 'row',\n        alignItems: 'center',\n        gap: SPACE.md,\n        opacity:",
    to: "minHeight: 27,\n        flexDirection: 'row',\n        alignItems: 'center',\n        gap: SPACE.md,\n        opacity:",
  },
  {
    id: 'N13',
    name: 'a disabled switch stays actionable (the disabled prop is dropped from the row)',
    file: COMPONENTS,
    from: 'disabled={disabled}\n      onPress={() => onValueChange(!value)}',
    to: 'onPress={() => onValueChange(!value)}',
  },
  {
    id: 'N10',
    name: 'the touch-target sweep forgets radios again (role=button only)',
    file: 'tests/unit/p170-integration.test.tsx',
    from: "const SWEPT_ROLES = ['button', 'radio', 'checkbox', 'switch'] as const",
    to: "const SWEPT_ROLES = ['button'] as const",
  },
]

const results = []
const touched = new Set()
for (const m of MUTANTS) {
  if (only && !only.test(m.id)) continue
  const path = m.abs ? R(m.file) : P(m.file)
  touched.add(path)
  const original = readFileSync(path, 'utf8')
  const occurrences = original.split(m.from).length - 1
  if (occurrences !== 1) {
    results.push({
      id: m.id,
      name: m.name,
      verdict: 'INVALID',
      detail: `anchor occurs ${String(occurrences)} times`,
    })
    console.log(`${m.id} INVALID (anchor occurs ${String(occurrences)}x): ${m.name}`)
    continue
  }
  try {
    writeFileSync(
      path,
      original.replace(m.from, () => m.to),
    )
    const r = spawnSync(
      'pnpm',
      [
        'exec',
        'jest',
        '--selectProjects',
        'unit',
        '--runTestsByPath',
        ...(m.tests ?? SCANNER_TESTS),
      ],
      { cwd: appRoot, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 },
    )
    const out = `${r.stdout}\n${r.stderr}`
    const failedTests = Number(/Tests:\s+(?:\d+ skipped, )?(\d+) failed/.exec(out)?.[1] ?? 0)
    const suiteFailed = /Test suite failed to run/.test(out)
    let verdict
    if (suiteFailed) verdict = 'INVALID'
    else if (failedTests > 0) verdict = 'KILLED'
    else verdict = 'SURVIVED'
    const firstFail = /●\s+([^\n]+)/.exec(out)?.[1]?.trim().slice(0, 140) ?? null
    results.push({ id: m.id, name: m.name, verdict, failedTests, killedBy: firstFail })
    console.log(
      `${m.id} ${verdict}${verdict === 'KILLED' ? ` (${String(failedTests)} failing) by: ${String(firstFail)}` : ''}: ${m.name}`,
    )
  } finally {
    writeFileSync(path, original)
  }
}

const dirty = spawnSync('git', ['-C', repoRoot, 'diff', '--stat', '--', ...[...touched]], {
  encoding: 'utf8',
}).stdout.trim()
const summary = {
  total: results.length,
  killed: results.filter((r) => r.verdict === 'KILLED').length,
  survived: results.filter((r) => r.verdict === 'SURVIVED').length,
  invalid: results.filter((r) => r.verdict === 'INVALID').length,
  restored: dirty === '',
}
mkdirSync(join(appRoot, '.build'), { recursive: true })
writeFileSync(
  join(appRoot, '.build', 'p185-mutations.json'),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
)
console.log(JSON.stringify(summary))
if (!summary.restored) console.error(`WORKING TREE NOT RESTORED:\n${dirty}`)
process.exit(summary.survived + summary.invalid > 0 || !summary.restored ? 1 : 0)
