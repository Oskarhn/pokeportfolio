import {
  exportCsvArtifacts,
  exportJsonBackup,
} from '../../data/export'
import type { ExportArtifact, ExportController, ExportProgressListener } from './contract'

/**
 * The REAL P35↔P36 seam (M13 integration): the UI's ExportController contract satisfied by the
 * export core in src/data/export. This is the only file that knows both halves.
 *
 * Progress mapping: the core reports {section,totalRows} per landed page; the UI contract wants
 * coarse phases only — 'preparing' until the first rows land, 'creating-files' afterwards.
 * No phase is fabricated before that point and no percentage is invented (prompt §12).
 *
 * Each action performs exactly one snapshot fetch of its own; the two actions are never
 * combined into a hidden double-fetch. Empty accounts still produce their full artifacts (a
 * valid envelope / header-only CSV files), so an empty result array here means a genuine core
 * defect, not "nothing to export".
 */

function toFeatureArtifacts(
  files: readonly { filename: string; blob: Blob }[],
): ExportArtifact[] {
  return files.map(({ filename, blob }) => ({ filename, blob }))
}

function progressFor(onProgress?: ExportProgressListener) {
  let sawRows = false
  return () => {
    if (!sawRows && onProgress) {
      sawRows = true
      onProgress('creating-files')
    }
  }
}

const wiredExportController: ExportController = {
  async createBackup(onProgress?: ExportProgressListener): Promise<ExportArtifact[]> {
    onProgress?.('preparing')
    const onPage = progressFor(onProgress)
    const artifact = await exportJsonBackup({ onPage })
    return toFeatureArtifacts([artifact])
  },

  async createCsvExport(onProgress?: ExportProgressListener): Promise<ExportArtifact[]> {
    onProgress?.('preparing')
    const onPage = progressFor(onProgress)
    const artifacts = await exportCsvArtifacts({ onPage })
    return toFeatureArtifacts(artifacts)
  },
}

export function getExportController(): ExportController {
  return wiredExportController
}
