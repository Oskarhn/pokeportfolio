import { expect } from 'vitest'
import { AuthIdentityChangedError, runWithLease } from '../../src/auth/identity-lease'
import { createPurchase } from '../../src/data/purchases'
import { BIG, makeWorld, type Env } from './p147-composition-harness'

/**
 * P147 — the scenarios of the two invariants every authenticated financial write must satisfy at
 * the same time (docs/DECISIONS.md D-138):
 *
 *   1. it runs only under the identity that started it, or aborts before anything is sent;
 *   2. the amount that reaches the ledger is the amount the person entered, digit for digit.
 *
 * Each scenario is a function of an {@link Env}. tests/data/p147-leased-transport-composition.test
 * .ts runs them against the PRODUCTION composition and requires them to pass;
 * tests/data/p147-cross-track-mutations.test.ts runs the very same functions against compositions
 * with exactly one protection removed and requires each to FAIL — so a green production run cannot
 * be the result of scenarios that never look at the protection they name.
 *
 * Every assertion reads the backend's side (what was received, under which bearer, what was
 * stored); none of them asks the client whether it checked something.
 */

const KEY = '4d0e1a2e-0000-4000-8000-000000000001'

/** The page's submission: the real data function, a large amount, one accessory line. */
export function submitLargePurchase(db: Parameters<typeof createPurchase>[2], key = KEY) {
  return createPurchase(
    {
      purchasedOn: '2026-09-01',
      currency: 'NOK',
      lines: [{ lineType: 'accessory', description: 'x', quantity: 1, unitPriceMinor: BIG }],
    },
    key,
    db,
  )
}

function begin(env: Env) {
  const world = makeWorld(env.makeAuthority)
  const lease = world.authority.begin('user-a')
  const db = env.buildDb(lease, world)
  // The page runs its mutation function inside runWithLease (src/auth/useLeasedMutation.ts): a
  // failure that surfaces once the lease has ended becomes AuthIdentityChangedError.
  const submit = () => runWithLease(lease, () => submitLargePurchase(db))
  return { world, lease, db, submit }
}

/** No identity change, exact money: A's bearer on the wire, the digits intact, stored under A. */
export async function largeMoneyLeasedPurchase(env: Env): Promise<void> {
  const { world, db } = begin(env)
  const purchase = await submitLargePurchase(db)

  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.owner).toBe('user-a')
  // Sent once, as a decimal STRING: no number literal, no double quoting, no exponent.
  expect(world.requests[0]?.bodyText).toContain('"unit_price_minor":"9007199254740993"')
  expect(world.requests[0]?.bodyText).not.toMatch(/"unit_price_minor":\d/)
  expect(world.stored).toEqual([{ owner: 'user-a', key: KEY, unitPriceMinor: BIG }])
  expect(purchase.subtotalMinor).toBe(BIG)
  expect(purchase.totalNokMinor).toBe(BIG)
}

/** A raw JSON number above 2^53 must be refused before anything leaves; a string must pass. */
export async function unsafeNumberRefusedStringAccepted(env: Env): Promise<void> {
  const { world, db } = begin(env)
  const unsafe = db.rpc('create_purchase', {
    p_purchased_on: '2026-09-01',
    p_currency: 'NOK',
    p_lines: [{ line_type: 'accessory', quantity: 1, unit_price_minor: Number(BIG) }],
    p_idempotency_key: KEY,
  })
  const { error } = await unsafe
  expect(error?.message ?? '').toContain('refusing request body')
  expect(world.requests).toEqual([])
  expect(world.stored).toEqual([])

  const purchase = await submitLargePurchase(db)
  expect(purchase.subtotalMinor).toBe(BIG)
  expect(world.stored.map((s) => s.unitPriceMinor)).toEqual([BIG])
}

/**
 * A starts a large purchase; the lookup that chooses the bearer is still pending when the identity
 * becomes B. Nothing may be sent, in particular nothing under B's bearer.
 */
export async function identitySwitchBeforeDispatch(
  env: Env,
  options: { heard: boolean } = { heard: true },
): Promise<void> {
  const { world, submit } = begin(env)
  const release = world.parkNextSessionLookup()
  const outcome = submit()
  await settle(() => world.getSessionCalls >= 1)

  world.switchTo('b', { heard: options.heard })
  release()

  await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
  expect(world.requests.filter((r) => r.owner === 'user-b')).toEqual([])
  expect(world.requests).toEqual([])
  expect(world.stored).toEqual([])
}

/** Same user, new token, while the lookup is pending: completes, with the NEW token, exactly. */
export async function sameUserRefreshExactMoney(env: Env): Promise<void> {
  const { world, submit } = begin(env)
  const release = world.parkNextSessionLookup()
  const outcome = submit()
  await settle(() => world.getSessionCalls >= 1)

  world.refreshToken('a', 2)
  release()

  const purchase = await outcome
  expect(world.requests).toHaveLength(1)
  expect(world.requests[0]?.authorization).toBe('Bearer token-a-2')
  expect(world.stored).toEqual([{ owner: 'user-a', key: KEY, unitPriceMinor: BIG }])
  expect(purchase.subtotalMinor).toBe(BIG)
}

/** A -> B -> A while the lookup is pending: the session is A's again, the lease must stay dead. */
export async function aToBToAStaleLease(env: Env): Promise<void> {
  const { world, submit } = begin(env)
  const release = world.parkNextSessionLookup()
  const outcome = submit()
  await settle(() => world.getSessionCalls >= 1)

  world.switchTo('b')
  world.switchTo('a')
  release()

  await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
  expect(world.requests).toEqual([])
  expect(world.stored).toEqual([])
}

/** A signs out while the lookup is pending: no later write is dispatched. */
export async function signedOutPendingMutation(env: Env): Promise<void> {
  const { world, submit } = begin(env)
  const release = world.parkNextSessionLookup()
  const outcome = submit()
  await settle(() => world.getSessionCalls >= 1)

  world.session = null
  world.authority.observe(null)
  release()

  await expect(outcome).rejects.toBeInstanceOf(AuthIdentityChangedError)
  expect(world.requests).toEqual([])
  expect(world.stored).toEqual([])
}

/** Wait (bounded, no timers) until `condition` holds; the world only advances on microtasks. */
export async function settle(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error('the operation never reached the awaited step')
}
