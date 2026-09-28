#!/usr/bin/env node
/**
 * P184 scanner / release-candidate mutation proofs. Each mutant plants ONE defect in the scanner
 * or its seams, runs the relevant unit tests, and must make them FAIL by an ASSERTION. A mutant
 * whose run reports "Test suite failed to run" (syntax / import error) or fails no test is
 * INVALID, not killed. Every file is restored in a `finally`, and the run ends by checking that
 * `git diff` of every mutated file is empty.
 *
 *   node scripts/p184/mutations.mjs [regex-of-mutant-ids]
 *
 * Result: .build/p184-mutations.json (gitignored) and stdout. Needs a clean working tree for the
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

const SCANNER_TESTS = [
  'tests/unit/p184-native-scanner-pipeline.test.ts',
  'tests/unit/p184-native-asset-integrity.test.ts',
  'tests/unit/p184-photo-entry-lifecycle.test.tsx',
  'tests/unit/p184-image-header.test.ts',
  'tests/unit/scanner-native-image-pipeline.test.ts',
]
const PIPE = 'src/features/scanner-native/recognition-pipeline.ts'
const ASSETS = 'src/features/scanner-native/model-assets.ts'
const VISUAL = 'src/features/scanner-native/visual-adapter.ts'

/** @type {{id:string,name:string,file:string,abs?:boolean,from:string,to:string,tests?:string[]}[]} */
const MUTANTS = [
  {
    id: 'M01',
    name: 'image upload allowed: the image URI is handed to the catalog retrieval',
    file: PIPE,
    from: 'visualCardIds: visualHits.map((hit) => hit.cardId),\n    }),',
    to: 'visualCardIds: visualHits.map((hit) => hit.cardId),\n      imageUri: input.uri,\n    } as never),',
  },
  {
    id: 'M02',
    name: 'image URI sent in a request: the OCR name query is the file URI',
    file: PIPE,
    from: 'ocrName: ocr?.rawNameText ?? null,',
    to: 'ocrName: input.uri,',
  },
  {
    id: 'M03',
    name: 'model hash ignored',
    file: ASSETS,
    from: 'if (modelSha !== manifest.modelSha256) {',
    to: 'if (false as boolean) {',
  },
  {
    id: 'M04',
    name: 'index hash ignored',
    file: ASSETS,
    from: 'if (embeddingsSha !== manifest.embeddingsSha256) {',
    to: 'if (false as boolean) {',
  },
  {
    id: 'M05',
    name: 'decoded-pixel bound removed',
    file: 'src/features/scanner-native/image-safety.ts',
    from: 'if (pixels > MAX_DECODED_PIXELS)',
    to: 'if (false as boolean)',
  },
  {
    id: 'M06',
    name: 'header safety check removed (a pixel bomb reaches the decoder)',
    file: PIPE,
    from: 'if (!headerCheck.ok) {',
    to: 'if (false as boolean) {',
  },
  {
    id: 'M07',
    name: 'weak visual-only evidence becomes HIGH',
    file: PIPE,
    from: 'state: confidenceStateFromTier(match.tier),\n    scannerBestId,',
    to: "state: !observation.rawNameText && !observation.rawCollectorNumberText && match.candidates.length > 0 ? 'HIGH' : confidenceStateFromTier(match.tier),\n    scannerBestId,",
  },
  {
    id: 'M08',
    name: 'OCR/visual contradiction ignored (HIGH is not capped)',
    file: 'src/domain/scanner/engine.ts',
    abs: true,
    from: "if (tier === 'high') tier = 'medium'\n    }\n  }\n",
    to: 'void tier\n    }\n  }\n',
  },
  {
    id: 'M09',
    name: 'first candidate auto-confirmed: every band pre-selects',
    file: 'src/features/price-check/p165-domain/price-check/scan.ts',
    from: "if (confidence === 'HIGH') {",
    to: 'if (best !== undefined) {',
  },
  {
    id: 'M10',
    name: 'first printing auto-selected',
    file: 'src/features/price-check/price-check-flow-store.ts',
    from: 'const resolution = resolveVariant(outcome.value.variants, variantId)',
    to: 'const resolution = resolveVariant(outcome.value.variants, variantId ?? outcome.value.variants[0]?.variantId)',
    tests: ['tests/unit/p169-flow-and-search.test.ts', 'tests/unit/p169-screens.test.tsx'],
  },
  {
    id: 'M11',
    name: 'grade inferred onto a recognised candidate',
    file: PIPE,
    from: "languageLabel: c.language === 'ja' ? 'Japanese' : 'English',\n  }))",
    to: "languageLabel: c.language === 'ja' ? 'Japanese' : 'English',\n    grade: 'PSA 10',\n  }))",
  },
  {
    id: 'M12',
    name: 'condition inferred onto a recognised candidate',
    file: PIPE,
    from: "languageLabel: c.language === 'ja' ? 'Japanese' : 'English',\n  }))",
    to: "languageLabel: c.language === 'ja' ? 'Japanese' : 'English',\n    condition: 'NM',\n  }))",
  },
  {
    id: 'M13',
    name: 'stale scan publishes: the generation is never advanced by a new capture',
    file: PIPE,
    from: 'const myGeneration = (generation += 1)',
    to: 'const myGeneration = generation',
  },
  {
    id: 'M14',
    name: 'cancelled scan publishes: cancelActive() does nothing',
    file: PIPE,
    from: 'cancelActive() {\n      generation += 1\n    },',
    to: 'cancelActive() {},',
  },
  {
    id: 'M15',
    name: 'A result under B: the recognition port is not in the identity registry',
    file: 'src/features/feature.ts',
    from: "deps.registry.register('p169-recognition', { reset: () => recognition.reset?.() })",
    to: 'void 0',
  },
  {
    id: 'M16',
    name: 'A -> B -> A result publishes: reset() toggles instead of advancing monotonically',
    file: PIPE,
    from: 'reset() {\n      generation += 1\n    },',
    to: 'reset() {\n      generation = (generation + 1) % 2\n    },',
  },
  {
    id: 'M17',
    name: 'recognition writes to the database',
    file: PIPE,
    from: 'const observation: ScannerObservation = {',
    to: 'void ({} as { insert: (row: unknown) => void }).insert({ scanned: true })\n  const observation: ScannerObservation = {',
  },
  {
    id: 'M18',
    name: 'no-match becomes the first candidate (fusion always returns candidates)',
    file: 'src/domain/scanner/engine.ts',
    abs: true,
    from: 'if (!hasUsableSignal(signals, visualScores)) {',
    to: 'if (false as boolean) {',
  },
  {
    id: 'M19',
    name: 'model runtime reused after dispose: the session cache is not cleared',
    file: VISUAL,
    from: '      cachedSession = null\n      await ortSession.release()',
    to: '      await ortSession.release()',
  },
  {
    id: 'M20',
    name: 'activity recreation duplicates the runtime: every scan creates a session (no cache)',
    file: VISUAL,
    from: 'if (cachedSession !== null) {\n    emitTrace',
    to: 'if (false as boolean) {\n    emitTrace',
  },
  {
    id: 'M21',
    name: 'network privacy guard removed: the pipeline sends the image bytes over the network',
    file: PIPE,
    from: "const fileBytes = await timed(ctx, 'readMs', () => file.bytes())",
    to: "const fileBytes = await timed(ctx, 'readMs', () => file.bytes())\n  void fetch('http://127.0.0.1:1/upload', { method: 'POST', body: fileBytes as never })",
  },
  {
    id: 'M22',
    name: 'the trace records the image URI',
    file: PIPE,
    from: 'stoppedAt,\n          stages: roundStages(stages),',
    to: 'stoppedAt,\n          stages: roundStages(stages),\n          uri: input.uri,',
  },
  {
    id: 'M23',
    name: 'backgrounding no longer cancels the recognition',
    file: 'src/features/price-check/PhotoEntryScreen.tsx',
    from: 'feature.recognition.cancelActive?.()',
    to: 'void 0',
  },
  {
    id: 'M24',
    name: 'returning to the foreground always re-analyses (duplicate recognition)',
    file: 'src/features/price-check/recognition-lifecycle.ts',
    from: 'if (!state.photoReady || state.inFlight) return false',
    to: 'if (!state.photoReady) return true',
  },
  {
    id: 'M25',
    name: 'a transient asset failure is cached forever',
    file: ASSETS,
    from: 'if (!(error instanceof AssetIntegrityError) && cached === pending) cached = null',
    to: 'void error',
  },
  {
    id: 'M26',
    name: 'an integrity failure is not sticky (the asset is tried again)',
    file: ASSETS,
    from: 'if (!(error instanceof AssetIntegrityError) && cached === pending) cached = null',
    to: 'if (cached === pending) cached = null',
  },
  {
    id: 'M27',
    name: 'cancellation checkpoints removed (a superseded scan keeps running and queries the catalog)',
    file: PIPE,
    from: 'if (!ctx.isCurrent()) throw new RecognitionCancelledError(name)',
    to: 'void name',
  },
  {
    id: 'M28',
    name: 'unsupported container accepted (a non-image reaches the decoder)',
    file: PIPE,
    from: "if (header === null) {\n    throw new RecognitionAbstainError('This photo could not be read.', 'unsupported-format')\n  }",
    to: 'if (header === null) {\n    /* accepted */\n  }',
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
  join(appRoot, '.build', 'p184-mutations.json'),
  `${JSON.stringify({ summary, results }, null, 2)}\n`,
)
console.log(JSON.stringify(summary))
if (!summary.restored) console.error(`WORKING TREE NOT RESTORED:\n${dirty}`)
process.exit(summary.survived + summary.invalid > 0 || !summary.restored ? 1 : 0)
