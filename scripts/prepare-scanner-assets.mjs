#!/usr/bin/env node
/**
 * Copies the exact pinned OCR runtime assets from installed npm packages into
 * public/scanner-assets/v7/ so a production build ships same-origin OCR assets.
 *
 * Runs automatically before every build (`prebuild` in package.json). A fresh clone needs only
 * `pnpm install && pnpm build` — there is no separate download step and nothing is committed to
 * git (the target directory is generated content).
 *
 * Sources (exact versions asserted below; npm reality: tesseract.js 7.0.0 declares its own core
 * dependency as ^7.0.0, so the researched 6.x pin is superseded by 7.0.0):
 *   - tesseract.js            Apache-2.0  dist/worker.min.js (the Web Worker script)
 *   - tesseract.js-core 7.0.0 Apache-2.0  tesseract-core-{relaxedsimd,simd}-lstm.wasm.js/.wasm
 *                                         + tesseract-core-lstm.wasm.js/.wasm (non-SIMD fallback)
 *   - @tesseract.js-data/eng  MIT         4.0.0_best_int/eng.traineddata.gz (LSTM integer model;
 *                                         upstream traineddata per tessdata licensing)
 *
 * The worker resolves `corePath` as a directory and picks relaxedsimd → simd → plain LSTM by
 * device capability; all three lstm-only variants must exist or some devices get no engine.
 * `langPath` points at this directory and the worker fetches eng.traineddata.gz from it.
 */
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'public', 'scanner-assets', 'v7')

const EXPECTED_VERSIONS = {
  'tesseract.js': '7.0.0',
  'tesseract.js-core': '7.0.0',
  '@tesseract.js-data/eng': '1.0.0',
}

const COPIES = [
  { pkg: 'tesseract.js', src: 'dist/worker.min.js', dest: 'worker.min.js' },
  {
    pkg: 'tesseract.js-core',
    src: 'tesseract-core-relaxedsimd-lstm.wasm.js',
    dest: 'tesseract-core-relaxedsimd-lstm.wasm.js',
  },
  {
    pkg: 'tesseract.js-core',
    src: 'tesseract-core-relaxedsimd-lstm.wasm',
    dest: 'tesseract-core-relaxedsimd-lstm.wasm',
  },
  {
    pkg: 'tesseract.js-core',
    src: 'tesseract-core-simd-lstm.wasm.js',
    dest: 'tesseract-core-simd-lstm.wasm.js',
  },
  {
    pkg: 'tesseract.js-core',
    src: 'tesseract-core-simd-lstm.wasm',
    dest: 'tesseract-core-simd-lstm.wasm',
  },
  {
    pkg: 'tesseract.js-core',
    src: 'tesseract-core-lstm.wasm.js',
    dest: 'tesseract-core-lstm.wasm.js',
  },
  { pkg: 'tesseract.js-core', src: 'tesseract-core-lstm.wasm', dest: 'tesseract-core-lstm.wasm' },
  {
    pkg: '@tesseract.js-data/eng',
    src: '4.0.0_best_int/eng.traineddata.gz',
    dest: 'eng.traineddata.gz',
  },
]

for (const [pkg, expected] of Object.entries(EXPECTED_VERSIONS)) {
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'node_modules', pkg, 'package.json'), 'utf-8'),
  )
  if (manifest.version !== expected) {
    console.error(
      `prepare-scanner-assets: ${pkg} is ${manifest.version}, expected exactly ${expected}. ` +
        'Update the pin AND this script together.',
    )
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
for (const { pkg, src, dest } of COPIES) {
  const source = join(repoRoot, 'node_modules', pkg, src)
  if (!existsSync(source)) {
    console.error(`prepare-scanner-assets: missing asset ${source} (is ${pkg} installed?)`)
    process.exit(1)
  }
  copyFileSync(source, join(outDir, dest))
}

console.log(`prepare-scanner-assets: ${COPIES.length} assets staged in public/scanner-assets/v7`)
