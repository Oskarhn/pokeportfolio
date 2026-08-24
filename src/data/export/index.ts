/**
 * The M13 export core's PUBLIC integration boundary.
 *
 * Consumers integrate against THIS module and nothing else from the export core:
 *
 *   import {
 *     exportJsonBackup,      // one lossless versioned .json backup artifact
 *     exportCsvArtifacts,    // ten analysis .csv artifacts
 *     type ExportArtifact,   // { filename, mimeType, blob } — hand each to the delivery layer
 *     type ExportOptions,    // { signal?, pageSize?, maxPages?, onPage? }
 *   } from '../../data/export'
 *
 * Contract notes:
 * - Every operation resolves the exporting identity from the SESSION. There is no user-id
 *   parameter and there must never be one — RLS is the authority.
 * - Blobs are complete before the promise resolves; delivery (share sheet / anchor / picker)
 *   is entirely the UI feature's surface (src/features/export/).
 * - `signal` aborts between fetch pages; the rejection is a DOMException named 'AbortError'.
 *   `onPage` reports { section, totalRows } as pages land; render progress from it.
 * - CSV texts carry their UTF-8 BOM already; do not prepend another.
 * - No restore exists in M13 — never imply otherwise in UI copy.
 * - There is deliberately no combined "everything" export: PRODUCT_SPEC §4.12's M13 surface is
 *   the CSV suite plus the JSON backup, each fetched on its own action (D-074). client-zip was
 *   evaluated and removed again at integration because no exposed flow needs a ZIP.
 */
export {
  exportJsonBackup,
  exportCsvArtifacts,
  jsonBackupFilename,
  JSON_BACKUP_MIME_TYPE,
  CSV_MIME_TYPE,
} from './artifacts'
export type { ExportArtifact, ExportOptions } from './artifacts'
