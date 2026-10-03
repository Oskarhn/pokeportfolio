#!/usr/bin/env node
/**
 * P186 mutation proofs: only for what P186 changed (the prewarm, the session invariant, the packaging
 * plugins, the OCR warm-up image, the date fixture). Each mutant plants ONE defect, runs the relevant
 * tests, and must make them FAIL by an assertion. A run that reports "Test suite failed to run" is
 * INVALID, not killed. Every file is restored in a `finally`, and the run ends by checking that
 * `git diff` of every mutated file is empty (so commit first).
 *
 *   node scripts/p186/mutations.mjs [regex-of-mutant-ids]
 *
 * The existing scanner / RC suites are re-run unchanged with scripts/p184/mutations.mjs and
 * scripts/p185/mutations.mjs. Result: .build/p186-mutations.json (gitignored) and stdout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const repoRoot = resolve(appRoot, '..', '..')
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null

const PIPELINE = 'src/features/scanner-native/recognition-pipeline.ts'
const ADAPTER = 'src/features/scanner-native/visual-adapter.ts'
const OCR = 'src/features/scanner-native/ocr-adapter.ts'
const WARMUP = 'src/features/scanner-native/warmup-image.ts'
const PHOTO = 'src/features/price-check/PhotoEntryScreen.tsx'
const PACKAGING = 'plugins/with-release-packaging.js'
const CXX = 'plugins/with-short-cxx-build-path.js'
const FIXTURE = 'tests/db/lib/fixture-dates.ts'

const PREWARM_TESTS = [
  'tests/unit/p186-scanner-prewarm.test.ts',
  'tests/unit/p186-ocr-warmup.test.ts',
  'tests/unit/p186-photo-screen-warmth.test.tsx',
]
const SESSION_TESTS = ['tests/unit/p186-session-lifecycle.test.ts']
const PACKAGING_TESTS = [
  'tests/unit/p186-release-packaging-plugin.test.ts',
  'tests/unit/p186-cxx-library-staging.test.ts',
]

/** @type {{id:string,name:string,file:string,root?:boolean,runner?:'jest'|'vitest',from:string,to:string,tests:string[]}[]} */
const MUTANTS = [
  {
    id: 'P01',
    name: 'the prewarm starts when the port is created (i.e. at app launch)',
    file: PIPELINE,
    from: '  const prewarm = (): void => {',
    to: '  setTimeout(() => prewarm(), 0)\n  const prewarm = (): void => {',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P02',
    name: 'the photo screen never tells the recognizer it was entered (no prewarm)',
    file: PHOTO,
    from: 'feature.recognition.scannerEntered?.()',
    to: 'void 0',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P03',
    name: 'entering the scanner does not start the model session',
    file: PIPELINE,
    from: 'Promise.all([deps.visualSession(), warmOcrOnce()]).then(',
    to: 'Promise.all([Promise.resolve(undefined as never), warmOcrOnce()]).then(',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P04',
    name: 'the session cache is bypassed: every caller creates its own model session',
    file: ADAPTER,
    from: '  if (cachedSession !== null) {',
    to: '  if (cachedSession !== null && createdSessions < 0) {',
    tests: SESSION_TESTS,
  },
  {
    id: 'P05',
    name: 'dispose no longer drops the cache entry (a later scan would use a released runtime)',
    file: ADAPTER,
    from: '      cachedSession = null\n      await ortSession.release()',
    to: '      await ortSession.release()',
    tests: SESSION_TESTS,
  },
  {
    id: 'P06',
    name: 'dispose is not idempotent (the active session count goes negative)',
    file: ADAPTER,
    from: '      if (disposed) return',
    to: '      if (false as boolean) return',
    tests: SESSION_TESTS,
  },
  {
    id: 'P07',
    name: 'a failed creation stays cached (the scanner stays dead until the app is killed)',
    file: ADAPTER,
    from: '    if (cachedSession === pending) cachedSession = null',
    to: '    void 0',
    tests: SESSION_TESTS,
  },
  {
    id: 'P08',
    name: 'the OCR engine is started on every entry instead of once per process',
    file: PIPELINE,
    from: '      ocrWarmed = true',
    to: '      ocrWarmed = false',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P09',
    name: 'a failed OCR start is remembered as done (never retried)',
    file: PIPELINE,
    from: '    } catch {\n      // ignored on purpose (see above)\n    }',
    to: '    } catch {\n      ocrWarmed = true\n    }',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P10',
    name: 'the decoder warm-up runs on every entry',
    file: PIPELINE,
    from: '      decodeWarmed = true',
    to: '      decodeWarmed = false',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P11',
    name: 'the warm-up image is corrupted (one header byte)',
    file: WARMUP,
    from: '0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x40,',
    to: '0x00, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00, 0x40,',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P12',
    name: 'the scanner asks ML Kit for a non-Latin script (the excluded packages would be needed)',
    file: OCR,
    from: 'TextRecognition.recognize(imagePath, TextRecognitionScript.LATIN)',
    to: 'TextRecognition.recognize(imagePath, TextRecognitionScript.CHINESE)',
    tests: PREWARM_TESTS,
  },
  {
    id: 'P13',
    name: 'the release bundle loses the arm64-v8a ABI',
    file: PACKAGING,
    from: "reactNativeArchitectures: 'arm64-v8a,x86_64',",
    to: "reactNativeArchitectures: 'x86_64',",
    tests: PACKAGING_TESTS,
  },
  {
    id: 'P14',
    name: 'the Latin ML Kit recognizer would be excluded',
    file: PACKAGING,
    from: "  'text-recognition-chinese',",
    to: "  'text-recognition',",
    tests: PACKAGING_TESTS,
  },
  {
    id: 'P15',
    name: 'R8 stops keeping the ONNX Runtime JNI classes',
    file: PACKAGING,
    from: '-keep class ai.onnxruntime.** { *; }\n',
    to: '',
    tests: PACKAGING_TESTS,
  },
  {
    id: 'P16',
    name: 'library modules lose the short CMake staging directory again (arm64 build breaks on Windows)',
    file: CXX,
    from: '  return withProjectBuildGradle(withApp, (cfg) => {',
    to: '  return withApp\n  withProjectBuildGradle(withApp, (cfg) => {',
    tests: PACKAGING_TESTS,
  },
  {
    id: 'P17',
    name: 'the date fixture uses day 10 for the current month again (fails on days 1-8)',
    file: FIXTURE,
    root: true,
    runner: 'vitest',
    from: 'monthsAgo === 0 ? 1 : PAST_MONTH_DAY',
    to: 'PAST_MONTH_DAY',
    tests: ['tests/db/lib/fixture-dates.test.ts'],
  },
  {
    id: 'P18',
    name: 'the date fixture overflows: 31 March minus one month becomes 3 March',
    file: FIXTURE,
    root: true,
    runner: 'vitest',
    from: 'new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day))',
    to: '(() => {\n    const x = new Date(now)\n    x.setUTCMonth(x.getUTCMonth() - monthsAgo)\n    x.setUTCDate(day)\n    return x\n  })()',
    tests: ['tests/db/lib/fixture-dates.test.ts'],
  },
]

const results = []
const touched = new Set()
for (const m of MUTANTS) {
  if (only && !only.test(m.id)) continue
  const path = m.root ? join(repoRoot, m.file) : join(appRoot, m.file)
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
    const vitest = m.runner === 'vitest'
    const r = vitest
      ? spawnSync('pnpm', ['exec', 'vitest', 'run', ...m.tests], {
          cwd: repoRoot,
          encoding: 'utf8',
          shell: true,
          maxBuffer: 64 * 1024 * 1024,
        })
      : spawnSync(
          'pnpm',
          ['exec', 'jest', '--selectProjects', 'unit', '--runTestsByPath', ...m.tests],
          {
            cwd: appRoot,
            encoding: 'utf8',
            shell: true,
            maxBuffer: 64 * 1024 * 1024,
          },
        )
    const out = `${r.stdout}\n${r.stderr}`
    const failedTests = Number(
      (vitest ? /Tests\s+(\d+) failed/ : /Tests:\s+(?:\d+ skipped, )?(\d+) failed/).exec(
        out,
      )?.[1] ?? 0,
    )
    const suiteFailed = vitest
      ? /Failed Suites|SyntaxError|Cannot find module/.test(out) && failedTests === 0
      : /Test suite failed to run/.test(out)
    let verdict
    if (suiteFailed) verdict = 'INVALID'
    else if (failedTests > 0) verdict = 'KILLED'
    else verdict = 'SURVIVED'
    const firstFail =
      (vitest ? /FAIL\s+([^\n]+)/ : /●\s+([^\n]+)/).exec(out)?.[1]?.trim().slice(0, 140) ?? null
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
  join(appRoot, '.build', 'p186-mutations.json'),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
)
console.log(JSON.stringify(summary))
if (!summary.restored) console.error(`WORKING TREE NOT RESTORED:\n${dirty}`)
process.exit(summary.survived + summary.invalid > 0 || !summary.restored ? 1 : 0)
