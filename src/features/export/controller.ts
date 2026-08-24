import { unwiredExportController, type ExportController } from './contract'

/**
 * P35 INTEGRATION SEAM — the one place to connect M13's UI to M13's engine.
 *
 * This branch (P36) owns the export/backup user experience and the platform file delivery, and
 * compiles independently of `src/domain/export/**` / `src/data/export/**` by design: it never
 * imports them. The parallel core branch (P35) owns data fetching and serialization.
 *
 * To integrate, replace this function's body with construction of P35's controller, e.g.
 *
 *   import { createExportController } from '../../data/export'
 *   export function getExportController(): ExportController {
 *     return createExportController()
 *   }
 *
 * …or inject any object satisfying `ExportController` (see contract.ts). Nothing else in this
 * feature needs to change: ExportPage calls `getExportController()` once per mount and every
 * action flows through the interface. Until that edit happens, actions fail honestly with
 * "Export is not available yet." — never a fabricated success.
 */
export function getExportController(): ExportController {
  return unwiredExportController
}
