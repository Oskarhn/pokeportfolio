/**
 * M13 export artifact generation — the ORCHESTRATION half of the core (fetching lives in
 * fetch-snapshot.ts, pure serialization in src/domain/export/). Everything here runs client-side
 * under the signed-in owner's session; nothing is uploaded anywhere and export content is never
 * logged.
 *
 * This module is the integration surface P36 consumes — see src/data/export/index.ts for the
 * deliberately small public boundary. UI concerns (delivery UX, share sheet vs anchor, progress
 * rendering) belong to P36; this layer only produces finished Blobs plus progress callbacks.
 */
import { BACKUP_FORMAT_ID, BACKUP_SCHEMA_VERSION } from '../../domain/export/backup-format'
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../domain/export/build-backup'
import {
  EXPORT_CSV_FILENAMES,
  buildCsvSuite,
  projectionInputFromSnapshot,
  type CsvFileContent,
} from '../../domain/export/csv-projections'
import type { ExportSnapshot } from '../../domain/export/snapshot-types'
import { supabase } from '../supabase-client'
import { fetchExportSnapshot, type ExportFetchOptions } from './fetch-snapshot'

/** One finished, downloadable file. No streams, no partial state, no server round trips. */
export interface ExportArtifact {
  readonly filename: string
  readonly mimeType: string
  readonly blob: Blob
}

export type ExportOptions = ExportFetchOptions

export const JSON_BACKUP_MIME_TYPE = 'application/json'
export const CSV_MIME_TYPE = 'text/csv;charset=utf-8'
export const ZIP_MIME_TYPE = 'application/zip'

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

export function jsonBackupFilename(stamp: string = todayStamp()): string {
  return `pokeportfolio-backup-${stamp}.json`
}

export function everythingZipFilename(stamp: string = todayStamp()): string {
  return `pokeportfolio-export-${stamp}.zip`
}

function currentAppVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'
}

// ---------------------------------------------------------------------------

async function collectSnapshot(
  options: ExportOptions,
): Promise<{ snapshot: ExportSnapshot; exportedAt: string }> {
  const snapshot = await fetchExportSnapshot(supabase, options)
  return { snapshot, exportedAt: new Date().toISOString() }
}

function textArtifact(filename: string, mimeType: string, text: string): ExportArtifact {
  return { filename, mimeType, blob: new Blob([text], { type: mimeType }) }
}

/**
 * Builds the lossless, versioned JSON backup artifact. Fetches its own snapshot — when you need
 * JSON and CSVs together, prefer {@link exportEverything}, which fetches once.
 */
export async function exportJsonBackup(options: ExportOptions = {}): Promise<ExportArtifact> {
  const { snapshot, exportedAt } = await collectSnapshot(options)
  const envelope = buildBackupEnvelope(snapshot, {
    exportedAt,
    appVersion: currentAppVersion(),
  })
  return textArtifact(
    jsonBackupFilename(),
    JSON_BACKUP_MIME_TYPE,
    serializeBackupEnvelope(envelope),
  )
}

/**
 * Builds every CSV analysis file. Fetches its own snapshot — prefer {@link exportEverything}
 * when the JSON backup is also wanted.
 */
export async function exportCsvArtifacts(options: ExportOptions = {}): Promise<ExportArtifact[]> {
  const { snapshot } = await collectSnapshot(options)
  const files: CsvFileContent[] = buildCsvSuite(projectionInputFromSnapshot(snapshot))
  return files.map((file) => textArtifact(file.filename, CSV_MIME_TYPE, file.text))
}

export interface FullExportResult {
  /** The versioned JSON backup alone (identical bytes to {@link exportJsonBackup}). */
  readonly jsonBackup: ExportArtifact
  /** The individual CSV files, in canonical {@link EXPORT_CSV_FILENAMES} order. */
  readonly csvFiles: readonly ExportArtifact[]
  /**
   * One ZIP containing the backup JSON, every CSV and a MANIFEST.json — the one-artifact
   * delivery option. Built with client-zip (store-only); decision record in output_35.
   */
  readonly everythingZip: ExportArtifact
}

interface ZipEntry {
  readonly name: string
  readonly input: string
}

/**
 * Fetches ONE snapshot and projects all three delivery shapes from it — never three fetches.
 */
export async function exportEverything(options: ExportOptions = {}): Promise<FullExportResult> {
  const { snapshot, exportedAt } = await collectSnapshot(options)

  const appVersion = currentAppVersion()
  const envelope = buildBackupEnvelope(snapshot, { exportedAt, appVersion })
  const backupFilename = jsonBackupFilename()
  const backupText = serializeBackupEnvelope(envelope)
  const jsonBackup = textArtifact(backupFilename, JSON_BACKUP_MIME_TYPE, backupText)

  const csvContents: CsvFileContent[] = buildCsvSuite(projectionInputFromSnapshot(snapshot))
  const csvFiles: ExportArtifact[] = csvContents.map((file) =>
    textArtifact(file.filename, CSV_MIME_TYPE, file.text),
  )

  const manifest = {
    format: BACKUP_FORMAT_ID,
    schema_version: BACKUP_SCHEMA_VERSION,
    generated_at: exportedAt,
    app_version: appVersion,
    contents: [
      { file: backupFilename, kind: 'json_backup', lossless: true },
      ...EXPORT_CSV_FILENAMES.map((name) => ({
        file: name,
        kind: 'csv_projection',
        lossless: false,
      })),
    ],
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`

  const entries: ZipEntry[] = [
    { name: backupFilename, input: backupText },
    ...csvContents.map((file) => ({ name: file.filename, input: file.text })),
    { name: 'MANIFEST.json', input: manifestText },
  ]

  // Lazy-loaded so the ZIP writer costs nothing until an Everything export actually runs.
  // client-zip v2 entry shape is { name, input } — BufferLike accepts UTF-8 strings directly.
  const { downloadZip } = await import('client-zip')
  const zipBlob = await downloadZip(entries).blob()

  return {
    jsonBackup,
    csvFiles,
    everythingZip: {
      filename: everythingZipFilename(),
      mimeType: ZIP_MIME_TYPE,
      blob: zipBlob,
    },
  }
}
