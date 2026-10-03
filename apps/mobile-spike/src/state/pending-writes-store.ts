import type { IdentityAuthority } from '../auth/identity-authority'
import type { PendingWriteEntry, PendingWriteJournal } from '../write/pending-write-journal'
import {
  reconcilePendingWrites,
  type ExistsCheckerMap,
} from '../write/pending-write-reconciliation'
import { Emitter, type Resettable } from './registry'

/**
 * P180: the current identity's unresolved pending writes, reconciled on every registry reset — a
 * real identity change (including the very first sign-in of a fresh process, which is exactly when
 * a process-death-recovered app needs this) resets every registered store synchronously
 * (registry.ts), so this store's list is cleared to empty for the NEW identity before that
 * identity's first render, then refilled once reconciliation actually answers "which of MY pending
 * entries are still unresolved" — never, even for one frame, another identity's entries (mission
 * §13: A -> B must never see A's pending operation).
 */
export interface PendingWritesState {
  userId: string | null
  unresolved: readonly PendingWriteEntry[]
}

export class PendingWritesStore implements Resettable {
  private state: PendingWritesState = { userId: null, unresolved: [] }
  private readonly emitter = new Emitter()
  /** Guards a reconciliation read that resolves after a LATER reset has already moved to a
   *  different identity — that stale result must never overwrite the newer identity's list. */
  private seq = 0

  constructor(
    private readonly authority: IdentityAuthority,
    private readonly journal: PendingWriteJournal,
    private readonly existsCheckers: ExistsCheckerMap,
  ) {}

  subscribe = this.emitter.subscribe
  getSnapshot = (): PendingWritesState => this.state

  private set(next: PendingWritesState): void {
    this.state = next
    this.emitter.emit()
  }

  reset(): void {
    const mySeq = (this.seq += 1)
    const userId = this.authority.userId
    this.set({ userId, unresolved: [] })
    if (userId === null) return
    void reconcilePendingWrites(this.journal, userId, this.existsCheckers).then((outcome) => {
      if (mySeq !== this.seq) return
      this.set({ userId, unresolved: outcome.unresolved })
    })
  }

  /** True when THIS identity has an unresolved entry of the given kind — the write screens use
   *  this to decide whether to show the "a previous attempt is unresolved" notice. */
  hasUnresolved(operationKind: PendingWriteEntry['operationKind']): boolean {
    return this.state.unresolved.some((e) => e.operationKind === operationKind)
  }
}
