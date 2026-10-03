/**
 * The boundary between M13's export UI (this feature) and the export engine (P35's
 * `src/domain/export/**` + `src/data/export/**`). The UI knows nothing about database fetching,
 * serialization, CSV generation or backup JSON — it calls a controller and delivers whatever
 * artifacts come back.
 *
 * This file is deliberately feature-local. P35 does not import it and nothing here reaches into
 * `src/data/export/`; the integrator wires the two halves together in exactly one place
 * (`controller.ts` next door).
 */

import type { IdentityLease } from '../../auth/identity-lease'

/** One generated file, ready for platform delivery. Filenames come from the engine (§10 of the
 *  M13 prompt: the UI presents what is being saved, never hardcodes names). */
export interface ExportArtifact {
  filename: string
  blob: Blob
}

/** Which user action is running. Drives copy and the retry behaviour. */
export type ExportKind = 'csv' | 'backup'

/**
 * Optional coarse progress from the engine. There is no percentage on purpose (M13 prompt §12:
 * no fake progress) — the UI maps these to two honest phase labels. A controller may simply
 * never call it.
 */
export type ExportProgressPhase = 'preparing' | 'creating-files'

export type ExportProgressListener = (phase: ExportProgressPhase) => void

/**
 * Per-run options.
 *
 * `signal` aborts the run — a request in flight is torn down and no further request is issued (the
 * promise rejects with a DOMException named 'AbortError'); the UI aborts on Cancel, on navigation
 * away and when the signed-in account changes.
 *
 * `lease` is the identity lease (P145) the run belongs to, taken by the UI at the moment the person
 * pressed the button for the account the page was rendered under. Every request of the run is made
 * through a client bound to it, and the run fails the moment the lease ends. It is optional in the
 * contract only so test doubles need not care; the wired controller refuses to run without one.
 */
export interface ExportRunOptions {
  signal?: AbortSignal
  lease?: IdentityLease
}

export interface ExportController {
  /** Full versioned JSON backup (`pokeportfolio-backup-YYYY-MM-DD.json`, engine-owned name). */
  createBackup(
    onProgress?: ExportProgressListener,
    options?: ExportRunOptions,
  ): Promise<ExportArtifact[]>
  /** CSV suite — one artifact, or several (the UI delivers either without assuming a ZIP). */
  createCsvExport(
    onProgress?: ExportProgressListener,
    options?: ExportRunOptions,
  ): Promise<ExportArtifact[]>
}
