/**
 * Per-test-file session pool and the one acceptance rule every test in this package applies:
 *
 *   an operation either SUCCEEDS and leaves every invariant intact,
 *   or is REFUSED with a stable domain error and changes nothing.
 *
 * Which of the two a fixed implementation chooses for an ambiguous case (for example a quantity
 * edit on a split line) is not asserted. Silent corruption, a raw constraint violation, a deadlock
 * or an unexpected error are always failures.
 */
import { inject } from 'vitest'
import type { PgSession } from './docker-pg'
import {
  actAs,
  classify,
  createUser,
  describeOutcome,
  openAdmin,
  openUserSession,
  readCatalog,
  snapshot,
  type Catalog,
  type Outcome,
  type Snapshot,
} from './ledger'
import {
  checkInvariants,
  formatViolations,
  newModel,
  recordRemovals,
  type LedgerModel,
  type Violation,
} from './invariants'
import { resetSessions } from './concurrency'

export interface FileContext {
  container: string
  admin: PgSession
  observer: PgSession
  a: PgSession
  b: PgSession
  catalog: Catalog
  close(): Promise<void>
  reset(): Promise<void>
}

export async function openFileContext(label: string): Promise<FileContext> {
  const container = inject('p132cContainer')
  const admin = await openAdmin(container, `${label}_admin`)
  const observer = await openAdmin(container, `${label}_obs`)
  const a = await openUserSession(container, `${label}_a`)
  const b = await openUserSession(container, `${label}_b`)
  const catalog = await readCatalog(admin)
  const all = [admin, observer, a, b]
  return {
    container,
    admin,
    observer,
    a,
    b,
    catalog,
    reset: () => resetSessions(all),
    close: async () => {
      await resetSessions(all).catch(() => {})
      for (const s of all) await s.close()
    },
  }
}

export interface UserContext {
  userId: string
  model: LedgerModel
  snap(): Promise<Snapshot>
}

/** Fresh synthetic user; both user sessions act as that user (same owner, two devices). */
export async function newUser(ctx: FileContext, label: string): Promise<UserContext> {
  const userId = await createUser(ctx.admin, label)
  await actAs(ctx.a, userId)
  await actAs(ctx.b, userId)
  return { userId, model: newModel(), snap: () => snapshot(ctx.admin, userId) }
}

export class AcceptanceError extends Error {}

/**
 * Applies the acceptance rule to one operation whose before/after snapshots bracket it and nothing
 * else. Returns the outcome for the caller's own, more specific assertions.
 */
export function judge(
  label: string,
  outcome: Outcome,
  before: Snapshot,
  after: Snapshot,
  model: LedgerModel,
  tolerate: ReadonlySet<string> = new Set(),
): Violation[] {
  if (outcome.kind === 'ok') {
    // Judge what THIS operation broke: a violation already present before it (left by an earlier,
    // tolerated defect) is not attributed to it again.
    const key = (v: Violation) => `${v.code}|${v.detail}`
    const prior = new Set(checkInvariants(before, model).map(key))
    recordRemovals(before, after, model)
    const introduced = checkInvariants(after, model).filter((v) => !prior.has(key(v)))
    const fatal = introduced.filter((v) => !tolerate.has(v.code))
    if (fatal.length > 0) {
      throw new AcceptanceError(
        `${label}: succeeded but corrupted the ledger:\n${formatViolations(fatal)}`,
      )
    }
    return introduced
  }
  if (outcome.kind === 'domain_rejection' || outcome.kind === 'retryable_conflict') {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new AcceptanceError(
        `${label}: refused (${describeOutcome(outcome)}) but the ledger changed`,
      )
    }
    return []
  }
  throw new AcceptanceError(
    `${label}: ${describeOutcome(outcome)} is neither success nor a stable domain rejection`,
  )
}

/** Runs one statement on `session` bracketed by snapshots and judges it. */
export async function step(
  session: PgSession,
  user: UserContext,
  label: string,
  sql: string,
  tolerate?: ReadonlySet<string>,
): Promise<{ outcome: Outcome; before: Snapshot; after: Snapshot; tolerated: Violation[] }> {
  const before = await user.snap()
  const outcome = classify(await session.exec(sql))
  const after = await user.snap()
  const tolerated = judge(label, outcome, before, after, user.model, tolerate)
  return { outcome, before, after, tolerated }
}

/** A fixture step that must succeed (setup, not the behaviour under test). */
export async function must(session: PgSession, sql: string): Promise<string> {
  return session.value(sql)
}

export function assertInvariants(label: string, snap: Snapshot, model: LedgerModel): void {
  const violations = checkInvariants(snap, model)
  if (violations.length > 0) {
    throw new AcceptanceError(`${label}:\n${formatViolations(violations)}`)
  }
}
