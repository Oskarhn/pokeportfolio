/* eslint-disable @typescript-eslint/require-await -- the injected dependency interface is async; the fakes here are deliberately trivial */
import { describe, expect, it } from 'vitest'
import {
  handleAccountDeletion,
  MAX_PASSWORD_LENGTH,
  type AccountDeletionDeps,
  type PasswordCheck,
} from '../../supabase/functions/_shared/account-deletion'

/**
 * P152: the decision logic of account deletion, driven with fully injected dependencies. No
 * database, no network — this is the fast half of the proof (the real-database, real-Auth half is
 * tests/db/p152_account_deletion.test.ts and tests/authorization/p152_account_deletion_attacks.test.ts).
 *
 * What it pins down: the ORDER of steps (nothing destructive before identity + intent + a verified
 * password), that the target is only ever the server-verified user, and what each failure leaves
 * behind.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const A_EMAIL = 'a-synthetic@example.invalid'
const TOKEN = 'header.payload.signature'
const PASSWORD = 'correct horse battery staple'
const DELETION_ID = '33333333-3333-4333-8333-333333333333'
const SUBJECT = 'a'.repeat(64)

interface Harness {
  deps: AccountDeletionDeps
  calls: string[]
  logs: string[]
}

function harness(overrides: Partial<AccountDeletionDeps> = {}): Harness {
  const calls: string[] = []
  const logs: string[] = []
  const deps: AccountDeletionDeps = {
    registryConfigured: () => true,
    async prepareErasure(userId) {
      calls.push(`prepare:${userId}`)
      return { deletionId: DELETION_ID, subject: SUBJECT, recorded: false }
    },
    async appendToRegistry(input) {
      calls.push(`registry:${input.deletionId}`)
      return { seq: 7, deletionId: input.deletionId }
    },
    async confirmErasure(userId, _deletionId, seq) {
      calls.push(`confirm:${userId}:${String(seq)}`)
    },
    async authenticate(token) {
      calls.push(`authenticate:${token}`)
      return { id: A, email: A_EMAIL, passwordReauthentication: true }
    },
    async verifyPassword(email, password) {
      calls.push(`verifyPassword:${email}`)
      return password === PASSWORD ? 'ok' : 'invalid'
    },
    async beginDeletion(userId) {
      calls.push(`begin:${userId}`)
      return 'pending'
    },
    async purgeData(userId) {
      calls.push(`purge:${userId}`)
      return 'purged'
    },
    async deleteAuthUser(userId) {
      calls.push(`deleteAuthUser:${userId}`)
      return 'deleted'
    },
    async scrubAuditTrail(userId) {
      calls.push(`scrub:${userId}`)
    },
    async recordStage(userId, stage) {
      calls.push(`stage:${userId}:${stage}`)
    },
    log(event, fields) {
      logs.push(JSON.stringify({ event, ...fields }))
    },
    ...overrides,
  }
  return { deps, calls, logs }
}

const goodBody = { expectedUserId: A, password: PASSWORD, confirm: true }
const destructive = (calls: string[]) =>
  calls.filter((c) => /^(begin|prepare|registry|confirm|purge|deleteAuthUser|scrub|stage):/.test(c))

describe('authority: who can ask, and what they can ask for', () => {
  it('refuses a request with no bearer token before looking at anything else', async () => {
    const h = harness()
    const res = await handleAccountDeletion(h.deps, { bearerToken: null, body: goodBody })
    expect(res).toEqual({ status: 401, body: { error: 'unauthenticated' } })
    expect(h.calls).toEqual([])
  })

  it('refuses a token Auth does not recognise, without touching anything', async () => {
    const h = harness({ authenticate: async () => null })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(401)
    expect(destructive(h.calls)).toEqual([])
  })

  it('reports Auth being unavailable as 503, never as "unauthenticated" and never proceeds', async () => {
    const h = harness({
      authenticate: async () => {
        throw new Error('network down')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(503)
    expect(destructive(h.calls)).toEqual([])
  })

  it('does not reveal what a valid body looks like to an unauthenticated caller', async () => {
    const h = harness({ authenticate: async () => null })
    const a = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    const b = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: 'garbage' })
    expect(b).toEqual(a)
  })

  it('a body naming a DIFFERENT user aborts with 409 and changes nothing', async () => {
    const h = harness()
    const res = await handleAccountDeletion(h.deps, {
      bearerToken: TOKEN,
      body: { ...goodBody, expectedUserId: B },
    })
    expect(res).toEqual({ status: 409, body: { error: 'identity_mismatch' } })
    expect(destructive(h.calls)).toEqual([])
    // The password check must not even have run: nothing about the mismatch reaches Auth.
    expect(h.calls.some((c) => c.startsWith('verifyPassword'))).toBe(false)
  })

  it('compares the intended id case-insensitively but exactly otherwise', async () => {
    const upper = harness()
    const ok = await handleAccountDeletion(upper.deps, {
      bearerToken: TOKEN,
      body: { ...goodBody, expectedUserId: A.toUpperCase() },
    })
    expect(ok.status).toBe(200)

    const off = harness()
    const bad = await handleAccountDeletion(off.deps, {
      bearerToken: TOKEN,
      body: { ...goodBody, expectedUserId: A.slice(0, -1) + '2' },
    })
    expect(bad.status).toBe(409)
  })

  it('never lets any body field choose the target: only the verified id reaches a destructive step', async () => {
    const h = harness()
    const res = await handleAccountDeletion(h.deps, {
      bearerToken: TOKEN,
      body: {
        ...goodBody,
        userId: B,
        user_id: B,
        email: 'victim@example.invalid',
        id: B,
        target: B,
        user_metadata: { sub: B, user_id: B },
      },
    })
    expect(res.status).toBe(200)
    const touched = destructive(h.calls).join(' ')
    expect(touched).toContain(A)
    expect(touched).not.toContain(B)
    // The password is verified against the address of the token's own account.
    expect(h.calls).toContain(`verifyPassword:${A_EMAIL}`)
    expect(h.calls.join(' ')).not.toContain('victim@')
  })
})

describe('request shape', () => {
  const cases: [string, unknown][] = [
    ['undefined body', undefined],
    ['null body', null],
    ['array body', [goodBody]],
    ['string body', 'delete me'],
    ['missing expectedUserId', { password: PASSWORD, confirm: true }],
    ['non-uuid expectedUserId', { ...goodBody, expectedUserId: 'not-a-uuid' }],
    ['non-string expectedUserId', { ...goodBody, expectedUserId: 42 }],
    ['missing password', { expectedUserId: A, confirm: true }],
    ['empty password', { ...goodBody, password: '' }],
    ['non-string password', { ...goodBody, password: { $ne: null } }],
    ['oversize password', { ...goodBody, password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }],
    ['missing confirm', { expectedUserId: A, password: PASSWORD }],
    ['confirm as string', { ...goodBody, confirm: 'true' }],
    ['confirm false', { ...goodBody, confirm: false }],
  ]
  for (const [name, body] of cases) {
    it(`rejects ${name} with 400 and changes nothing`, async () => {
      const h = harness()
      const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body })
      expect(res).toEqual({ status: 400, body: { error: 'bad_request' } })
      expect(destructive(h.calls)).toEqual([])
      expect(h.calls.some((c) => c.startsWith('verifyPassword'))).toBe(false)
    })
  }
})

describe('recent authentication', () => {
  it('a wrong password is refused with 403 and leaves no pending state behind', async () => {
    const h = harness()
    const res = await handleAccountDeletion(h.deps, {
      bearerToken: TOKEN,
      body: { ...goodBody, password: 'not the password' },
    })
    expect(res).toEqual({ status: 403, body: { error: 'reauthentication_failed' } })
    expect(destructive(h.calls)).toEqual([])
  })

  for (const outcome of ['unavailable'] as PasswordCheck[]) {
    it(`Auth being ${outcome} for the password check is retryable 503, not a refusal`, async () => {
      const h = harness({ verifyPassword: async () => outcome })
      const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
      expect(res).toEqual({
        status: 503,
        body: { error: 'reauthentication_unavailable', retryable: true },
      })
      expect(destructive(h.calls)).toEqual([])
    })
  }

  it('a throwing password check is treated as unavailable, never as success', async () => {
    const h = harness({
      verifyPassword: async () => {
        throw new Error('boom')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(503)
    expect(destructive(h.calls)).toEqual([])
  })
})

describe('the happy path', () => {
  it('runs begin → record the erasure → purge → auth delete → audit scrub, in that order, for the verified user only', async () => {
    const h = harness()
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({ status: 200, body: { status: 'deleted' } })
    expect(destructive(h.calls)).toEqual([
      `begin:${A}`,
      `prepare:${A}`,
      `registry:${DELETION_ID}`,
      `confirm:${A}:7`,
      `purge:${A}`,
      `stage:${A}:purged`,
      `deleteAuthUser:${A}`,
      `scrub:${A}`,
    ])
  })

  it('an audit-scrub failure cannot turn a completed deletion into an error', async () => {
    const h = harness({
      scrubAuditTrail: async () => {
        throw new Error('privilege withheld')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({ status: 200, body: { status: 'deleted' } })
    expect(h.logs.join('\n')).toContain('audit_scrub_failed')
  })
})

describe('interrupted deletion: what each failure leaves behind, and that a retry converges', () => {
  it('fails BEFORE the pending record: nothing at all has happened', async () => {
    const h = harness({
      beginDeletion: async () => {
        throw new Error('db down')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({
      status: 500,
      body: { error: 'deletion_incomplete', retryable: true, stage: 'data' },
    })
    expect(h.calls.some((c) => c.startsWith('purge'))).toBe(false)
    expect(h.calls.some((c) => c.startsWith('deleteAuthUser'))).toBe(false)
  })

  it('fails DURING data purge: reports stage data, records it, never reaches the login', async () => {
    const h = harness({
      purgeData: async () => {
        throw new Error('constraint violation')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({
      status: 500,
      body: { error: 'deletion_incomplete', retryable: true, stage: 'data' },
    })
    expect(h.calls).toContain(`stage:${A}:purge_failed`)
    expect(h.calls.some((c) => c.startsWith('deleteAuthUser'))).toBe(false)
  })

  it('fails BEFORE the Auth Admin call succeeds: data is gone, login remains, stage login', async () => {
    const h = harness({
      deleteAuthUser: async () => {
        throw new Error('auth admin 500')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({
      status: 500,
      body: { error: 'deletion_incomplete', retryable: true, stage: 'login' },
    })
    expect(h.calls).toContain(`purge:${A}`)
    expect(h.calls).toContain(`stage:${A}:auth_delete_failed`)
    // A failed deletion must not be followed by an audit scrub of a live account.
    expect(h.calls.some((c) => c.startsWith('scrub'))).toBe(false)
  })

  it('a retry after a failed login deletion re-runs the idempotent steps and completes', async () => {
    let authAttempts = 0
    const h = harness({
      deleteAuthUser: async () => {
        authAttempts += 1
        if (authAttempts === 1) throw new Error('transient')
        return 'deleted'
      },
    })
    const first = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    const second = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(first.status).toBe(500)
    expect(second).toEqual({ status: 200, body: { status: 'deleted' } })
  })

  it('a parallel request that already removed the user is a success, not an error (begin)', async () => {
    const h = harness({ beginDeletion: async () => 'user_gone' })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({ status: 200, body: { status: 'deleted' } })
    expect(h.calls.some((c) => c.startsWith('purge'))).toBe(false)
  })

  it('a parallel request that already removed the user is a success, not an error (purge)', async () => {
    const h = harness({ purgeData: async () => 'account_gone' })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(200)
    expect(h.calls.some((c) => c.startsWith('stage:'))).toBe(false)
  })

  it('a stale token is NOT read as "already deleted": with a real begin failure it stays an error', async () => {
    // begin fails for a reason that is not "user gone"; authenticate would now return null (the
    // session was revoked meanwhile). The function must not claim success on that basis.
    let authCalls = 0
    const h = harness({
      authenticate: async () =>
        authCalls++ === 0 ? { id: A, email: A_EMAIL, passwordReauthentication: true } : null,
      beginDeletion: async () => {
        throw new Error('connection reset')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(500)
  })
})

describe('P156: accounts a password cannot stand in for are refused explicitly', () => {
  it('an account without an email/password identity or with a verified second factor gets 403 reauthentication_unsupported and nothing is touched', async () => {
    const h = harness({
      authenticate: async () => ({ id: A, email: A_EMAIL, passwordReauthentication: false }),
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'reauthentication_unsupported' })
    // No password check, no pending row, no purge, no Auth deletion (`authenticate` is the
    // overridden dependency here and records nothing, so an empty list means nothing else ran).
    expect(h.calls).toEqual([])
    expect(h.logs.join('')).toContain('reauthentication_unsupported')
  })

  it('an identity mismatch is still reported first, so the unsupported answer does not leak across accounts', async () => {
    const h = harness({
      authenticate: async () => ({ id: A, email: A_EMAIL, passwordReauthentication: false }),
    })
    const res = await handleAccountDeletion(h.deps, {
      bearerToken: TOKEN,
      body: { ...goodBody, expectedUserId: B },
    })
    expect(res.status).toBe(409)
  })
})

describe('logging never carries secrets or identifiers', () => {
  it('across success and every failure branch, logs hold labels only', async () => {
    const branches: Partial<AccountDeletionDeps>[] = [
      {},
      { verifyPassword: async () => 'invalid' },
      { verifyPassword: async () => 'unavailable' },
      { beginDeletion: async () => Promise.reject(new Error(`db said ${A} ${A_EMAIL}`)) },
      { purgeData: async () => Promise.reject(new Error(`purge said ${A_EMAIL}`)) },
      { deleteAuthUser: async () => Promise.reject(new Error(`auth said ${TOKEN}`)) },
      { scrubAuditTrail: async () => Promise.reject(new Error(`scrub said ${A}`)) },
    ]
    for (const override of branches) {
      const h = harness(override)
      await handleAccountDeletion(h.deps, {
        bearerToken: TOKEN,
        body: goodBody,
      })
      const wrong = harness()
      await handleAccountDeletion(wrong.deps, {
        bearerToken: TOKEN,
        body: { ...goodBody, expectedUserId: B },
      })
      for (const line of [...h.logs, ...wrong.logs]) {
        expect(line).not.toContain(A)
        expect(line).not.toContain(B)
        expect(line).not.toContain(A_EMAIL)
        expect(line).not.toContain(TOKEN)
        expect(line).not.toContain(PASSWORD)
      }
    }
  })

  it('response bodies expose only stable codes — no messages, ids or stack traces', async () => {
    const h = harness({
      purgeData: async () =>
        Promise.reject(new Error(`secret detail ${A_EMAIL}\n    at internal.ts:1`)),
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    const serialized = JSON.stringify(res)
    expect(serialized).not.toContain('secret detail')
    expect(serialized).not.toContain(A_EMAIL)
    expect(serialized).not.toContain(' at ')
    expect(Object.keys(res.body).sort()).toEqual(['error', 'retryable', 'stage'])
  })
})

describe('restore safety: the erasure is recorded off-platform BEFORE anything is deleted (P189)', () => {
  const idx = (calls: string[], prefix: string) => calls.findIndex((c) => c.startsWith(prefix))

  it('the registry append and its confirmation both precede the first purge', async () => {
    const h = harness()
    await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(idx(h.calls, 'registry:')).toBeGreaterThan(idx(h.calls, 'begin:'))
    expect(idx(h.calls, 'confirm:')).toBeGreaterThan(idx(h.calls, 'registry:'))
    expect(idx(h.calls, 'purge:')).toBeGreaterThan(idx(h.calls, 'confirm:'))
    expect(idx(h.calls, 'deleteAuthUser:')).toBeGreaterThan(idx(h.calls, 'purge:'))
  })

  it('with no registry configured nothing is touched and the answer says deletion is unavailable', async () => {
    const h = harness({ registryConfigured: () => false })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({ status: 503, body: { error: 'deletion_unavailable' } })
    expect(destructive(h.calls)).toEqual([])
  })

  it('a registry that cannot be written leaves the account pending with its data: no purge, no login deletion, not reported deleted', async () => {
    const h = harness({
      appendToRegistry: async () => {
        throw new Error('registry down')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res).toEqual({
      status: 503,
      body: { error: 'deletion_incomplete', retryable: true, stage: 'registry' },
    })
    expect(h.calls).toContain(`stage:${A}:registry_failed`)
    expect(h.calls.some((c) => c.startsWith('purge:') || c.startsWith('deleteAuthUser:'))).toBe(
      false,
    )
  })

  it('a database that cannot confirm the receipt is the same retryable state, and the purge still does not run', async () => {
    const h = harness({
      confirmErasure: async () => {
        throw new Error('db down')
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(503)
    expect(h.calls.some((c) => c.startsWith('purge:'))).toBe(false)
  })

  it('a retry after a registry failure records once and completes', async () => {
    let attempts = 0
    const h = harness({
      appendToRegistry: async (input) => {
        attempts += 1
        if (attempts === 1) throw new Error('registry down')
        return { seq: 7, deletionId: input.deletionId }
      },
    })
    const first = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    const second = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(first.status).toBe(503)
    expect(second).toEqual({ status: 200, body: { status: 'deleted' } })
  })

  it('an erasure already recorded (a retry after a later failure) is not appended again', async () => {
    const h = harness({
      prepareErasure: async () => ({ deletionId: DELETION_ID, subject: SUBJECT, recorded: true }),
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    expect(res.status).toBe(200)
    expect(h.calls.some((c) => c.startsWith('registry:'))).toBe(false)
  })

  it('the response never carries an id, subject or registry detail', async () => {
    const h = harness({
      appendToRegistry: async () => {
        throw new Error(`registry down for ${A}`)
      },
    })
    const res = await handleAccountDeletion(h.deps, { bearerToken: TOKEN, body: goodBody })
    const text = JSON.stringify(res)
    expect(text).not.toContain(A)
    expect(text).not.toContain(SUBJECT)
    expect(text).not.toContain('registry down')
    expect(h.logs.join('')).not.toContain(A)
  })
})
