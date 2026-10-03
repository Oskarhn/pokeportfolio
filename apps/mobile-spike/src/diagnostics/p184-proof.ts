import type { ScannerImageInput } from '../photo/photo-store'
import type { CardRecognitionPort, RecognitionOutcome } from '../features/price-check/recognition'
import type { RecognitionPipelineDeps } from '../features/scanner-native/recognition-pipeline'

/**
 * Device-proof seams for the P184 scanner gates. Only reachable in a bundle built with
 * EXPO_PUBLIC_RUNTIME_PROOF=1 (the same opt-in switch as every other device proof): the composition
 * root wraps the REAL pipeline collaborators, the proof panel on the photo screen drives them. The
 * production pipeline contains no proof logic at all — a delay is injected by wrapping one
 * collaborator from outside, so what runs on the device is the shipped code with a slow OCR.
 */

export const P184_PROOF_ENABLED = process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1'

let nextScanDelayMs = 0

/** The NEXT recognition's OCR call is held for `ms` (then the delay is consumed). */
export function setNextScanDelayMs(ms: number): void {
  nextScanDelayMs = ms
}

export function pendingScanDelayMs(): number {
  return nextScanDelayMs
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function withProofDelay(deps: RecognitionPipelineDeps): RecognitionPipelineDeps {
  return {
    ...deps,
    ocr: async (uri, imageHeight) => {
      const delay = nextScanDelayMs
      nextScanDelayMs = 0
      if (delay > 0) await sleep(delay)
      return deps.ocr(uri, imageHeight)
    },
  }
}

export interface StressTally {
  readonly requested: number
  readonly completed: number
  readonly analysed: number
  readonly cancelled: number
  readonly abstain: number
  readonly failed: number
  readonly done: boolean
  readonly elapsedMs: number
}

const emptyTally = (requested: number): StressTally => ({
  requested,
  completed: 0,
  analysed: 0,
  cancelled: 0,
  abstain: 0,
  failed: 0,
  done: false,
  elapsedMs: 0,
})

function tally(previous: StressTally, outcome: RecognitionOutcome, startedAt: number): StressTally {
  return {
    ...previous,
    completed: previous.completed + 1,
    analysed: previous.analysed + (outcome.status === 'analysed' ? 1 : 0),
    cancelled: previous.cancelled + (outcome.status === 'cancelled' ? 1 : 0),
    abstain: previous.abstain + (outcome.status === 'abstain_quality' ? 1 : 0),
    failed: previous.failed + (outcome.status === 'error' ? 1 : 0),
    elapsedMs: Date.now() - startedAt,
  }
}

/** N recognitions of the same photo, one after another (each waits for the previous). */
export async function runSequentialStress(
  port: CardRecognitionPort,
  input: ScannerImageInput,
  count: number,
  onProgress: (tally: StressTally) => void,
): Promise<StressTally> {
  const startedAt = Date.now()
  let current = emptyTally(count)
  for (let i = 0; i < count; i += 1) {
    current = tally(current, await port.recognize(input), startedAt)
    onProgress(current)
  }
  current = { ...current, done: true, elapsedMs: Date.now() - startedAt }
  onProgress(current)
  return current
}

/** N recognitions started `staggerMs` apart WITHOUT waiting: latest capture must win. */
export async function runOverlappedBurst(
  port: CardRecognitionPort,
  input: ScannerImageInput,
  count: number,
  staggerMs: number,
  onProgress: (tally: StressTally) => void,
): Promise<StressTally> {
  const startedAt = Date.now()
  let current = emptyTally(count)
  const runs: Promise<void>[] = []
  for (let i = 0; i < count; i += 1) {
    runs.push(
      port.recognize(input).then((outcome) => {
        current = tally(current, outcome, startedAt)
        onProgress(current)
      }),
    )
    await sleep(staggerMs)
  }
  await Promise.all(runs)
  current = { ...current, done: true, elapsedMs: Date.now() - startedAt }
  onProgress(current)
  return current
}

export function formatTally(label: string, t: StressTally): string {
  return `${label} ${t.done ? 'DONE' : 'RUNNING'} ${String(t.completed)}/${String(t.requested)} analysed=${String(t.analysed)} cancelled=${String(t.cancelled)} abstain=${String(t.abstain)} failed=${String(t.failed)} ms=${String(t.elapsedMs)}`
}
