import type {
  PendingOperationKind,
  PendingWriteEntry,
  PendingWriteJournal,
} from './pending-write-journal'
import type { WriteExistsChecker } from './pending-write-exists'

/**
 * "Reconcile before blindly repeating" (mission §9/§13): for every pending entry belonging to
 * `userId` — never another identity's — ask whether the operation it describes already exists.
 * Found -> the entry is cleared (settled; no duplicate risk, nothing here creates or retries
 * anything). Confirmed absent, or the check itself failed (offline, etc.) -> the entry is left
 * exactly as it is and reported `unresolved`; this module NEVER auto-retries, because the journal
 * deliberately does not hold enough to safely reconstruct the original request (see
 * pending-write-journal.ts's header) — only a person re-entering the form, or a future session with
 * the full request, can safely decide what happens next.
 */

export interface ReconciliationOutcome {
  readonly resolved: readonly PendingWriteEntry[]
  readonly unresolved: readonly PendingWriteEntry[]
}

export type ExistsCheckerMap = Readonly<Record<PendingOperationKind, WriteExistsChecker>>

export async function reconcilePendingWrites(
  journal: PendingWriteJournal,
  userId: string,
  existsCheckers: ExistsCheckerMap,
): Promise<ReconciliationOutcome> {
  const entries = await journal.listFor(userId)
  const resolved: PendingWriteEntry[] = []
  const unresolved: PendingWriteEntry[] = []
  for (const entry of entries) {
    try {
      const exists = await existsCheckers[entry.operationKind](entry.idempotencyKey)
      if (exists) {
        await journal.clear(entry.idempotencyKey)
        resolved.push(entry)
      } else {
        unresolved.push(entry)
      }
    } catch {
      unresolved.push(entry)
    }
  }
  return { resolved, unresolved }
}
