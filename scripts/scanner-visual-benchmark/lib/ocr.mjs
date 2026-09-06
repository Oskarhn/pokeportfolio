// Node-side OCR baseline for the benchmark: the SAME pinned tesseract.js/eng traineddata the
// browser scanner uses (docs/DECISIONS.md D-094), run headless against the same staged assets
// under public/scanner-assets/v7 (no CDN — `pnpm prebuild` stages them). This is deliberately the
// "CURRENT OCR-first" baseline from prompt §13.A, not a reimplementation.
import { createWorker } from 'tesseract.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(here, '..', '..', '..', 'public', 'scanner-assets', 'v7')

let workerPromise = null
function getWorker() {
  if (!workerPromise) {
    // Node worker: tesseract.js resolves its OWN node worker/core internally (no workerPath
    // override — that script is browser-only). langPath is pointed at the SAME staged
    // traineddata the browser build ships, so this benchmark tool makes no CDN request either.
    workerPromise = createWorker('eng', 1, {
      langPath: ASSET_DIR,
      gzip: true,
      logger: () => {},
    })
  }
  return workerPromise
}

/** Runs full-frame OCR ('auto' page segmentation) over one image buffer — the same fallback
 *  path the real ocr-engine.ts uses when ROI strips fail. The benchmark does not crop precise
 *  name/number ROIs (there is no real capture geometry for a synthetic reference photo), so this
 *  intentionally exercises the SAME conservative full-frame split (`splitFullFrameCardText`) the
 *  production code falls back to. */
export async function ocrFullFrame(buffer) {
  const worker = await getWorker()
  await worker.setParameters({ tessedit_pageseg_mode: '3' })
  const { data } = await worker.recognize(buffer)
  return { text: data.text ?? '', confidence: data.confidence ?? 0 }
}

export async function disposeOcr() {
  if (workerPromise) {
    const worker = await workerPromise
    await worker.terminate()
    workerPromise = null
  }
}
