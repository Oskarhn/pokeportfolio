/**
 * P81 §3: cold-start phase attribution for the visual-recognition worker. `VISUAL_MODEL_LOAD_MS`
 * alone (P78/P80) told the owner THAT initialization was slow (388s on a real iPhone) but not
 * WHERE the time went. This module classifies every fetch the worker's init sequence issues by
 * URL suffix, so the worker can report per-asset network time and byte counts, and the caller can
 * infer non-network time (WASM compile / ONNX session creation / decode) as the remainder of each
 * wall-clock phase.
 *
 * Pure and platform-neutral (no `self`/`fetch` reference here) so classification is unit-testable
 * without a Worker environment — `visual-worker.ts` owns the actual `fetch` wrapping.
 */

export type VisualFetchPhase =
  | 'processorConfig'
  | 'modelConfig'
  | 'modelOnnx'
  | 'ortRuntime'
  | 'ortWasm'
  | 'indexManifest'
  | 'indexIds'
  | 'indexEmbeddings'
  | 'other'

/** Matches the ASSET_BASE-relative paths this worker actually requests (visual-worker.ts) plus
 *  the `/model/...` paths transformers.js derives from `env.localModelPath` + `MODEL_ID`. Suffix
 *  matching (not full-path equality) so this survives an asset-base version bump without edits. */
export function classifyVisualAssetUrl(url: string): VisualFetchPhase {
  if (/\/model\/onnx\/.+\.onnx(?:[?#].*)?$/.test(url)) return 'modelOnnx'
  if (/\/model\/config\.json(?:[?#].*)?$/.test(url)) return 'modelConfig'
  if (/\/model\/preprocessor_config\.json(?:[?#].*)?$/.test(url)) return 'processorConfig'
  if (/\/ort\/.+\.wasm(?:[?#].*)?$/.test(url)) return 'ortWasm'
  if (/\/ort\/.+\.mjs(?:[?#].*)?$/.test(url)) return 'ortRuntime'
  if (/\/manifest\.json(?:[?#].*)?$/.test(url)) return 'indexManifest'
  if (/\/card-ids\.json(?:[?#].*)?$/.test(url)) return 'indexIds'
  if (/\/embeddings\.bin(?:[?#].*)?$/.test(url)) return 'indexEmbeddings'
  return 'other'
}

export interface RecordedFetch {
  readonly phase: VisualFetchPhase
  readonly ms: number
  /** From the response's `Content-Length` header; null when absent (never guessed). */
  readonly bytes: number | null
}

export interface PhaseFetchSummary {
  readonly ms: number
  readonly bytes: number | null
}

/** Sums duration and bytes per phase. A phase fetched more than once in one init (should not
 *  normally happen) sums both — still an honest total, never silently dropped. */
export function summarizeFetchLog(
  log: readonly RecordedFetch[],
): Record<VisualFetchPhase, PhaseFetchSummary> {
  const phases: VisualFetchPhase[] = [
    'processorConfig',
    'modelConfig',
    'modelOnnx',
    'ortRuntime',
    'ortWasm',
    'indexManifest',
    'indexIds',
    'indexEmbeddings',
    'other',
  ]
  const summary = Object.fromEntries(
    phases.map((phase) => [phase, { ms: 0, bytes: null as number | null }]),
  ) as Record<VisualFetchPhase, PhaseFetchSummary>
  for (const entry of log) {
    const current = summary[entry.phase]
    const bytes =
      entry.bytes === null && current.bytes === null
        ? null
        : (current.bytes ?? 0) + (entry.bytes ?? 0)
    summary[entry.phase] = { ms: current.ms + entry.ms, bytes }
  }
  return summary
}

/**
 * Cold-start phase attribution (P81 §3/§17) — where VISUAL_READY_TOTAL_MS actually went. Every
 * *_FETCH_MS/BYTES field is a directly observed network-or-cache response time; every other field
 * is either a directly-measured synchronous span (decode, worker start) or an honest wall-clock
 * remainder after subtracting the network time already accounted for elsewhere (P78/P80's single
 * `modelColdLoadMs` number told the owner THAT a real iPhone took 388 seconds, never WHERE; this
 * is the follow-up instrumentation that answers that).
 */
export interface VisualPhaseTimings {
  /** Time from `new Worker(...)` to the worker's own module-scope evaluation starting — script
   *  fetch/parse/module-graph-eval cost, before any application code below runs. Null only if the
   *  client never recorded its own construction timestamp (should not happen in real use). */
  readonly workerStartMs: number | null
  readonly processorFetchMs: number
  readonly processorInitMs: number
  readonly modelConfigFetchMs: number
  readonly modelOnnxFetchMs: number
  readonly modelOnnxBytes: number | null
  readonly ortRuntimeFetchMs: number
  readonly ortWasmFetchMs: number
  readonly ortWasmBytes: number | null
  /** ONNX graph compile + WASM instantiate + `InferenceSession.create` combined — the prompt's
   *  separate ORT_INIT_MS/MODEL_SESSION_CREATE_MS are not independently observable without
   *  patching onnxruntime-web internals, so this is reported as one honest remainder instead of
   *  two invented numbers. */
  readonly modelCompileAndSessionCreateMs: number
  readonly indexManifestFetchMs: number
  readonly indexIdsFetchMs: number
  readonly indexEmbeddingsFetchMs: number
  readonly indexEmbeddingsBytes: number | null
  readonly indexDecodeMs: number | null
  readonly visualReadyTotalMs: number
}

/** Non-negative wall-clock remainder: the part of a measured phase NOT accounted for by its own
 *  network fetches — the nearest honest proxy for compile/instantiate/decode work available
 *  without patching onnxruntime-web/transformers.js internals (P81 §3's explicit instruction:
 *  "instrument the nearest observable fetch/init boundaries without forking blindly"). Floored at
 *  0 rather than allowed negative, which timer jitter could otherwise produce. */
export function nonNetworkRemainder(wallMs: number, networkMs: number): number {
  return Math.max(0, Math.round(wallMs - networkMs))
}

/**
 * P82 §2-§6: live progress phases the worker posts WHILE it is still initializing — the gap P81's
 * instrumentation left. P81 only reported phase timings inside the TERMINAL `ready`/`unavailable`
 * message, so a real stalled init (the owner's real-iPhone report: `VISUAL_MODEL_STATE=loading` for
 * over a minute) left every phase field as "—" — the main thread knew NOTHING beyond "loading"
 * while the worker was genuinely stuck. Each phase name denotes ENTERING that phase; the main
 * thread infers "how long has the worker been in phase X" from the elapsed time since the most
 * recent progress message, never from a second timer the worker itself runs.
 */
export type VisualWorkerProgressPhase =
  | 'worker-module-evaluated'
  | 'init-received'
  | 'processor-load-started'
  | 'processor-load-finished'
  | 'backend-selection-started'
  | 'webgpu-attempt-started'
  | 'webgpu-attempt-finished'
  | 'wasm-attempt-started'
  | 'wasm-attempt-finished'
  | 'model-load-finished'
  | 'index-load-started'
  | 'index-manifest-loaded'
  | 'index-ids-loaded'
  | 'index-embeddings-loaded'
  | 'index-decode-finished'
  | 'ready'

export type AssetCacheStatusEstimate = 'unknown' | 'likely-cache' | 'likely-network'

/**
 * Debug-panel-only heuristic (P81 §17 ASSET_CACHE_STATUS) — "best observable approximation," not
 * a certainty: neither the Cache Storage API nor `fetch()` exposes a "this response came from
 * cache" flag to caller code, so this infers it from the ratio between bytes transferred and time
 * taken. A same-origin Cache Storage hit resolves in low single-digit milliseconds regardless of
 * payload size (no network round trip at all); downloading multiple megabytes over a real network
 * connection cannot approach that ratio. The threshold is deliberately conservative — a genuinely
 * fast connection could exceed it too, which is exactly why this is reported as "likely", never
 * asserted as fact.
 */
export function estimateAssetCacheStatus(
  timings: Pick<
    VisualPhaseTimings,
    'modelOnnxFetchMs' | 'modelOnnxBytes' | 'ortWasmFetchMs' | 'ortWasmBytes'
  > | null,
): AssetCacheStatusEstimate {
  if (timings === null) return 'unknown'
  const totalBytes = (timings.modelOnnxBytes ?? 0) + (timings.ortWasmBytes ?? 0)
  if (totalBytes <= 0) return 'unknown'
  const totalMs = timings.modelOnnxFetchMs + timings.ortWasmFetchMs
  const bytesPerMs = totalBytes / Math.max(1, totalMs)
  // 50,000 bytes/ms is 50 MB/s sustained for a single fetch of a few tens of megabytes — well
  // above realistic mobile/broadband throughput for one HTTP request (and far above the
  // real-device evidence this session repairs, which showed MINUTES for this same payload), but
  // trivially exceeded by a same-process Cache Storage read, which involves no network transfer
  // at all — just a structured-clone of an already-resident Response.
  return bytesPerMs > 50_000 ? 'likely-cache' : 'likely-network'
}
