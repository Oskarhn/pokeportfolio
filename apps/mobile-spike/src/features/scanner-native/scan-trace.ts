/**
 * Opt-in structured trace of the on-device recognition pipeline (P184). Off unless the bundle is
 * built with EXPO_PUBLIC_RUNTIME_PROOF=1 (the same switch as every other device proof, see
 * diagnostics/feature-events.ts), so a normal build emits nothing.
 *
 * What is recorded: stage timings, the OCR-read name/number strings, the top visual hits and the
 * fused result. What is NEVER recorded: the image, its pixels, its URI or file name — the trace
 * exists so the device driver can compare pipeline decisions with the web scanner and measure
 * latency, and must not itself become an egress or a leak (guarded by a unit test).
 */

export interface ScanStageTimings {
  readonly readMs: number
  readonly headerMs: number
  readonly decodeMs: number
  readonly ocrMs: number
  /** Time spent waiting for the (cached) model session; large only on the first scan. */
  readonly sessionMs: number
  readonly preprocessMs: number
  readonly onnxMs: number
  readonly searchMs: number
  readonly retrievalMs: number
  readonly fusionMs: number
  readonly totalMs: number
}

export type ScanTraceOutcome =
  'analysed' | 'cancelled' | 'abstain_quality' | 'error' | 'published_suppressed'

export interface ScanTraceEvent {
  readonly kind: 'scan'
  readonly scanId: number
  readonly outcome: ScanTraceOutcome
  /** Set when the pipeline stopped early; names the checkpoint or the refusal. */
  readonly stoppedAt: string | null
  readonly stages: Partial<ScanStageTimings>
  readonly ocr: {
    readonly name: string | null
    readonly number: string | null
    readonly failed: boolean
  } | null
  readonly visualTop: readonly { readonly cardId: string; readonly similarity: number }[]
  readonly visualFailed: boolean
  readonly tier: string | null
  readonly topCandidateIds: readonly string[]
  readonly scannerBestId: string | null
  readonly preselectedId: string | null
  readonly evidenceCodes: readonly string[]
}

export interface SessionTraceEvent {
  readonly kind: 'session'
  readonly action: 'create_started' | 'created' | 'create_failed' | 'reused'
  readonly sessionCount: number
  readonly ms?: number
}

export type NativeTraceEvent = ScanTraceEvent | SessionTraceEvent

type Sink = (event: NativeTraceEvent) => void

const ENABLED = process.env.EXPO_PUBLIC_RUNTIME_PROOF === '1'

const defaultSink: Sink | null = ENABLED
  ? (event) => {
      console.log(`P184_TRACE ${JSON.stringify(event)}`)
    }
  : null

let sink: Sink | null = defaultSink

/** Test seam: install (or clear with `null`) a sink regardless of the build flag. */
export function setScanTraceSink(next: Sink | null): void {
  sink = next
}

export function resetScanTraceSink(): void {
  sink = defaultSink
}

export function emitTrace(event: NativeTraceEvent): void {
  if (sink !== null) sink(event)
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
