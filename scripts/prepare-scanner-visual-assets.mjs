#!/usr/bin/env node
/**
 * Stages the pinned DINOv2-small visual-recognition model into
 * public/scanner-assets/visual-v1/model/ so the production build ships a same-origin model (D-097
 * — mirrors scripts/prepare-scanner-assets.mjs's OCR asset staging exactly, prompt §24).
 *
 * Source: Hugging Face `Xenova/dinov2-small` at a PINNED revision (never "main"/"latest"),
 * verified by SHA-256 before anything is staged. A network outage to Hugging Face after this
 * step has already run once (and cached locally) does not affect subsequent builds; a cache
 * corruption or a hash mismatch fails the build loudly instead of shipping unverified weights.
 *
 * Runs as part of `prebuild`, alongside the OCR asset staging. Nothing here is committed to git
 * (public/scanner-assets/ is gitignored — see .gitignore's "Scanner artefacts" section) and
 * nothing here is user data: this is Apache-2.0 model weights, not card imagery.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VISUAL_MODEL_REPO,
  VISUAL_MODEL_REVISION,
  VISUAL_MODEL_FILES,
} from './scanner-visual-index/lib/model-pin.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(repoRoot, 'scripts', 'scanner-visual-index', '.visual-index-cache', 'model')
const outDir = join(repoRoot, 'public', 'scanner-assets', 'visual-v1', 'model')
const ortOutDir = join(repoRoot, 'public', 'scanner-assets', 'visual-v1', 'ort')

// onnxruntime-web ships its own WASM runtime and — left to its default — transformers.js will
// point at `cdn.jsdelivr.net` for it (verified by reading dist/transformers.js directly: it only
// skips the CDN default when `env.backends.onnx.wasm.wasmPaths` is ALREADY set). Staging these
// same-origin, and setting wasmPaths explicitly before any inference call in the browser runtime,
// is what keeps the "no CDN, ever" boundary (prompt §24) actually true for this model.
const ORT_FILES = [
  // Safari/WebKit path (apis.IS_SAFARI branch in transformers.js).
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  // Non-Safari path (chromium-family browsers used for desktop preview verification).
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
]

function findOnnxRuntimeWebDist() {
  const transformersPkg = JSON.parse(
    readFileSync(
      join(repoRoot, 'node_modules', '@huggingface', 'transformers', 'package.json'),
      'utf-8',
    ),
  )
  const declaredVersion = transformersPkg.dependencies?.['onnxruntime-web']
  if (!declaredVersion) {
    throw new Error(
      'prepare-scanner-visual-assets: could not read onnxruntime-web version from @huggingface/transformers/package.json',
    )
  }
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm')
  const candidates = existsSync(pnpmDir)
    ? readdirSync(pnpmDir).filter((name) => name.startsWith(`onnxruntime-web@${declaredVersion}`))
    : []
  if (candidates.length === 0) {
    throw new Error(
      `prepare-scanner-visual-assets: no node_modules/.pnpm/onnxruntime-web@${declaredVersion}* found. ` +
        'Run `pnpm install` first.',
    )
  }
  return join(pnpmDir, candidates[0], 'node_modules', 'onnxruntime-web', 'dist')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function ensureCached(file) {
  const cachedPath = join(cacheDir, file.stagedName)
  if (existsSync(cachedPath) && sha256(cachedPath) === file.sha256) return cachedPath

  const url = `https://huggingface.co/${VISUAL_MODEL_REPO}/resolve/${VISUAL_MODEL_REVISION}/${file.upstreamPath}`
  console.log(`prepare-scanner-visual-assets: fetching ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`prepare-scanner-visual-assets: GET ${url} -> ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  mkdirSync(dirname(cachedPath), { recursive: true })
  writeFileSync(cachedPath, buffer)

  const actual = sha256(cachedPath)
  if (actual !== file.sha256) {
    throw new Error(
      `prepare-scanner-visual-assets: SHA-256 mismatch for ${file.upstreamPath} ` +
        `(expected ${file.sha256}, got ${actual}). Refusing to stage unverified model weights.`,
    )
  }
  return cachedPath
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(outDir, 'onnx'), { recursive: true })
  for (const file of VISUAL_MODEL_FILES) {
    const cachedPath = await ensureCached(file)
    copyFileSync(cachedPath, join(outDir, file.stagedName))
  }
  const manifest = {
    modelRepo: VISUAL_MODEL_REPO,
    modelRevision: VISUAL_MODEL_REVISION,
    files: VISUAL_MODEL_FILES.map((f) => ({ name: f.stagedName, sha256: f.sha256 })),
  }
  writeFileSync(join(outDir, 'pin-manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(
    `prepare-scanner-visual-assets: ${VISUAL_MODEL_FILES.length} files staged in ` +
      `public/scanner-assets/visual-v1/model (${VISUAL_MODEL_REPO}@${VISUAL_MODEL_REVISION})`,
  )

  mkdirSync(ortOutDir, { recursive: true })
  const ortDistDir = findOnnxRuntimeWebDist()
  for (const file of ORT_FILES) {
    const source = join(ortDistDir, file)
    if (!existsSync(source)) {
      throw new Error(
        `prepare-scanner-visual-assets: missing ${source} — onnxruntime-web layout changed?`,
      )
    }
    copyFileSync(source, join(ortOutDir, file))
  }
  console.log(
    `prepare-scanner-visual-assets: ${ORT_FILES.length} onnxruntime-web WASM files staged (same-origin, no CDN)`,
  )
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
