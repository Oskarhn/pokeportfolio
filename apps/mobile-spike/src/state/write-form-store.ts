import {
  runWithLease,
  type IdentityAuthority,
  type IdentityLease,
} from '../auth/identity-authority'
import { classifyFailure, type Failure, type FailureKind } from '../net/failure'
import { generateIdempotencyKey } from '../write/idempotency-key'
import type { LeasedWriteDb } from '../write/leased-write-client'
import {
  hashPendingPayload,
  type PendingOperationKind,
  type PendingWriteJournal,
} from '../write/pending-write-journal'
import type { WriteDbBinder } from '../write/write-db'
import { Emitter, type Resettable } from './registry'

/**
 * P180: a failure kind is "uncertain" when the request may have reached and even committed at the
 * server before the failure surfaced — offline/server/unknown are exactly `net/failure.ts`'s own
 * RETRYABLE set, and `identity_changed` is added here because `runWithLease` can wrap a failure
 * that surfaced AFTER the network call was already sent (see write-form-store's own class doc).
 * Every other kind (unauthorized/forbidden/not_found/request_rejected/write_refused/
 * unsafe_numeric/credentials_unavailable) happens before any request is sent, or is a definite
 * rejection the server processed and rolled back — never a "maybe committed" state.
 */
const UNCERTAIN_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set([
  'offline',
  'server',
  'unknown',
  'identity_changed',
])

export interface PendingWriteConfig<TDraft> {
  journal: PendingWriteJournal
  operationKind: PendingOperationKind
  /** A canonical, non-secret SUMMARY of the draft for the journal's diagnostic hash — never the
   *  money amounts (see pending-write-journal.ts's header). */
  summarize: (draft: TDraft) => Record<string, string | number | boolean>
}

/**
 * Generic identity-scoped write-form state (P175): one instance per financial write screen (add
 * acquisition, record purchase, record sale, manual valuation). Registered in the runtime's
 * `ScopedRegistry`, so `reset()` — a FRESH draft, a FRESH idempotency key, no status, no result —
 * runs synchronously on every real identity change:
 *
 *   A draft under A -> B switches         gone before B's first render (registry reset, synchronous)
 *   A -> B -> A                           the SECOND A gets a brand-new instance's worth of state,
 *                                         never the first A's leftover draft or idempotency key
 *   same-user token refresh               `reset()` is NOT called (no real identity change), so the
 *                                         draft and its key survive exactly as typed
 *   sign-out                              same path as A -> B (signed-out is also a real change)
 *
 * `submit` takes the lease AT THE MOMENT the person confirms (`authority.begin(renderedUserId)`,
 * never `authority.userId` — a stale screen must not silently adopt whatever identity is current),
 * builds ONE `LeasedWriteDb` for that lease, and runs the caller's RPC call through `runWithLease`
 * semantics (enforced inside `leased-write-client.ts`'s accessToken provider, not repeated here).
 * A successful write's `idempotencyKey` is rotated afterwards (so a second, deliberate submission
 * from the same still-open screen is a NEW logical write, never a silent no-op replay of the first);
 * a FAILED attempt keeps the same key, so retrying really is a retry of the same attempt.
 */

export interface WriteFormState<TDraft> {
  /** `uncertain` (P180): the request failed in a way that does NOT prove the server never
   *  committed it (offline, a 5xx, an identity-changed wrapper around an in-flight request). Never
   *  shown as a plain "failed" — the pending-write journal entry survives so a later reconciliation
   *  pass can tell whether it actually went through, and the same idempotency key is kept so a
   *  manual retry from this same form instance is still safe. */
  status: 'editing' | 'submitting' | 'success' | 'error' | 'uncertain'
  draft: TDraft
  idempotencyKey: string
  failure: Failure | null
}

export class WriteFormStore<TDraft extends { contextKey: string }, TResult> implements Resettable {
  private state: WriteFormState<TDraft>
  private readonly emitter = new Emitter()
  /** Guards against a stale in-flight submit's result landing after a newer one started (distinct
   *  from identity leasing: this also covers the SAME identity submitting twice in a row). */
  private seq = 0

  constructor(
    private readonly authority: IdentityAuthority,
    private readonly initialDraft: () => TDraft,
    /** Builds the lease-scoped write client. Injected (never imported ambiently) so this store —
     *  and everything above it, up to `createRuntime` — stays usable with any Supabase session:
     *  the app's real one, the backend test harness's real one, or a fake. */
    private readonly writeDb: WriteDbBinder,
    /** P180: optional so every OTHER write form (acquisition/manual-valuation/opening) is
     *  unaffected — wired for `purchase`/`sale` only in `createRuntime`, the two RPCs a
     *  reconciliation existence-check currently covers (see pending-write-exists.ts). */
    private readonly pending?: PendingWriteConfig<TDraft>,
  ) {
    this.state = {
      status: 'editing',
      draft: initialDraft(),
      idempotencyKey: generateIdempotencyKey(),
      failure: null,
    }
  }

  subscribe = this.emitter.subscribe

  getSnapshot = (): WriteFormState<TDraft> => this.state

  private set(next: Partial<WriteFormState<TDraft>>): void {
    this.state = { ...this.state, ...next }
    this.emitter.emit()
  }

  reset(): void {
    this.seq += 1
    this.state = {
      status: 'editing',
      draft: this.initialDraft(),
      idempotencyKey: generateIdempotencyKey(),
      failure: null,
    }
    this.emitter.emit()
  }

  /**
   * Called from a screen's mount/param-change effect: starts a fresh draft (and a fresh
   * idempotency key) unless one already in progress belongs to the SAME entity (`contextKey`),
   * so navigating away to pick a lot and back does not discard what the person already typed, but
   * opening the form for a DIFFERENT card/holding never shows the previous one's leftover values.
   */
  ensureContext(freshDraft: () => TDraft): void {
    const nextKey = freshDraft().contextKey
    if (this.state.draft.contextKey === nextKey) return
    this.seq += 1
    this.state = {
      status: 'editing',
      draft: freshDraft(),
      idempotencyKey: generateIdempotencyKey(),
      failure: null,
    }
    this.emitter.emit()
  }

  /** No write happens merely by constructing or opening a form — only `updateDraft`/`submit`
   *  mutate state, and `updateDraft` never calls the network. */
  updateDraft(patch: Partial<TDraft>): void {
    if (this.state.status === 'submitting') return
    this.set({ draft: { ...this.state.draft, ...patch }, status: 'editing', failure: null })
  }

  /**
   * `renderedUserId`: the identity the CONFIRM button itself was rendered under (from the screen's
   * own `useStore(runtime.auth)`), not read back from the authority — see the class doc for why.
   */
  async submit(
    renderedUserId: string | null,
    action: (db: LeasedWriteDb, draft: TDraft, idempotencyKey: string) => Promise<TResult>,
  ): Promise<{ ok: true; value: TResult } | { ok: false; failure: Failure }> {
    if (this.state.status === 'submitting') {
      return { ok: false, failure: classifyFailure(new Error('already submitting')) }
    }
    const mySeq = (this.seq += 1)
    const lease: IdentityLease = this.authority.begin(renderedUserId)
    const idempotencyKey = this.state.idempotencyKey
    const draft = this.state.draft
    this.set({ status: 'submitting', failure: null })
    // P180: recorded BEFORE the network call, not after — a process kill during the request must
    // still leave a journal entry to reconcile against on restart. renderedUserId is the identity
    // the screen itself was rendered under, the same one every other identity check in this class
    // uses (never authority.userId read back later).
    if (this.pending !== undefined && renderedUserId !== null) {
      await this.pending.journal.record({
        idempotencyKey,
        operationKind: this.pending.operationKind,
        payloadHash: hashPendingPayload(this.pending.summarize(draft)),
        userId: renderedUserId,
        createdAt: new Date().toISOString(),
      })
    }
    try {
      // `runWithLease`: refuses to even start when the lease is already dead (a stale screen's
      // Confirm must not reach the write client at all), and turns a failure that surfaces after
      // the identity ended into the fixed AuthIdentityChangedError rather than a raw error.
      const value = await runWithLease(lease, () =>
        action(this.writeDb(lease), draft, idempotencyKey),
      )
      if (mySeq !== this.seq)
        return { ok: false, failure: classifyFailure(new Error('superseded')) }
      // Settled successfully: the pending entry's job is done.
      if (this.pending !== undefined) await this.pending.journal.clear(idempotencyKey)
      // A fresh key for the NEXT logical write; the just-used one stays valid for the RPC's own
      // idempotent-replay window (nothing here deletes or invalidates it server-side).
      this.set({ status: 'success', idempotencyKey: generateIdempotencyKey() })
      return { ok: true, value }
    } catch (error) {
      if (mySeq !== this.seq) return { ok: false, failure: classifyFailure(error) }
      const failure = classifyFailure(error)
      const uncertain = this.pending !== undefined && UNCERTAIN_FAILURE_KINDS.has(failure.kind)
      if (this.pending !== undefined && !uncertain) {
        // A definite failure: the server never committed this attempt (a validation/auth
        // rejection, or a request that was never even sent) — safe to clear.
        await this.pending.journal.clear(idempotencyKey)
      }
      // Uncertain: the journal entry survives, and the idempotency key is NOT rotated (unchanged
      // from the pre-P180 "a failed attempt keeps the same key" behaviour) — a manual retry from
      // this same form instance reuses it, so the RPC's own idempotent-replay rule protects
      // against a duplicate even if the first attempt actually did commit.
      this.set({ status: uncertain ? 'uncertain' : 'error', failure })
      return { ok: false, failure }
    }
  }
}
