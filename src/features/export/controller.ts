import { exportCsvArtifacts, exportJsonBackup } from '../../data/export'
import { leasedDb } from '../../data/leased-db'
import { type IdentityLease } from '../../auth/identity-lease'
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

function toFeatureArtifacts(files: readonly { filename: string; blob: Blob }[]): ExportArtifact[] {
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

/** The lease is optional in the contract only so test doubles need not care; the wired controller
 *  refuses to run without one (P145) rather than fall back to the shared client. */
function requireLease(lease: IdentityLease | undefined): IdentityLease {
  if (lease === undefined) throw new Error('An export needs an identity lease.')
  return lease
}

const wiredExportController: ExportController = {
  async createBackup(
    onProgress?: ExportProgressListener,
    lease?: IdentityLease,
  ): Promise<ExportArtifact[]> {
    const db = leasedDb(requireLease(lease))
    onProgress?.('preparing')
    const onPage = progressFor(onProgress)
    const artifact = await exportJsonBackup({ onPage }, db)
    return toFeatureArtifacts([artifact])
  },

  async createCsvExport(
    onProgress?: ExportProgressListener,
    lease?: IdentityLease,
  ): Promise<ExportArtifact[]> {
    const db = leasedDb(requireLease(lease))
    onProgress?.('preparing')
    const onPage = progressFor(onProgress)
    const artifacts = await exportCsvArtifacts({ onPage }, db)
    return toFeatureArtifacts(artifacts)
  },
}

export function getExportController(): ExportController {
  return wiredExportController
}
