/**
 * The M13 export core's PUBLIC integration boundary (P35 → P36).
 *
 * P36 (delivery UI) integrates against THIS module and nothing else from the export core:
 *
 *   import {
 *     exportJsonBackup,      // one lossless versioned .json backup artifact
 *     exportCsvArtifacts,    // ten analysis .csv artifacts
 *     exportEverything,      // ONE fetch → { jsonBackup, csvFiles, everythingZip }
 *     type ExportArtifact,   // { filename, mimeType, blob } — hand each to the delivery layer
 *     type ExportOptions,    // { signal?, pageSize?, maxPages?, onPage? }
 *     type FullExportResult,
 *   } from '../../data/export'
 *
 * Contract notes for P36:
 * - Every operation resolves the exporting identity from the SESSION. There is no user-id
 *   parameter and there must never be one — RLS is the authority.
 * - Blobs are complete before the promise resolves; delivery (share sheet / anchor / picker)
 *   is entirely P36's surface.
 * - `signal` aborts between fetch pages; the rejection is a DOMException named 'AbortError'.
 *   `onPage` reports { section, totalRows } as pages land; render progress from it.
 * - CSV texts carry their UTF-8 BOM already; do not prepend another.
 * - No restore exists in M13 — never imply otherwise in UI copy.
 */
export {
  exportJsonBackup,
  exportCsvArtifacts,
  exportEverything,
  jsonBackupFilename,
  everythingZipFilename,
  JSON_BACKUP_MIME_TYPE,
  CSV_MIME_TYPE,
  ZIP_MIME_TYPE,
} from './artifacts'
export type { ExportArtifact, ExportOptions, FullExportResult } from './artifacts'
