import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'
import { connectDb } from '../db/lib/account-deletion-deps'
import { seedAccountLedger } from '../db/lib/account-ledger-fixture'

vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))

import {
  AccountDeletionError,
  runAccountDeletion,
  type DeletionClient,
} from '../../src/data/account-deletion'

/**
 * P156: "the response was lost" against a REAL Auth server and the REAL deployed function, with the
 * shipped client logic (runAccountDeletion) on top. P152 proved the client's decision table against
 * fakes and the server's interrupted paths in-process; what was not shown end to end is that the
 * question the client asks after a lost answer — "does Auth still know this token's user?" — gets
 * the answer the client's rule needs from an actual GoTrue, in both directions:
 *
 *   deleted user  → `user_not_found`  → treated as "deleted"
 *   revoked token → a different code  → NOT treated as "deleted"
 */

const FUNCTION_URL = `${process.env.SUPABASE_URL ?? ''}/functions/v1/delete-account`
const ANON = process.env.SUPABASE_ANON_KEY ?? ''

let service: TestClient
let db: pg.Client
const created: SyntheticUser[] = []

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
})
afterAll(async () => {
  for (const u of created) {
    await service.from('account_deletion_requests').delete().eq('user_id', u.id)
    await deleteSyntheticUser(service, u.id)
  }
  await db.end()
}, 120_000)

async function actor(label: string) {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  const client = await signInAs(user)
  await seedAccountLedger(service, user, client, label)
  const token = (await client.auth.getSession()).data.session!.access_token
  return { user, client, token }
}

const exists = async (id: string): Promise<boolean> =>
  Boolean((await service.auth.admin.getUserById(id)).data.user)

/** The real request, sent for real — and then the caller is told nothing. */
async function sendAndLoseTheAnswer(token: string, body: unknown): Promise<never> {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  await res.text() // the server has finished by the time the body is complete
  throw new TypeError('network connection lost') // ...and the client never sees it
}

function clientOver(real: TestClient, lose: (token: string) => Promise<never>): DeletionClient {
  return {
    auth: {
      getSession: () => real.auth.getSession(),
      getUser: () => real.auth.getUser(),
    },
    functions: {
      invoke: async () => {
        const session = (await real.auth.getSession()).data.session!
        return lose(session.access_token)
      },
    },
  }
}

describe('the answer to a deletion request is lost after the server finished', () => {
  it('the client asks Auth, gets user_not_found from a real GoTrue, and reports success', async () => {
    const a = await actor('p156-lost-ok')
    const client = clientOver(a.client, (token) =>
      sendAndLoseTheAnswer(token, {
        expectedUserId: a.user.id,
        password: a.user.password,
        confirm: true,
      }),
    )
    await expect(
      runAccountDeletion(client, { expectedUserId: a.user.id, password: a.user.password }),
    ).resolves.toBeUndefined()
    expect(await exists(a.user.id)).toBe(false)
  })

  it('a replay of the very same request with the same bearer is inert (401), and creates nothing', async () => {
    const a = await actor('p156-lost-replay')
    const body = { expectedUserId: a.user.id, password: a.user.password, confirm: true }
    await sendAndLoseTheAnswer(a.token, body).catch(() => undefined)
    expect(await exists(a.user.id)).toBe(false)
    const again = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON,
        Authorization: `Bearer ${a.token}`,
      },
      body: JSON.stringify(body),
    })
    expect(again.status).toBe(401)
    const rows = await db.query(
      'select 1 from public.account_deletion_requests where user_id = $1',
      [a.user.id],
    )
    expect(rows.rowCount).toBe(0)
  })

  it('a REVOKED session with a lost answer is not mistaken for a deletion: the account is untouched and the error is retryable', async () => {
    const a = await actor('p156-lost-revoked')
    // The request never reached the server (the connection died first) and the session was revoked
    // elsewhere in the meantime. Auth answers the probe with something other than user_not_found.
    await service.auth.admin.signOut(a.token, 'global')
    const client = clientOver(a.client, () =>
      Promise.reject(new TypeError('network connection lost')),
    )
    const failure = await runAccountDeletion(client, {
      expectedUserId: a.user.id,
      password: a.user.password,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(failure).toBeInstanceOf(AccountDeletionError)
    expect((failure as AccountDeletionError).retryable).toBe(true)
    expect(await exists(a.user.id)).toBe(true)
  })

  it('a pending account whose login deletion never happened stays write-blocked but readable, and a fresh attempt completes it', async () => {
    const a = await actor('p156-lost-partial')
    // Deletion authorised and data purged, login still present: the "between purge and Auth" state.
    expect((await service.rpc('begin_account_deletion', { p_user_id: a.user.id })).error).toBeNull()
    for (let i = 0; i < 50; i++) {
      const p = await service.rpc('purge_account_data', { p_user_id: a.user.id })
      if ((p.data as { complete: boolean }).complete) break
    }
    const write = await a.client.from('tags').insert({ user_id: a.user.id, name: 'after purge' })
    expect(write.error?.message).toContain('account_deletion_pending')
    const read = await a.client.from('holdings').select('id')
    expect(read.error).toBeNull()

    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON,
        Authorization: `Bearer ${a.token}`,
      },
      body: JSON.stringify({ expectedUserId: a.user.id, password: a.user.password, confirm: true }),
    })
    expect(res.status).toBe(200)
    expect(await exists(a.user.id)).toBe(false)
  })
})
