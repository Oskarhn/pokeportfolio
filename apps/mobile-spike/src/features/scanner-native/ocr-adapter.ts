import TextRecognition, { TextRecognitionScript } from '@react-native-ml-kit/text-recognition'
import type { ScannerObservation } from '@shared/domain/scanner/types'

/**
 * ML Kit Text Recognition v2 (on-device, Android; see docs/mobile/P182_PORTABILITY_AUDIT.md for
 * the package's verified identity/license) is a general document-text recognizer, not a
 * card-layout-aware one — it has no notion of "this line is the collector number" the way a
 * ROI-cropped Tesseract pass (the web scanner's own approach) can get closer to by only ever
 * reading the region a capture guide already aligned. This adapter recovers the two fields
 * `engine.ts` scores (collector number, name) from the FULL recognized line list using position/
 * shape heuristics, disclosed as scope-limited (no ROI crop in this phase — see the portability
 * audit's OCR section): a collector number is usually short, mostly digits, and printed near the
 * card's bottom edge; the name is usually the tallest line of mostly-letters text in the top half.
 * `rawSetText` is left null, matching the web scanner's own already-accepted V1 limitation
 * (engine.ts's own module doc: "rawSetText is always null" in production there too).
 */

const COLLECTOR_NUMBER_SHAPE = /^[A-Za-z]{0,4}\s?\d{1,4}\s?\/?\s?[A-Za-z0-9]{0,4}$/
const MAX_COLLECTOR_TOKEN_LENGTH = 14
const NAME_MIN_LETTERS = 2

interface OcrLine {
  readonly text: string
  readonly confidenceScore: number | null
  readonly top: number
  readonly height: number
}

export interface OcrExtraction extends Pick<
  ScannerObservation,
  'rawNameText' | 'rawCollectorNumberText' | 'nameOcrConfidence' | 'collectorOcrConfidence'
> {
  readonly fullText: string
}

function toOcrLines(result: {
  blocks: readonly {
    lines: readonly {
      text: string
      frame?: { top: number; height: number } | null
    }[]
  }[]
}): OcrLine[] {
  const lines: OcrLine[] = []
  for (const block of result.blocks) {
    for (const line of block.lines) {
      const trimmed = line.text.trim()
      if (trimmed === '') continue
      lines.push({
        text: trimmed,
        // @react-native-ml-kit/text-recognition 2.0.0 (the installed, verified version — see
        // docs/mobile/P182_PORTABILITY_AUDIT.md) exposes no per-line confidence score (unlike the
        // upstream project's in-progress docs, which describe a field this release does not yet
        // ship). engine.ts's ocrTextReliability already treats an absent confidence as full
        // reliability (its own documented backward-compatible default) — disclosed, not a bug.
        confidenceScore: null,
        top: line.frame?.top ?? 0,
        height: line.frame?.height ?? 0,
      })
    }
  }
  return lines
}

function pickCollectorNumberLine(lines: readonly OcrLine[], imageHeight: number): OcrLine | null {
  const bottomBand = imageHeight * 0.6
  const candidates = lines.filter(
    (line) =>
      line.text.length <= MAX_COLLECTOR_TOKEN_LENGTH &&
      COLLECTOR_NUMBER_SHAPE.test(line.text) &&
      /\d/.test(line.text),
  )
  if (candidates.length === 0) return null
  const inBottomBand = candidates.filter((line) => line.top >= bottomBand)
  const pool = inBottomBand.length > 0 ? inBottomBand : candidates
  return pool.reduce((best, line) => (line.top > best.top ? line : best), pool[0] as OcrLine)
}

function pickNameLine(lines: readonly OcrLine[], imageHeight: number): OcrLine | null {
  const topBand = imageHeight * 0.5
  const candidates = lines.filter((line) => {
    const letters = line.text.replace(/[^A-Za-z]/g, '')
    return letters.length >= NAME_MIN_LETTERS && letters.length >= line.text.length * 0.6
  })
  if (candidates.length === 0) return null
  const inTopBand = candidates.filter((line) => line.top <= topBand)
  const pool = inTopBand.length > 0 ? inTopBand : candidates
  return pool.reduce((best, line) => (line.height > best.height ? line : best), pool[0] as OcrLine)
}

/**
 * `imagePath` must be a local `file://` path ML Kit's native side can open directly — never bytes,
 * never uploaded (mission's absolute privacy contract; verified by the network-guard test, see
 * docs/mobile/P182_PORTABILITY_AUDIT.md §"privacy"). `imageHeight` is the DECODED (oriented) pixel
 * height, used only to bias the position heuristics above — not passed to ML Kit itself.
 */
export async function recognizeCardText(
  imagePath: string,
  imageHeight: number,
): Promise<OcrExtraction> {
  const result = await TextRecognition.recognize(imagePath, TextRecognitionScript.LATIN)
  const lines = toOcrLines(result)
  const collectorLine = pickCollectorNumberLine(lines, imageHeight)
  const nameLine = pickNameLine(lines, imageHeight)
  return {
    fullText: result.text,
    rawNameText: nameLine?.text ?? null,
    rawCollectorNumberText: collectorLine?.text ?? null,
    nameOcrConfidence: nameLine?.confidenceScore ?? null,
    collectorOcrConfidence: collectorLine?.confidenceScore ?? null,
  }
}
