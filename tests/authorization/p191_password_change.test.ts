import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  syntheticPassword,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'
import { connectDb } from '../db/lib/account-deletion-deps'

/**
 * P130-20: what `secure_password_change = true` (supabase/config.toml) does, against the real Auth
 * service of the local stack. The key maps to GoTrue's SECURITY_UPDATE_PASSWORD_REQUIRE_
 * REAUTHENTICATION: a session created within 24 hours may change the password; an older one must
 * reauthenticate (an emailed nonce) first. So a stolen but stale session cannot set a new password
 * by itself. The hosted project's setting is a separate owner action (docs/security/
 * P191_SECURITY_BOUNDARY_CLOSURE.md).
 */

let service: TestClient
let user: SyntheticUser

beforeAll(async () => {
  service = createServiceClient()
  user = await createSyntheticUser(service, 'p191-pw')
})

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
})

async function ageSessions(hours: number): Promise<void> {
  const db = await connectDb()
  try {
    await db.query(
      `update auth.sessions
          set created_at = now() - make_interval(hours => $2),
              updated_at = now() - make_interval(hours => $2),
              refreshed_at = (now() - make_interval(hours => $2))::timestamp
        where user_id = $1`,
      [user.id, hours],
    )
  } finally {
    await db.end()
  }
}

describe('secure_password_change', () => {
  it('a session signed in within 24 hours can change the password directly', async () => {
    const client = await signInAs(user)
    const next = syntheticPassword()
    const { error } = await client.auth.updateUser({ password: next })
    expect(error).toBeNull()
    user = { ...user, password: next }
  })

  it('a session older than 24 hours is refused: reauthentication_needed', async () => {
    const client = await signInAs(user)
    await ageSessions(25)
    const { error } = await client.auth.updateUser({ password: syntheticPassword() })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('reauthentication_needed')
  })

  it('a made-up nonce does not unlock it', async () => {
    const client = await signInAs(user)
    await ageSessions(25)
    const { error } = await client.auth.updateUser({
      password: syntheticPassword(),
      nonce: '000000',
    })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('reauthentication_not_valid')
  })

  it('the reauthentication step exists (the nonce is requested for the account owner)', async () => {
    const client = await signInAs(user)
    await ageSessions(25)
    const { error } = await client.auth.reauthenticate()
    // Delivery goes to the account's mailbox (the local Mailpit); the call itself must be accepted.
    expect(error).toBeNull()
  })

  it('the refusal does not change the password', async () => {
    // The current password still signs in.
    const client = await signInAs(user)
    const { data } = await client.auth.getUser()
    expect(data.user?.id).toBe(user.id)
  })
})
