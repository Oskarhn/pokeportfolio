// Parametrized Node OCR wrapper for the P85 forensics/recognition benchmarks — the SAME pinned
// tesseract.js/eng traineddata + staged assets the browser scanner uses (docs/DECISIONS.md
// D-094), extended beyond scripts/scanner-visual-benchmark/lib/ocr.mjs's fixed PSM-3 fallback so
// this benchmark can actually VARY page-segmentation mode, character whitelist and
// preserve_interword_spaces per call — the exact Tesseract.js 7 configuration surface P85 §3
// investigates. Kept in its own directory rather than extending the P76/P79/P82 visual-benchmark
// lib: this is OCR-only tooling with no DINOv2/embedding dependency at all.
import { createWorker } from 'tesseract.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ASSET_DIR = join(here, '..', '..', '..', 'public', 'scanner-assets', 'v7')

/** Tesseract page-segmentation modes this project's staged assets can actually run (P85 §3):
 *  eng.traineddata (LSTM-only) is staged, but osd.traineddata is NOT (see
 *  scripts/prepare-scanner-assets.mjs). PSM 0/2/12 all require orientation-and-script detection —
 *  confirmed directly against this project's real staged asset set: they do NOT throw, they
 *  silently degrade (stderr: "Error opening data file ./osd.traineddata" /
 *  "Tesseract couldn't load any languages!", then return `{ text: '', confidence: 0 }` every
 *  time) — a worse failure mode than an exception, since a caller with no OSD awareness would
 *  read that as "nothing was there" rather than "the configuration was invalid." Excluded here
 *  for that measured reason, not guessed at. */
export const PSM = {
  AUTO: '3',
  SINGLE_BLOCK: '6',
  SINGLE_LINE: '7',
  SINGLE_WORD: '8',
  SPARSE_TEXT: '11',
  RAW_LINE: '13',
}

let workerPromise = null
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: ASSET_DIR,
      gzip: true,
      logger: () => {},
    })
  }
  return workerPromise
}

/**
 * Runs one recognition call with an explicit, fully-controlled configuration. `whitelist: ''`
 * explicitly clears any whitelist a PREVIOUS call on the same shared worker left set — Tesseract
 * parameters persist on the worker instance across calls, so every dimension this benchmark
 * varies must be set on every call, never assumed to still be at its default.
 */
export async function recognizeWithConfig(
  buffer,
  { psm = PSM.SINGLE_LINE, whitelist = '', preserveInterwordSpaces = false, dpi = '300' } = {},
) {
  const worker = await getWorker()
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    tessedit_char_whitelist: whitelist,
    preserve_interword_spaces: preserveInterwordSpaces ? '1' : '0',
    user_defined_dpi: dpi,
  })
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
