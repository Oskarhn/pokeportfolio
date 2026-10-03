import { describe, expect, it, vi } from 'vitest'
import { IdentityAuthority } from '../../src/auth/identity-lease'
import { buildMutantDb, BIG, makeWorld, productionEnv, type Env } from './p147-composition-harness'
import {
  aToBToAStaleLease,
  identitySwitchBeforeDispatch,
  largeMoneyLeasedPurchase,
  sameUserRefreshExactMoney,
  unsafeNumberRefusedStringAccepted,
} from './p147-composition-scenarios'

vi.mock('../../src/data/supabase-client', () => ({
  supabase: {},
  supabaseUrl: 'http://stub.invalid',
  supabasePublishableKey: 'stub-key',
}))

/**
 * P147 — cross-track mutation tests (docs/DECISIONS.md D-138).
 *
 * Each mutant removes exactly ONE protection from the production composition and keeps the other.
 * The scenarios of p147-composition-scenarios.ts must FAIL on it: if a mutant survived, either the
 * protection it removes is not pinned by any test, or the scenario that names it never looked.
 *
 *   A  identity lease intact, exact-money guard removed        -> large-money regression fails
 *   B  exact-money guard intact, identity check removed        -> cross-account regression fails
 *   C  a money argument passes through Number() before sending -> precision regression fails
 *   D  an A -> B -> A sequence reactivates the original lease  -> stale-operation regression fails
 *   E  a same-user token refresh invalidates the lease         -> legitimate operation fails
 *
 * The same five changes were also applied to the PRODUCTION files one at a time and run against
 * the whole suite (recorded in docs/PROJECT_JOURNAL.md); these tests keep that check permanent
 * without touching production code.
 */

const mutantEnv = (options: { guard: boolean; verifyIdentity: boolean }): Env => ({
  makeAuthority: () => new IdentityAuthority(),
  buildDb: (lease, world) => buildMutantDb(lease, world, options),
})

describe('control: the harness mutant with BOTH protections behaves like production', () => {
  const control = mutantEnv({ guard: true, verifyIdentity: true })

  it('passes every scenario a mutant is later required to fail', async () => {
    await largeMoneyLeasedPurchase(control)
    await unsafeNumberRefusedStringAccepted(control)
    await identitySwitchBeforeDispatch(control)
    await identitySwitchBeforeDispatch(control, { heard: false })
    await sameUserRefreshExactMoney(control)
    await aToBToAStaleLease(control)
  })
})

describe('mutation A — identity lease kept, exact-money transport guard removed', () => {
  const mutant = mutantEnv({ guard: false, verifyIdentity: true })

  it('the unsafe-number regression FAILS: a rounded literal reaches the backend', async () => {
    await expect(unsafeNumberRefusedStringAccepted(mutant)).rejects.toThrow()
  })

  it('and the mutant really did let a wrong amount through (independent observation)', async () => {
    const world = makeWorld()
    const lease = world.authority.begin('user-a')
    const db = mutant.buildDb(lease, world)
    await db.rpc('create_purchase', {
      p_purchased_on: '2026-09-01',
      p_currency: 'NOK',
      p_lines: [{ line_type: 'accessory', quantity: 1, unit_price_minor: Number(BIG) }],
      p_idempotency_key: 'k',
    })
    expect(world.stored[0]?.unitPriceMinor).toBe(BIG - 1n) // stored 9007199254740992, not ...993
  })
})

describe('mutation B — exact-money guard kept, identity validation removed', () => {
  const mutant = mutantEnv({ guard: true, verifyIdentity: false })

  it('the identity-switch regression FAILS (this tab has heard about B)', async () => {
    await expect(identitySwitchBeforeDispatch(mutant)).rejects.toThrow()
  })

  it('the identity-switch regression FAILS (event gap: storage already holds B)', async () => {
    await expect(identitySwitchBeforeDispatch(mutant, { heard: false })).rejects.toThrow()
  })

  it("and the mutant really did send A's intent under B's bearer (independent observation)", async () => {
    const world = makeWorld()
    const lease = world.authority.begin('user-a')
    const db = mutant.buildDb(lease, world)
    const { submitLargePurchase } = await import('./p147-composition-scenarios')
    const release = world.parkNextSessionLookup()
    const outcome = submitLargePurchase(db)
    for (let i = 0; i < 50 && world.getSessionCalls === 0; i += 1) await Promise.resolve()
    world.switchTo('b')
    release()
    await outcome
    expect(world.stored.map((s) => s.owner)).toEqual(['user-b'])
  })
})

describe('mutation C — a money argument is converted with Number() before the request', () => {
  it('the large-money regression FAILS on both guard settings', async () => {
    for (const guard of [true, false]) {
      const env = mutantEnv({ guard, verifyIdentity: true })
      const world = makeWorld()
      const lease = world.authority.begin('user-a')
      const db = env.buildDb(lease, world)
      const numberedPurchase = () =>
        db
          .rpc('create_purchase', {
            p_purchased_on: '2026-09-01',
            p_currency: 'NOK',
            // the historical Number(minorUnits) at the boundary
            p_lines: [{ line_type: 'accessory', quantity: 1, unit_price_minor: Number(BIG) }],
            p_idempotency_key: 'k',
          })
          .select('id')
      await numberedPurchase()
      // Either the guard refused it (nothing stored) or the ledger holds a different amount:
      // in NEITHER case does the ledger hold the amount that was entered.
      expect(world.stored.map((s) => s.unitPriceMinor)).not.toEqual([BIG])
    }
  })
})

describe('mutation D — an A -> B -> A sequence reactivates the original lease', () => {
  class UserIdOnlyAuthority extends IdentityAuthority {
    override matches(userId: string): boolean {
      return this.userId === userId // the epoch is ignored
    }
  }
  const mutant: Env = {
    makeAuthority: () => new UserIdOnlyAuthority(),
    buildDb: productionEnv.buildDb,
  }

  it('the stale-operation regression FAILS', async () => {
    await expect(aToBToAStaleLease(mutant)).rejects.toThrow()
  })
})

describe('mutation E — a same-user token refresh invalidates the lease', () => {
  class RefreshKillsLeaseAuthority extends IdentityAuthority {
    override observe(userId: string | null): boolean {
      const changed = super.observe(userId)
      if (!changed && userId !== null) {
        super.observe(null)
        super.observe(userId)
      }
      return true
    }
  }
  const mutant: Env = {
    makeAuthority: () => new RefreshKillsLeaseAuthority(),
    buildDb: productionEnv.buildDb,
  }

  it('the legitimate same-user operation FAILS', async () => {
    await expect(sameUserRefreshExactMoney(mutant)).rejects.toThrow()
  })
})
