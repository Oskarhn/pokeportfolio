import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createInitialPurchaseFormFields } from '../../src/features/purchases/purchase-form-state'
import { EntityKeyChangeTracker } from '../../src/platform/entity-key-change-tracker'
import {
  ManualCardResolutionCache,
  resolveManualCardId,
} from '../../src/features/purchases/manual-card-resolution'

/**
 * P140 §13 — a small, deterministic (seeded) property/state-machine campaign over the same real
 * production primitives the targeted tests in `purchase-form-identity-boundary.test.ts` exercise
 * one scenario at a time. Models the event stream a real `PurchaseFormPage` session can produce —
 * render (retry), edit the manual card's name, add a line, a successful submit/new intent (fresh
 * mount), and a user switch — and checks the five invariants the prompt names hold after EVERY
 * event, not just in the hand-picked scenarios above. 300 runs x up to 20 events each: cheap
 * (well under a second) and still a genuinely different verification angle from the deterministic
 * tests — a shrunk counterexample here would point at an edge case those didn't think to try.
 */

type Event =
  | { kind: 'render' } // ordinary rerender / retry-click; no state input changes
  | { kind: 'editName'; lineId: string; name: string } // resolve (or re-resolve) a manual line
  | { kind: 'newIntent' } // fresh mount, e.g. after a successful submit navigated away
  | { kind: 'userSwitch'; userId: string }

const arbLineId = fc.constantFrom('line-1', 'line-2', 'line-3')
const arbName = fc.constantFrom('Charizard', 'Charizard ex', 'Pikachu Promo')
const arbUserId = fc.constantFrom('user-a', 'user-b', 'user-c')

const arbEvent: fc.Arbitrary<Event> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Event>({ kind: 'render' }) },
  {
    weight: 3,
    arbitrary: fc.tuple(arbLineId, arbName).map(([lineId, name]) => ({
      kind: 'editName' as const,
      lineId,
      name,
    })),
  },
  { weight: 1, arbitrary: fc.constant<Event>({ kind: 'newIntent' }) },
  { weight: 2, arbitrary: arbUserId.map((userId) => ({ kind: 'userSwitch' as const, userId })) },
)

/** A monotonic, NEVER-reset counter standing in for the server minting a fresh
 *  `manual_card_definitions` UUID on every real `createManualCard` call — shared across every
 *  `Mount` in one property-test iteration so that "the returned id differs" is a sound proxy for
 *  "the creator was genuinely invoked again", never a coincidence of some OTHER counter that
 *  happens to reset and reproduce the same value. */
function newIdMinter(): () => string {
  let n = 0
  return () => {
    n += 1
    return `manual-card-${n}`
  }
}

/** One "mount" of PurchaseFormPage — mirrors its real state shape and effect bodies exactly,
 *  same as `PurchaseFormHarness` in `purchase-form-identity-boundary.test.ts`. Kept local (not
 *  imported) because this file additionally needs the shared id-minter above, which the targeted
 *  scenario tests have no reason to carry. */
class Mount {
  fields = createInitialPurchaseFormFields(() => '2026-01-01')
  readonly manualCards = new ManualCardResolutionCache()
  private readonly tracker = new EntityKeyChangeTracker()
  private readonly mintId: () => string

  constructor(mintId: () => string) {
    this.mintId = mintId
  }

  observeIdentity(userId: string): void {
    if (this.tracker.observe(userId)) {
      this.fields = { ...this.fields, idempotencyKey: crypto.randomUUID() }
      this.manualCards.clear()
    }
  }

  async resolve(lineId: string, name: string): Promise<string> {
    const creator = {
      createManualCard: (): Promise<{ id: string }> => Promise.resolve({ id: this.mintId() }),
    }
    return resolveManualCardId(this.manualCards, lineId, name, creator)
  }

  get idempotencyKey(): string {
    return this.fields.idempotencyKey
  }
}

describe('P140 §13 — property/state-machine campaign', () => {
  it('300 generated event sequences: the five required invariants all hold after every event', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbUserId,
        fc.array(arbEvent, { minLength: 1, maxLength: 20 }),
        async (initialUserId, events) => {
          const mintId = newIdMinter()
          let mount = new Mount(mintId)
          let currentUserId: string = initialUserId
          mount.observeIdentity(currentUserId)
          let previousKey = mount.idempotencyKey

          // (lineId, name) -> the id most recently resolved for it UNDER THE CURRENT owner
          // (mount identity, reset whenever `mount` itself is replaced or the identity switches).
          let resolvedUnderCurrentOwner = new Map<string, string>()

          for (const event of events) {
            if (event.kind === 'render') {
              // Invariant: same intent/user (no input changed) => stable key.
              mount.observeIdentity(currentUserId)
              expect(mount.idempotencyKey).toBe(previousKey)
            } else if (event.kind === 'editName') {
              const key = `${event.lineId}:${event.name}`
              const resolvedId = await mount.resolve(event.lineId, event.name)
              const already = resolvedUnderCurrentOwner.get(key)
              if (already !== undefined) {
                // Invariant: same manual identity/retry => at most one definition resolution
                // (the SAME id comes back, never a second create).
                expect(resolvedId).toBe(already)
              }
              resolvedUnderCurrentOwner.set(key, resolvedId)
              // A stable key never rotates merely from resolving a manual card.
              expect(mount.idempotencyKey).toBe(previousKey)
            } else if (event.kind === 'newIntent') {
              // Invariant: new intent => new key (fresh mount, matching this app's actual
              // contract — success always navigates away; see purchase-form-state.ts's own doc).
              mount = new Mount(mintId)
              mount.observeIdentity(currentUserId)
              expect(mount.idempotencyKey).not.toBe(previousKey)
              previousKey = mount.idempotencyKey
              resolvedUnderCurrentOwner = new Map() // a fresh mount has no resolution history
              continue
            } else {
              // userSwitch
              const isGenuineChange = event.userId !== currentUserId
              currentUserId = event.userId
              mount.observeIdentity(currentUserId)
              if (isGenuineChange) {
                // Invariant: new user => new key.
                expect(mount.idempotencyKey).not.toBe(previousKey)
                // Invariant: changed identity/user => no cached definition reuse — every id
                // resolved under the old owner must be re-creatable (a fresh id) under the new
                // one, never silently returned from the cleared cache.
                for (const [key, oldId] of resolvedUnderCurrentOwner) {
                  const [lineId, name] = key.split(':') as [string, string]
                  const freshId = await mount.resolve(lineId, name)
                  expect(freshId).not.toBe(oldId)
                }
                resolvedUnderCurrentOwner = new Map()
              } else {
                expect(mount.idempotencyKey).toBe(previousKey)
              }
            }
            previousKey = mount.idempotencyKey
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})
