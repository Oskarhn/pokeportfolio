import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createInvitationDirect,
  createServiceClient,
  createSyntheticUser,
  type IssuedInvitation,
  deleteSyntheticUser,
  promoteToAdmin,
  randomInvitationToken,
  redeemInvitation,
  signInAs,
  syntheticPassword,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'

/**
 * The administrative surface, and the line around it.
 *
 * `invitations` is a System table (DATA_MODEL.md §1) and the one legitimate place an
 * `is_admin()`-checking policy belongs — it is the admin's own management surface, not anybody's
 * private collection. The negative tests at the bottom are the ones that matter most: admin
 * status must grant zero access to another user's holdings, purchases or profile
 * (docs/SECURITY.md §4). There must be no policy anywhere shaped like
 * `user_id = auth.uid() OR is_admin()` on a user-private table.
 */

let service: TestClient
let admin: SyntheticUser
let plainUser: SyntheticUser
let otherUser: SyntheticUser
let adminClient: TestClient
let plainClient: TestClient
let otherClient: TestClient
const createdUserIds: string[] = []

beforeAll(async () => {
  service = createServiceClient()
  admin = await createSyntheticUser(service, 'admin')
  plainUser = await createSyntheticUser(service, 'plain')
  otherUser = await createSyntheticUser(service, 'other')

  await promoteToAdmin(service, admin.id)

  adminClient = await signInAs(admin)
  plainClient = await signInAs(plainUser)
  otherClient = await signInAs(otherUser)
})

afterAll(async () => {
  for (const id of [admin.id, plainUser.id, otherUser.id, ...createdUserIds]) {
    await deleteSyntheticUser(service, id)
  }
})

describe('invitation management is admin-only', () => {
  it('an admin can issue an invitation and gets the raw token exactly once', async () => {
    const email = `invited-by-admin-${Date.now()}@example.invalid`
    const { data, error } = await adminClient
      .rpc('create_invitation', { p_email: email, p_expires_in_hours: 48, p_label: 'a friend' })
      .maybeSingle()
    const issued = data as IssuedInvitation | null

    expect(error).toBeNull()
    expect(issued?.invited_email).toBe(email)
    expect(typeof issued?.token).toBe('string')
    expect(issued?.token.length).toBeGreaterThanOrEqual(43)

    // The token is returned to the caller and nowhere else — the row holds a hash.
    const { data: stored } = await service
      .from('invitations')
      .select('token_hash, email, created_by')
      .eq('id', issued?.invitation_id)
      .single()
    expect(stored?.token_hash).not.toBe(issued?.token)
    expect(stored?.email).toBe(email)
    expect(stored?.created_by).toBe(admin.id)
  })

  it('normalizes the invited address the same way Auth does', async () => {
    const local = `MiXeD-Case-${Date.now()}`
    const { data } = await adminClient
      .rpc('create_invitation', { p_email: `  ${local}@Example.INVALID  ` })
      .maybeSingle()

    expect((data as IssuedInvitation | null)?.invited_email).toBe(
      `${local.toLowerCase()}@example.invalid`,
    )
  })

  it('refuses an address that is not an address', async () => {
    const { error } = await adminClient.rpc('create_invitation', { p_email: 'not-an-email' })
    expect(error?.message ?? '').toContain('invalid_email')
  })

  it('refuses to invite an address that already has an account', async () => {
    const { error } = await adminClient.rpc('create_invitation', { p_email: plainUser.email })
    expect(error?.message ?? '').toContain('account_exists')
  })

  it('a non-admin cannot issue an invitation', async () => {
    const { error } = await plainClient.rpc('create_invitation', {
      p_email: `escalation-${Date.now()}@example.invalid`,
    })
    expect(error?.message ?? '').toContain('not_authorized')
  })

  it('a non-admin cannot revoke an invitation', async () => {
    const invitation = await createInvitationDirect(service)
    const { error } = await plainClient.rpc('revoke_invitation', {
      p_invitation_id: invitation.id,
    })
    expect(error?.message ?? '').toContain('not_authorized')
  })

  it('revoking makes a previously-good invitation unusable immediately', async () => {
    const email = `revoked-before-use-${Date.now()}@example.invalid`
    const { data } = await adminClient.rpc('create_invitation', { p_email: email }).maybeSingle()
    const issued = data as IssuedInvitation

    const { error } = await adminClient.rpc('revoke_invitation', {
      p_invitation_id: issued.invitation_id,
    })
    expect(error).toBeNull()

    const password = syntheticPassword()
    const result = await redeemInvitation(issued.token, password)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('invitation_invalid')
  })

  it('a non-admin sees no invitations at all', async () => {
    await createInvitationDirect(service)
    const { data, error } = await plainClient.from('invitation_overview').select()
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('an admin reads invitations through the overview, with a usable status', async () => {
    const { data, error } = await adminClient
      .from('invitation_overview')
      .select('id, email, status, expires_at')
    expect(error).toBeNull()
    expect((data ?? []).length).toBeGreaterThan(0)
    for (const row of data ?? []) {
      expect(['active', 'expired', 'revoked', 'redeemed']).toContain(row.status)
    }
  })
})

describe('the token hash never leaves the database', () => {
  it('an admin cannot select token_hash', async () => {
    const { error } = await adminClient.from('invitations').select('token_hash')
    expect(error).not.toBeNull()
  })

  it('an admin cannot select * from invitations either', async () => {
    const { error } = await adminClient.from('invitations').select()
    expect(error).not.toBeNull()
  })

  it('the overview view has no token_hash column to ask for', async () => {
    const { error } = await adminClient.from('invitation_overview').select('token_hash')
    expect(error).not.toBeNull()
  })

  it('nobody can write an invitation row directly, so nobody can plant a token hash', async () => {
    const { error } = await adminClient.from('invitations').insert({
      token_hash: 'attacker-chosen-hash',
      email: `planted-${Date.now()}@example.invalid`,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    })
    expect(error).not.toBeNull()
  })
})

describe('the privileged redemption internals are not reachable from a session', () => {
  const privileged = [
    ['claim_invitation', { p_token: randomInvitationToken() }],
    [
      'finalize_invitation_redemption',
      { p_claim_id: crypto.randomUUID(), p_user_id: crypto.randomUUID() },
    ],
    ['release_invitation_claim', { p_claim_id: crypto.randomUUID() }],
    ['hash_invitation_token', { p_token: 'anything' }],
  ] as const

  it('an authenticated user cannot call them', async () => {
    for (const [name, args] of privileged) {
      const { error } = await plainClient.rpc(name, args)
      expect(error, `${name} should not be callable by an authenticated user`).not.toBeNull()
    }
  })

  it('an admin cannot call them either — admin is not a privilege level here', async () => {
    for (const [name, args] of privileged) {
      const { error } = await adminClient.rpc(name, args)
      expect(error, `${name} should not be callable by an admin`).not.toBeNull()
    }
  })

  it('invitation_claims is invisible to every session', async () => {
    for (const client of [plainClient, adminClient]) {
      const { data, error } = await client.from('invitation_claims').select()
      expect(error !== null || data.length === 0).toBe(true)
    }
  })
})

describe('a user cannot make themselves an admin', () => {
  it('updating is_admin on your own profile does not take', async () => {
    const { error } = await plainClient
      .from('profiles')
      .update({ is_admin: true })
      .eq('id', plainUser.id)
    expect(error).not.toBeNull()

    const { data } = await service
      .from('profiles')
      .select('is_admin')
      .eq('id', plainUser.id)
      .single()
    expect(data?.is_admin).toBe(false)
  })

  it('a redeemed invitation never produces an admin', async () => {
    const invitation = await createInvitationDirect(service)
    const result = await redeemInvitation(invitation.token, syntheticPassword())
    expect(result.status).toBe(200)

    const { data } = await service.auth.admin.listUsers({ perPage: 1000 })
    const created = data.users.find((user) => user.email === invitation.email)
    expect(created).toBeTruthy()
    if (created) createdUserIds.push(created.id)

    const { data: profile } = await service
      .from('profiles')
      .select('is_admin')
      .eq('id', created?.id)
      .single()
    expect(profile?.is_admin).toBe(false)
  })
})

describe('admin has no access to another user private data (SECURITY.md §4)', () => {
  it('admin cannot read another user purchases through the app API', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { data: purchase } = await otherClient
      .from('purchases')
      .insert({
        user_id: otherUser.id,
        purchased_on: today,
        currency: 'NOK',
        subtotal_minor: 1_000,
        total_minor: 1_000,
        fx_rate_date: today,
        total_nok_minor: 1_000,
      })
      .select()
      .single()
    expect(purchase).toBeTruthy()

    const { data, error } = await adminClient.from('purchases').select().eq('id', purchase!.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('admin cannot read another user holdings, retailers, storage_locations or tags', async () => {
    const { data: retailer } = await otherClient
      .from('retailers')
      .insert({ user_id: otherUser.id, name: `admin-cannot-see-${Date.now()}` })
      .select()
      .single()

    const { data, error } = await adminClient.from('retailers').select().eq('id', retailer!.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('admin cannot enumerate other users profiles', async () => {
    const { data, error } = await adminClient.from('profiles').select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data?.[0]?.id).toBe(admin.id)
  })

  /**
   * The one thing admin legitimately sees about other people is the address they were invited at
   * — that is what invitation management is. It must not become a way to reach anything else, and
   * `invitation_redemptions` linking an address to a user id is the closest thing to a bridge, so
   * it gets its own assertion.
   */
  it('admin seeing an invited address does not open any other door on that user', async () => {
    const { data: overview } = await adminClient.from('invitation_overview').select('email')
    expect((overview ?? []).length).toBeGreaterThan(0)

    const { data: holdings } = await adminClient.from('holdings').select()
    expect(holdings).toEqual([])

    const { data: lots } = await adminClient.from('acquisition_lots').select()
    expect(lots).toEqual([])
  })
})
