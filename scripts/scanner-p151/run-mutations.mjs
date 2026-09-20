/**
 * P151 mutation checks: re-introduces each old scanner defect (or disables each new guard) one at a
 * time and demands that the permanent tests FAIL for a meaningful reason.
 *
 *   node scripts/scanner-p151/run-mutations.mjs [--only M3,M6] [--out report.json]
 *
 * A mutant counts as KILLED only when at least one real test assertion fails (an AssertionError, or
 * a "Test timed out" for a defect whose symptom is a hang). A compile/transform error that stops a
 * file from loading is NOT a kill — the mutant is reported as INVALID. Every mutated file is
 * restored from the exact original bytes and its SHA-256 is verified before the next mutant runs and
 * again at the end; the script refuses to start on a dirty file and exits non-zero on any mismatch.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const MUTANTS = [
  {
    id: 'M1',
    what: 'remove camera cleanup: session.stop() no longer stops the tracks',
    file: 'src/features/scanner/camera-session.ts',
    find: "        track.removeEventListener('ended', onTrackEnded)\n        track.stop()",
    replace: "        track.removeEventListener('ended', onTrackEnded)",
    tests: ['tests/ui/scanner-camera.test.ts', 'tests/ui/scanner-camera-soak.test.ts'],
  },
  {
    id: 'M2a',
    what: 'allow stale scan: a newer scan no longer aborts the previous one',
    file: 'src/features/scanner/controller.ts',
    find: '    activeScan?.abort.abort()\n    scanSequence += 1',
    replace: '    scanSequence += 1',
    tests: [
      'tests/ui/scanner-p151-controller-ordering.test.ts',
      'tests/ui/scanner-p151-stress.test.ts',
    ],
  },
  {
    id: 'M2b',
    what: 'allow stale scan: the publish gate before shared-state writes is removed',
    file: 'src/features/scanner/controller.ts',
    find: '    throwIfAnalysisAborted(signal)\n\n    const match = matchScannerObservation(',
    replace: '    const match = matchScannerObservation(',
    tests: ['tests/ui/scanner-p151-controller-ordering.test.ts'],
  },
  {
    id: 'M3',
    what: 'remove the pixel limit: no header pre-check before the decoder runs',
    file: 'src/features/scanner/capture.ts',
    find: '  if (declared !== null) throwForVerdict(assessImageDimensions(declared.width, declared.height))',
    replace: '  void declared',
    tests: ['tests/ui/scanner-p151-image-input.test.ts', 'tests/ui/scanner-p151-stress.test.ts'],
  },
  {
    id: 'M4a',
    what: 'skip worker termination: OCR worker finishing after dispose() is kept alive',
    file: 'src/features/scanner/ocr-engine.ts',
    find: '      void worker.terminate().catch(() => {})\n      throw new ScannerEngineDisposedError()',
    replace: '      throw new ScannerEngineDisposedError()',
    tests: ['tests/ui/scanner-p151-ocr-lifecycle.test.ts'],
  },
  {
    id: 'M4b',
    what: 'skip worker termination: a crashed/wedged visual worker is not terminated',
    file: 'src/features/scanner/visual/visual-client.ts',
    find: '      worker?.terminate()\n    } catch {',
    replace: '      void worker\n    } catch {',
    tests: ['tests/ui/scanner-p151-visual-client-lifecycle.test.ts'],
  },
  {
    id: 'M4c',
    what: 'OCR recognition timeout removed: a hung call wedges the serialized queue again',
    file: 'src/features/scanner/ocr-engine.ts',
    find: 'Promise.race([work, disposedSignal, timedOut])',
    replace: 'Promise.race([work, disposedSignal])',
    tests: ['tests/ui/scanner-p151-ocr-lifecycle.test.ts'],
  },
  {
    id: 'M4d',
    what: 'visual client is reusable after dispose(): a stale scan resurrects a worker',
    file: 'src/features/scanner/visual/visual-client.ts',
    find: '    if (this.disposed) return null\n    if (this.unavailableReason',
    replace: '    if (this.unavailableReason',
    tests: ['tests/ui/scanner-p151-visual-client-lifecycle.test.ts'],
  },
  {
    id: 'M5',
    what: 'disable the cache bound: superseded index generations are never evicted',
    file: 'src/features/scanner/visual/worker-asset-cache-through.ts',
    find: '          if (!shouldEvict(request.url)) continue',
    replace: '          continue',
    tests: ['tests/ui/scanner-p151-worker-cache.test.ts'],
  },
  {
    id: 'M5b',
    what: 'captive-portal pages are cached again',
    file: 'src/features/scanner/visual/worker-asset-cache-through.ts',
    find: '      !isHtmlResponse(response)',
    replace: '      true',
    tests: ['tests/ui/scanner-p151-worker-cache.test.ts'],
  },
  {
    id: 'M6',
    what: 'bypass the changed confidence rule: visual-only evidence can be HIGH again',
    file: 'src/domain/scanner/engine.ts',
    find: "  if (tier === 'high' && signals.collectorNumber === null && signals.normalizedName === null) {",
    replace: '  if (false as boolean) {',
    tests: [
      'tests/domain/scanner/p151-confidence-policy.test.ts',
      'tests/data/scanner-p151-confidence-real-index.test.ts',
    ],
  },
  {
    id: 'M7',
    what: 'P130 surviving mutant: disagreement cap applies only to a STRONG visual read',
    file: 'src/domain/scanner/engine.ts',
    find: "(visualOnlyTier === 'moderate' || visualOnlyTier === 'strong')",
    replace: "visualOnlyTier === 'strong'",
    tests: ['tests/domain/scanner/p151-confidence-policy.test.ts'],
  },
  {
    id: 'M8',
    what: 'a capture finishing after a reset is applied anyway (frame path)',
    file: 'src/features/scanner/guarded-capture.ts',
    find: '      if (guard.isCurrent(token)) handlers.onFrame(frame)',
    replace: '      handlers.onFrame(frame)',
    tests: ['tests/ui/scanner-p151-guarded-capture.test.ts'],
  },
]

const args = process.argv.slice(2)
const only = (args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean)
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : ''
const selected = only.length > 0 ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS

const scratch = mkdtempSync(path.join(os.tmpdir(), 'p151-mut-'))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function runVitest(tests, tag) {
  const report = path.join(scratch, `${tag}.json`)
  const result = spawnSync(
    pnpm,
    ['exec', 'vitest', 'run', ...tests, '--reporter=json', `--outputFile=${report}`],
    { shell: process.platform === 'win32', encoding: 'utf8', env: { ...process.env, CI: '1' } },
  )
  let json = null
  try {
    json = JSON.parse(readFileSync(report, 'utf8'))
  } catch {
    // no report: vitest itself failed to start
  }
  return { status: result.status, json, stderr: result.stderr }
}

function classify(json) {
  if (json === null) return { verdict: 'INVALID', reason: 'no test report produced', failing: [] }
  const failing = []
  let loadFailure = false
  for (const file of json.testResults) {
    if (file.status === 'failed' && file.assertionResults.length === 0) loadFailure = true
    for (const t of file.assertionResults) {
      if (t.status !== 'failed') continue
      const message = (t.failureMessages ?? []).join('\n')
      const meaningful = /AssertionError|expected |Test timed out|toBe|toEqual|toHave/i.test(
        message,
      )
      failing.push({ name: t.fullName.slice(0, 120), meaningful })
    }
  }
  if (loadFailure && failing.length === 0) {
    return {
      verdict: 'INVALID',
      reason: 'a test file failed to load (compile/transform error)',
      failing,
    }
  }
  if (failing.some((f) => f.meaningful)) return { verdict: 'KILLED', reason: '', failing }
  if (failing.length > 0)
    return { verdict: 'INVALID', reason: 'failures were not assertion failures', failing }
  return { verdict: 'SURVIVED', reason: '', failing }
}

const originals = new Map()
for (const m of selected) {
  if (!originals.has(m.file)) originals.set(m.file, readFileSync(m.file))
}
const originalSha = new Map([...originals].map(([file, bytes]) => [file, sha(bytes)]))

// Sanity: the UNMUTATED tests pass, so a later failure is attributable to the mutation.
const results = []
let restoreFailed = false
try {
  for (const m of selected) {
    const original = originals.get(m.file)
    const text = original.toString('utf8')
    const occurrences = text.split(m.find).length - 1
    if (occurrences !== 1) {
      results.push({
        id: m.id,
        what: m.what,
        verdict: 'INVALID',
        reason: `pattern found ${occurrences}x (need exactly 1)`,
        failing: [],
      })
      continue
    }
    const control = runVitest(m.tests, `${m.id}-control`)
    if (control.status !== 0) {
      results.push({
        id: m.id,
        what: m.what,
        verdict: 'INVALID',
        reason: 'control run (unmutated) does not pass',
        failing: [],
      })
      continue
    }
    writeFileSync(
      m.file,
      text.replace(m.find, () => m.replace),
    )
    let outcome
    try {
      outcome = classify(runVitest(m.tests, m.id).json)
    } finally {
      writeFileSync(m.file, original)
    }
    const restored = sha(readFileSync(m.file)) === originalSha.get(m.file)
    if (!restored) restoreFailed = true
    results.push({
      id: m.id,
      what: m.what,
      file: m.file,
      ...outcome,
      restoredByteForByte: restored,
    })
    console.log(
      `${m.id.padEnd(4)} ${outcome.verdict.padEnd(8)} ${m.what}` +
        (outcome.failing.length > 0
          ? `  [${outcome.failing.length} failing, e.g. "${outcome.failing[0].name.slice(0, 70)}"]`
          : '') +
        (outcome.reason ? `  (${outcome.reason})` : ''),
    )
  }
} finally {
  for (const [file, bytes] of originals) writeFileSync(file, bytes)
}
for (const [file, expected] of originalSha) {
  if (sha(readFileSync(file)) !== expected) restoreFailed = true
}
const summary = {
  mutants: results.length,
  killed: results.filter((r) => r.verdict === 'KILLED').length,
  survived: results.filter((r) => r.verdict === 'SURVIVED').length,
  invalid: results.filter((r) => r.verdict === 'INVALID').length,
  allFilesRestoredByteForByte: !restoreFailed,
}
console.log(JSON.stringify(summary))
if (outPath !== '') writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2))
process.exit(restoreFailed || summary.survived > 0 || summary.invalid > 0 ? 1 : 0)
