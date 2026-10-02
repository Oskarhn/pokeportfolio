import { describe, expect, it, vi } from 'vitest'
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js'
import { AuthIdentityChangedError, IdentityAuthority } from '../../src/auth/identity-lease'
import type { LeasedDb } from '../../src/data/leased-client'
import {
  AccountDeletionError,
  runAccountDeletion,
  type DeletionProbe,
} from '../../src/data/account-deletion'

/**
 * P189 (browser half of account deletion, rebuilt on the P149 identity lease). The properties that
 * matter: nothing is sent once the identity the dialog belonged to has ended; server refusals map
 * to a closed vocabulary of codes with no server text behind them; and when the answer is lost after
 * the server may already have finished, the client asks Auth and only an explicit "user does not
 * exist" counts as deleted.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const PASSWORD = 'a password nobody logs'

interface Rig {
  db: LeasedDb
  invoke: ReturnType<typeof vi.fn>
  authority: IdentityAuthority
}

function rig(options: {
  invoke?: (name: string, init: { body: unknown }) => Promise<{ error: unknown }>
  user?: string | null
}): Rig {
  const authority = new IdentityAuthority()
  authority.observe(options.user === undefined ? A : options.user)
  const lease = authority.begin(options.user === undefined ? A : options.user)
  const invoke = vi.fn(options.invoke ?? (() => Promise.resolve({ error: null })))
  const db = { identityLease: lease, functions: { invoke } } as unknown as LeasedDb
  return { db, invoke, authority }
}

const probe = (gone: boolean): DeletionProbe & { calls: number } => {
  const p = {
    calls: 0,
    accountIsGone() {
      p.calls += 1
      return Promise.resolve(gone)
    },
  }
  return p
}

const httpError = (status: number, body: unknown, raw?: string) =>
  new FunctionsHttpError(new Response(raw ?? JSON.stringify(body), { status }))

async function failure(promise: Promise<unknown>): Promise<AccountDeletionError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AccountDeletionError)
    return error as AccountDeletionError
  }
  throw new Error('expected the deletion to fail')
}

describe('identity binding (the lease)', () => {
  it('sends nothing, and says why, when the identity already ended', async () => {
    const r = rig({})
    r.authority.observe(B)
    await expect(
      runAccountDeletion(r.db, probe(false), { password: PASSWORD }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(r.invoke).not.toHaveBeenCalled()
  })

  it('a lease taken for a signed-out tab is dead on arrival', async () => {
    const r = rig({ user: null })
    await expect(
      runAccountDeletion(r.db, probe(false), { password: PASSWORD }),
    ).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(r.invoke).not.toHaveBeenCalled()
  })

  it('sends exactly the lease owner as the intended id, plus the password and the confirmation', async () => {
    const r = rig({})
    await runAccountDeletion(r.db, probe(false), { password: PASSWORD })
    expect(r.invoke).toHaveBeenCalledTimes(1)
    expect(r.invoke).toHaveBeenCalledWith('delete-account', {
      body: { expectedUserId: A, password: PASSWORD, confirm: true },
    })
  })

  it('the request layer refusing a token (identity ended mid-flight) surfaces as that refusal, not as "could not confirm"', async () => {
    const r = rig({
      invoke: () =>
        Promise.resolve({ error: new FunctionsFetchError(new AuthIdentityChangedError()) }),
    })
    const p = probe(false)
    await expect(runAccountDeletion(r.db, p, { password: PASSWORD })).rejects.toBeInstanceOf(
      AuthIdentityChangedError,
    )
    expect(p.calls).toBe(0)
  })
})

describe('server answers map to a closed vocabulary', () => {
  it.each([
    [403, { error: 'reauthentication_failed' }, 'reauthentication_failed', false],
    [403, { error: 'reauthentication_unsupported' }, 'reauthentication_unsupported', false],
    [
      503,
      { error: 'reauthentication_unavailable', retryable: true },
      'reauthentication_unavailable',
      true,
    ],
    [503, { error: 'deletion_unavailable' }, 'deletion_unavailable', false],
    [409, { error: 'identity_mismatch' }, 'identity_mismatch', false],
    [401, { error: 'unauthenticated' }, 'unauthenticated', false],
    [400, { error: 'bad_request' }, 'bad_request', false],
  ] as const)('%i %j → %s', async (status, body, code, retryable) => {
    const r = rig({ invoke: () => Promise.resolve({ error: httpError(status, body) }) })
    const err = await failure(runAccountDeletion(r.db, probe(false), { password: PASSWORD }))
    expect(err.code).toBe(code)
    expect(err.retryable).toBe(retryable)
  })

  it('carries which step did not finish for an incomplete deletion, including the registry step', async () => {
    for (const stage of ['registry', 'data', 'login'] as const) {
      const r = rig({
        invoke: () =>
          Promise.resolve({
            error: httpError(500, { error: 'deletion_incomplete', retryable: true, stage }),
          }),
      })
      const err = await failure(runAccountDeletion(r.db, probe(false), { password: PASSWORD }))
      expect(err.code).toBe('deletion_incomplete')
      expect(err.retryable).toBe(true)
      expect(err.stage).toBe(stage)
    }
  })

  it('never lets server text through: an unknown code, SQL or stack in the body becomes `unknown`', async () => {
    for (const body of [
      { error: 'duplicate key value violates unique constraint "x"' },
      { error: 'PGRST116', message: 'JSON object requested' },
      { message: 'at purge_account_data (supabase/functions/delete-account/index.ts:1)' },
    ]) {
      const r = rig({ invoke: () => Promise.resolve({ error: httpError(500, body) }) })
      const err = await failure(runAccountDeletion(r.db, probe(false), { password: PASSWORD }))
      expect(err.code).toBe('unknown')
      expect(err.message).toBe('unknown')
      expect(JSON.stringify(err)).not.toMatch(/violates|PGRST|purge_account_data|index\.ts/)
    }
  })

  it('a non-JSON gateway error page is `unknown`, retryable', async () => {
    const r = rig({
      invoke: () => Promise.resolve({ error: httpError(502, null, '<html>bad gateway</html>') }),
    })
    const err = await failure(runAccountDeletion(r.db, probe(false), { password: PASSWORD }))
    expect(err.code).toBe('unknown')
    expect(err.retryable).toBe(true)
  })
})

describe('a lost answer: ask Auth, and only an explicit "gone" counts', () => {
  it('a thrown request and an account that is gone is a success', async () => {
    const r = rig({ invoke: () => Promise.reject(new Error('socket hang up')) })
    await expect(
      runAccountDeletion(r.db, probe(true), { password: PASSWORD }),
    ).resolves.toBeUndefined()
  })

  it('a thrown request and an account that is NOT gone is a retryable network error', async () => {
    const r = rig({ invoke: () => Promise.reject(new Error('socket hang up')) })
    const err = await failure(runAccountDeletion(r.db, probe(false), { password: PASSWORD }))
    expect(err.code).toBe('network')
    expect(err.retryable).toBe(true)
  })

  it('an unreadable response and an account that is gone is a success', async () => {
    const r = rig({
      invoke: () => Promise.resolve({ error: new FunctionsFetchError(new Error('x')) }),
    })
    await expect(
      runAccountDeletion(r.db, probe(true), { password: PASSWORD }),
    ).resolves.toBeUndefined()
  })

  it('a fetch failure with the account still present is a network error', async () => {
    const r = rig({
      invoke: () => Promise.resolve({ error: new FunctionsFetchError(new Error('x')) }),
    })
    const err = await failure(runAccountDeletion(r.db, probe(false), { password: PASSWORD }))
    expect(err.code).toBe('network')
  })

  it('a readable refusal is never second-guessed by asking Auth', async () => {
    const r = rig({
      invoke: () =>
        Promise.resolve({ error: httpError(403, { error: 'reauthentication_failed' }) }),
    })
    const p = probe(true)
    const err = await failure(runAccountDeletion(r.db, p, { password: PASSWORD }))
    expect(err.code).toBe('reauthentication_failed')
    expect(p.calls).toBe(0)
  })
})
