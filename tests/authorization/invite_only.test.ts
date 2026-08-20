import { afterAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createInvitationDirect,
  createServiceClient,
  deleteSyntheticUser,
  hashInvitationToken,
  randomInvitationToken,
  redeemInvitation,
  syntheticPassword,
  type TestClient,
} from '../db/setup'

/**
 * Invariant S2 (docs/SECURITY.md §5): no auth.users row can exist except as the result of
 * redeeming an invitation token the redeeming party actually possesses.
 *
 * Everything here runs against the live API with the publishable key, the way an attacker would
 * — not against application code that could be bypassed. The frontend is not involved in a single
 * assertion in this file, because the frontend is not what enforces any of it.
 *
 * The two controls being proven, and how to tell them apart when reading a failure:
 *
 *   Gate 1, the Before User Created auth hook, answers a public signup with 403 and the phrase
 *   "invite-only". It fires before GoTrue touches the database.
 *
 *   Gate 2, the auth.users BEFORE INSERT trigger, answers with "account creation requires a valid
 *   invitation" and is the one that catches privileged paths the hook never sees — the Auth Admin
 *   API and the Supabase dashboard.
 */

const service: TestClient = createServiceClient()
const createdUserIds: string[] = []

afterAll(async () => {
  for (const id of createdUserIds) {
    await deleteSyntheticUser(service, id)
  }
})

async function accountExists(email: string, password: string): Promise<boolean> {
  const client = createAnonClient()
  const { error } = await client.auth.signInWithPassword({ email, password })
  return error === null
}

async function findUserId(email: string): Promise<string | null> {
  const { data } = await service.auth.admin.listUsers({ perPage: 1000 })
  return data.users.find((user) => user.email === email)?.id ?? null
}

describe('S2: public signup is closed', () => {
  it('rejects signUp for an address nobody invited', async () => {
    const email = `attacker-unknown-${Date.now()}@example.invalid`
    const password = syntheticPassword()

    const { data, error } = await createAnonClient().auth.signUp({ email, password })

    expect(error).not.toBeNull()
    expect(data.user).toBeNull()
    expect(await accountExists(email, password)).toBe(false)
  })

  /**
   * The attack the whole design exists to defeat. Knowing an invited address is not authorization
   * — a gate that allowed signup for "any address with an outstanding invitation" would let
   * whoever knew that address set the password before the invited person opened their link.
   */
  it('rejects signUp for an address that has a valid outstanding invitation', async () => {
    const invitation = await createInvitationDirect(service)
    const attackerPassword = syntheticPassword()

    const { data, error } = await createAnonClient().auth.signUp({
      email: invitation.email,
      password: attackerPassword,
    })

    expect(error).not.toBeNull()
    expect(data.user).toBeNull()
    expect(await accountExists(invitation.email, attackerPassword)).toBe(false)

    // And the invitation is untouched: the real invitee can still use it.
    const invitedPassword = syntheticPassword()
    const redeemed = await redeemInvitation(invitation.token, invitedPassword)
    expect(redeemed.status).toBe(200)

    const userId = await findUserId(invitation.email)
    expect(userId).not.toBeNull()
    if (userId) createdUserIds.push(userId)

    // The account that exists is the invitee's, with the invitee's password — not the attacker's.
    expect(await accountExists(invitation.email, invitedPassword)).toBe(true)
    expect(await accountExists(invitation.email, attackerPassword)).toBe(false)
  })

  it('rejects signUp carrying forged metadata claiming an invitation', async () => {
    const invitation = await createInvitationDirect(service)
    const password = syntheticPassword()

    const { data, error } = await createAnonClient().auth.signUp({
      email: invitation.email,
      password,
      options: {
        data: {
          invited: true,
          is_admin: true,
          invitation_id: invitation.id,
          claim_id: crypto.randomUUID(),
        },
      },
    })

    expect(error).not.toBeNull()
    expect(data.user).toBeNull()
    expect(await accountExists(invitation.email, password)).toBe(false)
  })

  /**
   * supabase-js has no way to send app_metadata on signUp, which is exactly the point — but "the
   * client library does not offer it" is not the same claim as "the endpoint refuses it", so this
   * one goes to the raw endpoint with a hand-built body.
   */
  it('rejects a hand-built /auth/v1/signup request with forged app_metadata', async () => {
    const invitation = await createInvitationDirect(service)
    const password = syntheticPassword()
    const url = process.env.SUPABASE_URL
    const anonKey = process.env.SUPABASE_ANON_KEY
    expect(url && anonKey).toBeTruthy()

    const response = await fetch(`${url}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey!,
        Authorization: `Bearer ${anonKey!}`,
      },
      body: JSON.stringify({
        email: invitation.email,
        password,
        data: { invited: true },
        app_metadata: { invited: true, is_admin: true, provider: 'invitation' },
        user_metadata: { invited: true },
        role: 'service_role',
        aud: 'authenticated',
      }),
    })

    expect(response.ok).toBe(false)
    expect(await accountExists(invitation.email, password)).toBe(false)
  })

  it('answers a public signup with the invite-only hook, not a generic failure', async () => {
    const email = `attacker-hookcheck-${Date.now()}@example.invalid`
    const { error } = await createAnonClient().auth.signUp({
      email,
      password: syntheticPassword(),
    })

    // Proves gate 1 specifically: this message can only come from public.before_user_created.
    expect(error?.message ?? '').toMatch(/invite-only/i)
  })

  /**
   * Gate 2, on its own. The Auth Admin API never invokes the Before User Created hook — verified
   * against supabase/auth, where internal/api/admin.go contains no hook call — so this path is
   * covered by the auth.users trigger alone. If that trigger were dropped, this test is the one
   * that fails.
   */
  it('rejects Auth Admin user creation with no invitation claim', async () => {
    const email = `admin-api-no-claim-${Date.now()}@example.invalid`
    const { data, error } = await service.auth.admin.createUser({
      email,
      password: syntheticPassword(),
      email_confirm: true,
    })

    expect(error).not.toBeNull()
    expect(data.user).toBeNull()
  })
})

describe('invitation redemption', () => {
  it('creates exactly one correctly-shaped account, and it is not an admin', async () => {
    const invitation = await createInvitationDirect(service, { label: 'happy path' })
    const password = syntheticPassword()

    const result = await redeemInvitation(invitation.token, password)
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.email).toBe(invitation.email)

    const userId = await findUserId(invitation.email)
    expect(userId).not.toBeNull()
    if (userId) createdUserIds.push(userId)

    const { data: profiles } = await service.from('profiles').select().eq('id', userId)
    expect(profiles).toHaveLength(1)
    expect(profiles?.[0]?.is_admin).toBe(false)
    expect(profiles?.[0]?.disabled_at).toBeNull()

    const { data: redemptions } = await service
      .from('invitation_redemptions')
      .select()
      .eq('invitation_id', invitation.id)
    expect(redemptions).toHaveLength(1)
    expect(redemptions?.[0]?.user_id).toBe(userId)

    const { data: invitationRow } = await service
      .from('invitations')
      .select('use_count, token_hash')
      .eq('id', invitation.id)
      .single()
    expect(invitationRow?.use_count).toBe(1)

    // Only the hash is stored, and it is the hash of the token that was actually issued.
    expect(invitationRow?.token_hash).not.toBe(invitation.token)
    expect(invitationRow?.token_hash).toBe(hashInvitationToken(invitation.token))

    // And the new account can sign in normally afterwards.
    expect(await accountExists(invitation.email, password)).toBe(true)
  })

  it('rejects a token nobody issued', async () => {
    const result = await redeemInvitation(randomInvitationToken(), syntheticPassword())
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('invitation_invalid')
  })

  it('rejects a token that has been altered by one character', async () => {
    const invitation = await createInvitationDirect(service)
    const tampered = `${invitation.token.slice(0, -1)}${invitation.token.endsWith('A') ? 'B' : 'A'}`

    const result = await redeemInvitation(tampered, syntheticPassword())
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('invitation_invalid')
  })

  it('rejects an expired invitation', async () => {
    const invitation = await createInvitationDirect(service, {
      expiresAt: new Date(Date.now() - 60_000),
    })
    const password = syntheticPassword()

    const result = await redeemInvitation(invitation.token, password)
    expect(result.status).toBe(400)
    expect(await accountExists(invitation.email, password)).toBe(false)
  })

  it('rejects a revoked invitation', async () => {
    const invitation = await createInvitationDirect(service, { revokedAt: new Date() })
    const password = syntheticPassword()

    const result = await redeemInvitation(invitation.token, password)
    expect(result.status).toBe(400)
    expect(await accountExists(invitation.email, password)).toBe(false)
  })

  it('rejects a replay of a token that already worked', async () => {
    const invitation = await createInvitationDirect(service)
    const first = await redeemInvitation(invitation.token, syntheticPassword())
    expect(first.status).toBe(200)

    const userId = await findUserId(invitation.email)
    if (userId) createdUserIds.push(userId)

    const replay = await redeemInvitation(invitation.token, syntheticPassword())
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe('invitation_invalid')

    const { data: redemptions } = await service
      .from('invitation_redemptions')
      .select()
      .eq('invitation_id', invitation.id)
    expect(redemptions).toHaveLength(1)
  })

  /**
   * The address is fixed by the invitation, not by the request. A redeemer who sends their own
   * address alongside a stolen token gets an account for the invited address or nothing.
   */
  it('ignores an attacker-supplied email in the request body', async () => {
    const invitation = await createInvitationDirect(service)
    const attackerEmail = `attacker-redirect-${Date.now()}@example.invalid`
    const password = syntheticPassword()
    const url = process.env.SUPABASE_URL
    const anonKey = process.env.SUPABASE_ANON_KEY

    const response = await fetch(`${url}/functions/v1/redeem-invitation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey!,
        Authorization: `Bearer ${anonKey!}`,
      },
      body: JSON.stringify({
        token: invitation.token,
        password,
        email: attackerEmail,
        user_metadata: { is_admin: true },
      }),
    })

    expect(response.status).toBe(200)
    const userId = await findUserId(invitation.email)
    expect(userId).not.toBeNull()
    if (userId) createdUserIds.push(userId)

    expect(await findUserId(attackerEmail)).toBeNull()
    expect(await accountExists(invitation.email, password)).toBe(true)
  })

  /**
   * Failure recovery (docs/SECURITY.md §5): a rejected password must not burn the invitation.
   * Nothing about this is retried or cleaned up on a timer — the claim is released explicitly.
   */
  it('leaves the invitation usable after a rejected password', async () => {
    const invitation = await createInvitationDirect(service)

    const rejected = await redeemInvitation(invitation.token, 'short')
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toBe('password_invalid')

    const password = syntheticPassword()
    const accepted = await redeemInvitation(invitation.token, password)
    expect(accepted.status).toBe(200)

    const userId = await findUserId(invitation.email)
    if (userId) createdUserIds.push(userId)
    expect(await accountExists(invitation.email, password)).toBe(true)
  })

  /**
   * Two redemptions in flight at once. The guarantee is not "the second one loses" — it is that
   * exactly one account exists afterwards, whichever request wins the row lock.
   */
  it('produces exactly one account when the same invitation is redeemed twice at once', async () => {
    const invitation = await createInvitationDirect(service)
    const passwordA = syntheticPassword()
    const passwordB = syntheticPassword()

    const [first, second] = await Promise.all([
      redeemInvitation(invitation.token, passwordA),
      redeemInvitation(invitation.token, passwordB),
    ])

    const successes = [first, second].filter((result) => result.status === 200)
    expect(successes).toHaveLength(1)

    const userId = await findUserId(invitation.email)
    expect(userId).not.toBeNull()
    if (userId) createdUserIds.push(userId)

    const { data: redemptions } = await service
      .from('invitation_redemptions')
      .select()
      .eq('invitation_id', invitation.id)
    expect(redemptions).toHaveLength(1)

    const { data: invitationRow } = await service
      .from('invitations')
      .select('use_count')
      .eq('id', invitation.id)
      .single()
    expect(invitationRow?.use_count).toBe(1)
  })
})

describe('invitation_status (the public pre-check)', () => {
  it('reports a valid invitation and the address it is for', async () => {
    const invitation = await createInvitationDirect(service)
    const { data, error } = await createAnonClient()
      .rpc('invitation_status', { p_token: invitation.token })
      .maybeSingle()

    expect(error).toBeNull()
    expect(data?.valid).toBe(true)
    expect(data?.invited_email).toBe(invitation.email)
  })

  it('never returns an address for a token it cannot match', async () => {
    for (const token of [randomInvitationToken(), 'x', 'not-a-token-at-all']) {
      const { data } = await createAnonClient()
        .rpc('invitation_status', { p_token: token })
        .maybeSingle()
      expect(data?.valid).toBe(false)
      expect(data?.invited_email).toBeNull()
    }
  })

  it('reports revoked and expired invitations as simply unavailable', async () => {
    const revoked = await createInvitationDirect(service, { revokedAt: new Date() })
    const expired = await createInvitationDirect(service, {
      expiresAt: new Date(Date.now() - 60_000),
    })

    for (const invitation of [revoked, expired]) {
      const { data } = await createAnonClient()
        .rpc('invitation_status', { p_token: invitation.token })
        .maybeSingle()
      expect(data?.valid).toBe(false)
      expect(data?.invited_email).toBeNull()
    }
  })
})
