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

export interface ExportController {
  /** Full versioned JSON backup (`pokeportfolio-backup-YYYY-MM-DD.json`, engine-owned name). */
  createBackup(onProgress?: ExportProgressListener): Promise<ExportArtifact[]>
  /** CSV suite — one artifact, or several (the UI delivers either without assuming a ZIP). */
  createCsvExport(onProgress?: ExportProgressListener): Promise<ExportArtifact[]>
}
