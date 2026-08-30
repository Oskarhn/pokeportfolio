#!/usr/bin/env node
/**
 * REAL OCR runtime smoke (M15 prompt section 37): executes the pinned Tesseract engine against
 * the synthetic card fixture and reports what it read and how long it took on THIS machine.
 * This is a manual engineering gate, NOT required CI - deterministic Tesseract output is too
 * environment-sensitive for a flake-free unit suite (section 36's own split).
 *
 * Run:  node scripts/scanner-ocr-smoke.mjs
 *
 * The traineddata is loaded from OUR staged same-origin asset copy (public/scanner-assets/v7),
 * proving the artifact the build ships is the artifact that works. In Node, tesseract.js loads
 * its core by package resolution from the same pinned tesseract.js-core version the prepare
 * script copies into public/ - one version, two views of it.
 */
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker, OEM } from 'tesseract.js'

const require = createRequire(import.meta.url)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = resolve(repoRoot, 'public', 'scanner-assets', 'v7')
const fixture = join(repoRoot, 'tests', 'fixtures', 'scanner', 'synthetic-card.png')

if (!existsSync(fixture)) {
  console.error('Fixture missing. Run: node scripts/generate-scanner-fixture.mjs')
  process.exit(1)
}
if (!existsSync(join(assetsDir, 'eng.traineddata.gz'))) {
  console.error('Staged assets missing. Run: pnpm build (or scripts/prepare-scanner-assets.mjs).')
  process.exit(1)
}

const corePackage = JSON.parse(
  readFileSyncOf(join(dirname(require.resolve('tesseract.js-core/package.json')), 'package.json')),
)
function readFileSyncOf(path) {
  return statSync(path) && require('node:fs').readFileSync(path, 'utf-8')
}

console.log(`engine:    tesseract.js ${require('tesseract.js/package.json').version}`)
console.log(`core:      tesseract.js-core ${corePackage.version} (same pin as staged assets)`)
console.log(`traineddata from staged copy: ${assetsDir}`)

const started = Date.now()
const worker = await createWorker('eng', OEM.LSTM_ONLY, {
  langPath: assetsDir,
  gzip: true,
  logger: () => {},
})
try {
  const loadDone = Date.now()
  console.log(`worker ready in ${loadDone - started} ms`)

  const nameRoi = await worker.recognize(fixture)
  const ocrMs = Date.now() - loadDone
  console.log(`full-image recognize: ${ocrMs} ms wall time`)
  console.log(`recognized text: ${JSON.stringify(nameRoi.data.text.trim())}`)
  console.log(`mean confidence: ${nameRoi.data.confidence}`)
} finally {
  await worker.terminate()
}
