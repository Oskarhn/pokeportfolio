import { checksum } from '../auth/chunked-session-storage'
import type { KeyValueStore } from '../auth/chunked-session-storage'

/**
 * P180: process-death-after-commit reliability. `WriteFormStore.submit` (state/write-form-store.ts)
 * used to keep its idempotency key only in memory — a process kill between the server committing a
 * write and the app receiving the response left NOTHING to reconcile against on restart, so a
 * resumed app could only retry with a brand-new key, risking a genuine duplicate purchase/sale.
 *
 * This journal is the "bounded pending-write journal" the mission asks for. It deliberately stores
 * the MINIMUM needed to answer "did this operation already happen" — never the amounts, the card,
 * or any other financial content:
 *   - idempotencyKey  — the one thing `create_purchase`/`create_sale` themselves use to detect a
 *                        replay (P107/P138/P140); this is also how reconciliation checks existence.
 *   - operationKind   — which RPC this was, so reconciliation queries the right table.
 *   - payloadHash     — a non-secret checksum of a canonical SUMMARY of the request (currency,
 *                        operation kind, event date — never the amount), kept only as a diagnostic
 *                        aid for a person or a future session inspecting the journal; nothing here
 *                        ever reconstructs or resubmits the original amounts from it.
 *   - userId          — which identity this belongs to; `listFor` never returns another user's rows
 *                        (mission §13's A/B isolation, enforced here, not just in the UI).
 *   - createdAt       — for the bounded expiry below.
 *
 * No credentials, no card/price/quantity data, no arbitrary financial history — an entry answers
 * "is idempotency key K's write settled" and nothing else.
 */

export type PendingOperationKind = 'create_purchase' | 'create_sale'

export interface PendingWriteEntry {
  readonly idempotencyKey: string
  readonly operationKind: PendingOperationKind
  readonly payloadHash: string
  readonly userId: string
  readonly createdAt: string
}

const STORAGE_KEY = 'p180.pending-writes.v1'
/** Bounded: a runaway journal is itself a reliability risk. Oldest entries are dropped first. */
const MAX_ENTRIES = 20
/** Defensive cleanup only — every entry is expected to clear within seconds in normal operation
 *  (submit succeeds, or fails in a way that is known NOT to have committed). A week is generous
 *  enough that a person who genuinely put the phone away mid-flow is not silently forgotten, and
 *  short enough that the journal cannot accumulate indefinitely if something never reconciles. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function isPendingWriteEntry(value: unknown): value is PendingWriteEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.idempotencyKey === 'string' &&
    v.idempotencyKey !== '' &&
    (v.operationKind === 'create_purchase' || v.operationKind === 'create_sale') &&
    typeof v.payloadHash === 'string' &&
    typeof v.userId === 'string' &&
    v.userId !== '' &&
    typeof v.createdAt === 'string' &&
    !Number.isNaN(Date.parse(v.createdAt))
  )
}

/** A non-secret checksum of a canonical, flat summary object — never the amounts themselves. */
export function hashPendingPayload(material: Record<string, string | number | boolean>): string {
  const sortedKeys = Object.keys(material).sort()
  const canonical = sortedKeys.map((k) => `${k}=${String(material[k])}`).join('&')
  return checksum(canonical)
}

export class PendingWriteJournal {
  constructor(private readonly store: KeyValueStore) {}

  private async readAll(now: number): Promise<PendingWriteEntry[]> {
    const raw = await this.store.getItemAsync(STORAGE_KEY)
    if (raw === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isPendingWriteEntry)
      .filter((e) => now - Date.parse(e.createdAt) < MAX_AGE_MS)
  }

  private async writeAll(entries: readonly PendingWriteEntry[]): Promise<void> {
    // Oldest-first array, so slicing the tail keeps the MOST RECENT entries under the bound.
    await this.store.setItemAsync(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
  }

  /** Called right before a write is sent — see the class doc for why this must happen BEFORE the
   *  network call, not after. Replaces any existing entry for the same key (a retry of the same
   *  attempt re-records the identical fact, never duplicates it in the journal). */
  async record(entry: PendingWriteEntry, now = Date.now()): Promise<void> {
    const entries = await this.readAll(now)
    await this.writeAll([
      ...entries.filter((e) => e.idempotencyKey !== entry.idempotencyKey),
      entry,
    ])
  }

  /** Called once an attempt's fate is KNOWN — either it definitely committed (reconciled) or it
   *  definitely did not reach the server (a validation/auth failure before any commit could have
   *  happened). Never called for an uncertain outcome — see write-form-store.ts. */
  async clear(idempotencyKey: string, now = Date.now()): Promise<void> {
    const entries = await this.readAll(now)
    await this.writeAll(entries.filter((e) => e.idempotencyKey !== idempotencyKey))
  }

  /**
   * Removes EVERY entry of one user (P189 account deletion): after the account is deleted nothing may
   * remember an uncertain operation for it, or a later session would try to reconcile or retry a
   * write for an identity that no longer exists. Other users' entries are kept.
   */
  async clearForUser(userId: string, now = Date.now()): Promise<void> {
    const entries = await this.readAll(now)
    await this.writeAll(entries.filter((e) => e.userId !== userId))
  }

  /** Never returns another user's entries. The one read path every reconciliation and UI surface
   *  must go through — no caller reads the raw store directly. */
  async listFor(userId: string, now = Date.now()): Promise<PendingWriteEntry[]> {
    return (await this.readAll(now)).filter((e) => e.userId === userId)
  }
}
