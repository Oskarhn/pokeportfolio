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
import { buildBackupEnvelope, serializeBackupEnvelope } from '../../domain/export/build-backup'
import {
  buildCsvSuite,
  projectionInputFromSnapshot,
  type CsvFileContent,
} from '../../domain/export/csv-projections'
import type { ExportSnapshot } from '../../domain/export/snapshot-types'
import { supabase } from '../supabase-client'
import { fetchExportSnapshot, type ExportFetchOptions } from './fetch-snapshot'
import { localTodayIso } from '../../platform/local-date'

/** One finished, downloadable file. No streams, no partial state, no server round trips. */
export interface ExportArtifact {
  readonly filename: string
  readonly mimeType: string
  readonly blob: Blob
}

export type ExportOptions = ExportFetchOptions

export const JSON_BACKUP_MIME_TYPE = 'application/json'
export const CSV_MIME_TYPE = 'text/csv;charset=utf-8'

const todayStamp = localTodayIso

export function jsonBackupFilename(stamp: string = todayStamp()): string {
  return `pokeportfolio-backup-${stamp}.json`
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
 * Builds the lossless, versioned JSON backup artifact. Fetches its own snapshot.
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
 * Builds every CSV analysis file. Fetches its own snapshot.
 */
export async function exportCsvArtifacts(options: ExportOptions = {}): Promise<ExportArtifact[]> {
  const { snapshot } = await collectSnapshot(options)
  const files: CsvFileContent[] = buildCsvSuite(projectionInputFromSnapshot(snapshot))
  return files.map((file) => textArtifact(file.filename, CSV_MIME_TYPE, file.text))
}
