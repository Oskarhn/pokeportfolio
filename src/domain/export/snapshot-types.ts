/**
 * Shared shape of one fully fetched export snapshot: every canonical user-owned section plus
 * the identity manifest. Declared here (rather than in backup-format.ts) so the format module
 * stays purely about the serialized contract while this is the in-memory working shape — they
 * are structurally identical by design, which is what makes build → validate round-trip tests
 * meaningful.
 */
import type { BackupData, BackupIdentityManifest } from './backup-format'

export type ExportSnapshot = BackupData & { readonly identity_manifest: BackupIdentityManifest }
