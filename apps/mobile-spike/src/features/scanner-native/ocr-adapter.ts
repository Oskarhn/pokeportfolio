import TextRecognition, { TextRecognitionScript } from '@react-native-ml-kit/text-recognition'
import { File, Paths } from 'expo-file-system'
import { WARMUP_PNG } from './warmup-image'
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

export interface OcrLine {
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
  /** Every printed "N/M" token found (diagnostics only). */
  readonly slashTokens: readonly SlashToken[]
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

/**
 * A printed "number / total" token (`058/191`, `4/102`, `TG12/TG30`, `SV049/SV122`) anywhere INSIDE a
 * line. Real cards print it beside other text on one line (`Illus. <artist>   58/102`), so the whole
 * line is not number-shaped and a shape test on the line misses it. No lookbehind: Hermes.
 */
const SLASH_NUMBER =
  /(^|[^0-9A-Za-z/])([A-Za-z]{0,3}[0-9]{1,4})\s?\/\s?([A-Za-z]{0,3}[0-9]{2,4})(?![0-9A-Za-z/])/g

/** Lower fractions of the card are where a collector number is printed; damage / HP numbers sit higher. */
const NUMBER_BAND_SLASH = 0.6
const NUMBER_BAND_PREFIXED = 0.75
const NUMBER_BAND_BARE = 0.88

export interface SlashToken {
  readonly text: string
  readonly top: number
}

export function findSlashTokens(lines: readonly OcrLine[]): SlashToken[] {
  const out: SlashToken[] = []
  for (const line of lines) {
    for (const match of line.text.matchAll(SLASH_NUMBER)) {
      out.push({ text: `${match[2] ?? ''}/${match[3] ?? ''}`, top: line.top })
    }
  }
  return out
}

/**
 * The collector number, in order of how much a reading can be trusted:
 *  1. a printed "N/M" token in the lower part of the card (the LOWEST one wins);
 *  2. a whole line shaped like a prefixed id (`SV049`, `TG12`, `H31`) in the bottom quarter;
 *  3. a bare digit run only in the very bottom band — never mid-card, where HP, damage and
 *     weakness numbers ("30", "60", "100 HP") live and were misread as collector numbers on real
 *     cards before P184.
 * Nothing found is `null`, which the fusion treats as "no number evidence" — safer than a wrong one.
 * `imageHeight` is the height in the SAME pixel space as the recogniser's line frames.
 */
export function pickCollectorNumber(lines: readonly OcrLine[], imageHeight: number): string | null {
  const slash = findSlashTokens(lines)
    .filter((token) => token.top >= imageHeight * NUMBER_BAND_SLASH)
    .reduce<SlashToken | null>(
      (best, token) => (best === null || token.top > best.top ? token : best),
      null,
    )
  if (slash !== null) return slash.text

  const shaped = lines.filter(
    (line) =>
      line.text.length <= MAX_COLLECTOR_TOKEN_LENGTH &&
      COLLECTOR_NUMBER_SHAPE.test(line.text) &&
      /[0-9]/.test(line.text),
  )
  const pick = (band: number, predicate: (text: string) => boolean): OcrLine | null =>
    shaped
      .filter((line) => line.top >= imageHeight * band && predicate(line.text))
      .reduce<OcrLine | null>(
        (best, line) => (best === null || line.top > best.top ? line : best),
        null,
      )
  const prefixed = pick(NUMBER_BAND_PREFIXED, (text) => /^[A-Za-z]{1,4}\s?[0-9]{1,4}$/.test(text))
  if (prefixed !== null) return prefixed.text
  return pick(NUMBER_BAND_BARE, (text) => /^[0-9]{1,4}$/.test(text))?.text ?? null
}

export function pickNameLine(lines: readonly OcrLine[], imageHeight: number): OcrLine | null {
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
 * Runs one recognition of the synthetic blank so the first real photo does not pay ML Kit's
 * start-up. Errors are the caller's to ignore: a failed warm-up changes nothing about a scan.
 */
export async function warmOcr(): Promise<void> {
  // A fixed name in the cache directory, overwritten on every start: the only thing left behind is
  // this 98-byte synthetic blank (the scanner's no-write-path guard forbids a delete call here, and
  // the cache directory is the system's to evict).
  const file = new File(Paths.cache, 'ocr-warmup.png')
  file.create({ overwrite: true })
  file.write(WARMUP_PNG)
  await TextRecognition.recognize(file.uri, TextRecognitionScript.LATIN)
}

/**
 * What the native recogniser can open. iOS's binding does `[NSURL URLWithString:path]` and feeds the
 * result straight into UIImage/MLKVisionImage with no nil check, so a bare path, a `content://` URI or
 * a string with an unescaped space (a nil NSURL) would reach native code as a nil image and could take
 * the process down instead of rejecting. Android's binding parses leniently, so the one rule is checked
 * in JS for both: a local, absolute, correctly percent-encoded `file:///` URI (what expo-file-system
 * and the picker produce). Anything else is refused here and the scan degrades like any other OCR
 * failure (the pipeline treats it as "no text", never as a candidate).
 */
const NATIVE_READABLE_FILE_URI = /^file:\/\/\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]+$/

export function isNativeReadableFileUri(uri: string): boolean {
  return NATIVE_READABLE_FILE_URI.test(uri)
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
  if (!isNativeReadableFileUri(imagePath)) {
    throw new TypeError('OCR needs a local file:/// URI.')
  }
  const result = await TextRecognition.recognize(imagePath, TextRecognitionScript.LATIN)
  const lines = toOcrLines(result)
  const collectorNumber = pickCollectorNumber(lines, imageHeight)
  const nameLine = pickNameLine(lines, imageHeight)
  return {
    fullText: result.text,
    rawNameText: nameLine?.text ?? null,
    rawCollectorNumberText: collectorNumber,
    nameOcrConfidence: nameLine?.confidenceScore ?? null,
    // The recogniser exposes no per-line confidence (see toOcrLines): absent means full reliability.
    collectorOcrConfidence: null,
    slashTokens: findSlashTokens(lines).slice(0, 6),
  }
}
