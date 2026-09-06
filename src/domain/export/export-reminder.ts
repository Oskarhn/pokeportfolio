/**
 * The periodic in-app export reminder (PRODUCT_SPEC.md §4.12: "MVP includes a periodic in-app
 * reminder to export"). Pure and storage-agnostic so it can be unit-tested without a browser.
 *
 * Cadence (D-080): the spec requires the reminder without fixing an interval; 30 days is the
 * recorded MVP default — long enough not to nag, short enough that a lost device costs at most
 * a month of ledger entries. One constant, deliberately easy to tune.
 *
 * Privacy: the stored value is a bare ISO timestamp of the last mark. No export content, no
 * financial data, no collection metadata ever touches storage.
 */

export const EXPORT_REMINDER_INTERVAL_DAYS = 30

/**
 * P111 fix: this used to be one bare, unnamespaced key shared by every account that ever signs in
 * on the same browser — user A exporting would silently satisfy (or A's stale timestamp would
 * silently misreport) user B's own reminder after a sign-out/sign-in on a shared machine. Every
 * call site now namespaces by the signed-in user's id, matching how every other piece of
 * per-user client state in this app already behaves.
 */
export function exportReminderStorageKey(userId: string): string {
  return `pokeportfolio.export.reminder-marked-at.${userId}`
}

const DAY_MS = 24 * 60 * 60 * 1000

export function shouldRemindExport(
  lastMarkedAt: string | null,
  now: Date,
  intervalDays: number = EXPORT_REMINDER_INTERVAL_DAYS,
): boolean {
  if (lastMarkedAt === null) return true
  const last = Date.parse(lastMarkedAt)
  if (Number.isNaN(last)) return true // corrupted value → remind; never silently skip
  return now.getTime() - last >= intervalDays * DAY_MS
}

export interface ReminderStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readLastReminderMark(store: ReminderStore, userId: string): string | null {
  try {
    return store.getItem(exportReminderStorageKey(userId))
  } catch {
    return null // private-mode storage failures must never break Profile rendering
  }
}

/** Marks the reminder satisfied — on a completed export or when the user dismisses it. */
export function markReminderSatisfied(
  store: ReminderStore,
  userId: string,
  now: Date = new Date(),
): void {
  try {
    store.setItem(exportReminderStorageKey(userId), now.toISOString())
  } catch {
    // Same privacy-safe degradation as above.
  }
}
