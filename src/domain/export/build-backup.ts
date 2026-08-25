/**
 * Serializes one fetched export snapshot into the versioned M13 backup envelope (pure).
 *
 * Determinism rules: envelope and section keys serialize in the fixed order declared in
 * backup-format.ts; row objects are built field-by-field by the data-layer mappers in column
 * order, so two exports of identical data differ only in `exported_at`. Nothing is recomputed,
 * rounded, re-currency-converted or re-ordered at this boundary.
 */
import {
  BACKUP_DATA_KEYS,
  BACKUP_FORMAT_ID,
  BACKUP_SCHEMA_VERSION,
  MANIFEST_COUNT_KEY_PREFIX,
  type BackupCounts,
  type BackupDataKey,
  type BackupEnvelope,
} from './backup-format'
import type { ExportSnapshot } from './snapshot-types'

export interface BackupBuildOptions {
  /** RFC 3339 UTC instant, e.g. new Date().toISOString(). */
  readonly exportedAt: string
  /** The same build string Profile shows (__APP_VERSION__). */
  readonly appVersion: string
}

function countSections(data: ExportSnapshot): BackupCounts {
  const counts: Record<string, number> = {}
  for (const key of BACKUP_DATA_KEYS) {
    // Every section is a uniform array whose length IS the row count.
    counts[key] = (data[key] as readonly unknown[]).length
  }
  counts[`${MANIFEST_COUNT_KEY_PREFIX}card_variants`] = data.identity_manifest.card_variants.length
  counts[`${MANIFEST_COUNT_KEY_PREFIX}curated_sealed_products`] =
    data.identity_manifest.curated_sealed_products.length
  counts[`${MANIFEST_COUNT_KEY_PREFIX}card_sets`] = data.identity_manifest.card_sets.length
  return counts
}

/**
 * Builds the full envelope object with keys in canonical order, then serializes it. Returns the
 * exact text that becomes the .json artifact.
 */
export function buildBackupEnvelope(
  data: ExportSnapshot,
  options: BackupBuildOptions,
): BackupEnvelope {
  // Re-assemble `data` in BACKUP_DATA_KEYS order so serialization never depends on the order
  // the fetchers happened to complete in.
  const ordered = Object.fromEntries(BACKUP_DATA_KEYS.map((key) => [key, data[key]])) as Record<
    BackupDataKey,
    unknown
  >
  return {
    format: BACKUP_FORMAT_ID,
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: options.exportedAt,
    app: { version: options.appVersion },
    counts: countSections(data),
    data: ordered as ExportSnapshot,
    identity_manifest: {
      card_variants: [...data.identity_manifest.card_variants],
      curated_sealed_products: [...data.identity_manifest.curated_sealed_products],
      card_sets: [...data.identity_manifest.card_sets],
    },
  }
}

export function serializeBackupEnvelope(envelope: BackupEnvelope): string {
  return `${JSON.stringify(envelope)}\n`
}
