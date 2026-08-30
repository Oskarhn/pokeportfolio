/**
 * Pure WebGPU→WASM backend-selection orchestration for the visual-recognition worker (P78, D-097
 * addendum). Extracted out of `visual-worker.ts` so the actual decision logic — which backend to
 * try, in what order, whether a failure falls back or stays a clean failure — is unit-testable
 * without a real Worker/transformers.js/ONNX runtime, mirroring this codebase's existing
 * domain/adapter split (`index-pagination.ts`, `checkpoint-identity.ts`).
 *
 * WHY THIS EXISTS: a real-iPhone `VISUAL_MODEL_STATE=failed` report (P78) traced back to two
 * confirmed bugs — `env.allowLocalModels` never set (visual-worker.ts) and CSP `script-src`
 * missing `blob:` (vite.config.ts) — but investigating them surfaced a THIRD, structural gap: the
 * worker picked exactly one backend up front (`useWebgpu ? 'webgpu' : 'wasm'`) and never fell back
 * if that one choice failed to initialize. WASM is the required baseline (prompt §3/§10); WebGPU
 * is optional acceleration that must never take the whole channel down with it.
 */

export type VisualBackend = 'webgpu' | 'wasm'
export type VisualBackendOverride = 'auto' | 'wasm' | 'webgpu'
export type BackendAttemptStatus = 'success' | 'failed' | 'not-available' | 'not-attempted'

export interface BackendAttempts {
  readonly webgpu: BackendAttemptStatus
  readonly wasm: BackendAttemptStatus
}

export interface BackendSelectionResult {
  readonly chosen: VisualBackend | null
  readonly attempts: BackendAttempts
  readonly webgpuError: string | null
  readonly wasmError: string | null
}

export type ModelLoadAttempt = () => Promise<{ ok: true } | { ok: false; error: string }>

export interface BackendSelectionDeps {
  readonly detectWebgpuAvailable: () => Promise<boolean>
  readonly loadModel: (
    device: VisualBackend,
  ) => Promise<{ ok: true } | { ok: false; error: string }>
}

/** Any value other than the two real overrides normalizes to `auto` — an invalid/garbled
 *  `?visualBackend=` query value must never crash or silently disable the visual channel (prompt
 *  §5, R9). */
export function normalizeBackendOverride(value: unknown): VisualBackendOverride {
  return value === 'wasm' || value === 'webgpu' ? value : 'auto'
}

/**
 * Orchestrates ONE init attempt end to end:
 *  - `force wasm` never even probes for a WebGPU adapter (R7) — pure WASM path.
 *  - `force webgpu` tries WebGPU only; a failure (or no adapter) stays a clean failure and never
 *    silently substitutes WASM (R8) — an explicit force is a diagnostic request for THAT backend.
 *  - `auto` (default, R2/R4/R5) tries WebGPU first when an adapter is genuinely available, and
 *    falls back to WASM on any WebGPU failure OR its absence; WASM is only skipped when WebGPU
 *    already succeeded (R3 — never load both).
 *  - Only `chosen === null` (every attempted backend failed, or the only viable one wasn't
 *    available) is a hard failure; both attempted errors are retained on the result either way
 *    (R6), never overwritten by whichever attempt ran second.
 */
export async function selectVisualBackend(
  backendRequested: VisualBackendOverride,
  deps: BackendSelectionDeps,
): Promise<BackendSelectionResult> {
  const attempts: { webgpu: BackendAttemptStatus; wasm: BackendAttemptStatus } = {
    webgpu: 'not-attempted',
    wasm: 'not-attempted',
  }
  let webgpuError: string | null = null
  let wasmError: string | null = null
  let chosen: VisualBackend | null = null

  if (backendRequested !== 'wasm') {
    const hasWebgpu = await deps.detectWebgpuAvailable()
    if (hasWebgpu) {
      const result = await deps.loadModel('webgpu')
      attempts.webgpu = result.ok ? 'success' : 'failed'
      if (result.ok) chosen = 'webgpu'
      else webgpuError = result.error
    } else {
      attempts.webgpu = 'not-available'
    }
  }

  if (chosen === null && backendRequested !== 'webgpu') {
    const result = await deps.loadModel('wasm')
    attempts.wasm = result.ok ? 'success' : 'failed'
    if (result.ok) chosen = 'wasm'
    else wasmError = result.error
  }

  return { chosen, attempts, webgpuError, wasmError }
}

/** Joins every backend that was actually ATTEMPTED and failed into one safe, readable reason
 *  string — both reasons survive when both backends were tried and both failed (R6), never just
 *  whichever ran last. */
export function composeUnavailableReason(
  attempts: BackendAttempts,
  webgpuError: string | null,
  wasmError: string | null,
): string {
  const parts: string[] = []
  if (attempts.webgpu === 'failed' && webgpuError !== null) parts.push(`webgpu: ${webgpuError}`)
  if (attempts.wasm === 'failed' && wasmError !== null) parts.push(`wasm: ${wasmError}`)
  return parts.length > 0
    ? `model load failed: ${parts.join('; ')}`
    : 'model load failed: no backend available'
}
