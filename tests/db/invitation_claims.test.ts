import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createInvitationDirect,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  randomInvitationToken,
  redeemInvitation,
  syntheticPassword,
  type TestClient,
} from './setup'

/**
 * The claim record itself — its deferred foreign key, its expiry, and the idempotency of the step
 * that closes it out.
 *
 * The invite-only attack surface is covered in tests/authorization/invite_only.test.ts, from the
 * outside. This file is about the mechanism underneath: `invitation_claims.consumed_user_id` is
 * written by a BEFORE INSERT trigger on `auth.users`, which means it is set while the row it
 * references does not exist yet. That only works because the foreign key is
 * DEFERRABLE INITIALLY DEFERRED, and "only works because of X" is worth a test that fails if X
 * quietly changes.
 *
 * Two things had to be true and only one of them was being exercised. Redemption working proves
 * the constraint is deferred. Nothing proved it was still *enforced* — a dropped or NOT VALID
 * constraint would also let redemption pass, and would let a claim point at a user that never
 * existed. Both halves are asserted below.
 */

let service: TestClient

beforeAll(() => {
  service = createServiceClient()
})

interface ClaimRow {
  id: string
  email: string
  expires_at: string
  consumed_at: string | null
  consumed_user_id: string | null
}

async function readClaim(claimId: string): Promise<ClaimRow | null> {
  const { data } = await service
    .from('invitation_claims')
    .select('id,email,expires_at,consumed_at,consumed_user_id')
    .eq('id', claimId)
    .maybeSingle()
  return data
}

describe('the consumed_user_id foreign key is deferred, and still enforced', () => {
  it('a redemption writes consumed_user_id before that auth.users row exists, and commits', async () => {
    // The whole path: claim, create, finalize. If the FK were checked per-statement rather than at
    // commit, the trigger's `update invitation_claims set consumed_user_id = new.id` would raise
    // foreign_key_violation and no account could ever be created. That this passes is the positive
    // half of the proof.
    const user = await createSyntheticUser(service, 'deferred-fk')

    const { data } = await service
      .from('invitation_claims')
      .select('id,consumed_at,consumed_user_id')
      .eq('consumed_user_id', user.id)
      .maybeSingle()

    const claim = data
    expect(claim, 'the claim should have been consumed by the new user').not.toBeNull()
    expect(claim?.consumed_at).not.toBeNull()
    expect(claim?.consumed_user_id).toBe(user.id)

    await deleteSyntheticUser(service, user.id)
  })

  it('a claim naming a user that does not exist is rejected at commit', async () => {
    // The negative half. Deferred is not the same as absent: the check still runs, it just runs
    // later. PostgREST commits each request, so a deferred violation surfaces as a failed request
    // rather than a failed statement — which is exactly the behaviour that keeps a dangling
    // consumed_user_id from ever reaching disk.
    const invitation = await createInvitationDirect(service)

    const { error } = await service.from('invitation_claims').insert({
      invitation_id: invitation.id,
      email: invitation.email,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      consumed_at: new Date().toISOString(),
      consumed_user_id: crypto.randomUUID(),
    })

    expect(error, 'a claim pointing at a nonexistent user must not commit').not.toBeNull()
    expect(error?.message ?? '').toMatch(/foreign key|violates/i)
  })

  it('deleting the account removes its claim, leaving nothing dangling', async () => {
    const user = await createSyntheticUser(service, 'fk-cascade')
    const { data: before } = await service
      .from('invitation_claims')
      .select('id')
      .eq('consumed_user_id', user.id)
    expect((before ?? []).length).toBe(1)

    await deleteSyntheticUser(service, user.id)

    const { data: after } = await service
      .from('invitation_claims')
      .select('id')
      .eq('consumed_user_id', user.id)
    expect(after ?? []).toEqual([])
  })

  it('no claim anywhere in the database points at a user that is not there', async () => {
    // A property, not a scenario. Whatever the suites above did to this database, this has to hold
    // afterwards — including after the deliberate failure cases.
    const { data } = await service
      .from('invitation_claims')
      .select('id,consumed_user_id')
      .not('consumed_user_id', 'is', null)

    const claims = (data ?? []) as { id: string; consumed_user_id: string }[]
    for (const claim of claims) {
      const { data: user } = await service.auth.admin.getUserById(claim.consumed_user_id)
      expect(user.user?.id, `claim ${claim.id} references a missing user`).toBe(
        claim.consumed_user_id,
      )
    }
  })
})

describe('an abandoned redemption frees the invitation without a cleanup job', () => {
  it('an expired claim stops blocking, and the invitation can still be redeemed', async () => {
    // Models the redemption process dying between claim_invitation and createUser: the claim is
    // held, nothing consumed it, and nobody released it. The two-minute expiry is the only thing
    // that recovers this, so it is the thing worth testing. Time is moved by rewriting expires_at
    // rather than by waiting two minutes.
    const invitation = await createInvitationDirect(service)

    const claim = await service.rpc('claim_invitation', { p_token: invitation.token }).maybeSingle()
    const claimId = (claim.data as { claim_id: string } | null)?.claim_id
    expect(claimId, 'the first claim should succeed').toBeTruthy()

    // While that claim is live, a second attempt is refused rather than issued.
    const contended = await service.rpc('claim_invitation', { p_token: invitation.token })
    expect(contended.error, 'a live claim must block a second one').not.toBeNull()

    await service
      .from('invitation_claims')
      .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq('id', claimId!)

    const password = syntheticPassword()
    const result = await redeemInvitation(invitation.token, password)
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.ok).toBe(true)
    expect(result.body.email).toBe(invitation.email)

    const { data: created } = await service
      .from('invitation_redemptions')
      .select('user_id')
      .eq('invitation_id', invitation.id)
    const redeemed = (created ?? []) as { user_id: string }[]
    expect(redeemed.length).toBe(1)

    // The abandoned claim is gone: claim_invitation clears expired, unconsumed claims for the
    // address before counting availability, which is what keeps the count and the unique index
    // agreeing with each other.
    expect(await readClaim(claimId!)).toBeNull()

    await deleteSyntheticUser(service, redeemed[0]!.user_id)
  })
})

describe('finalize_invitation_redemption', () => {
  it('counts a redemption once, however many times it is retried', async () => {
    // The Edge Function calls finalize after createUser has already succeeded. If that response is
    // lost and the client retries, the account exists and the claim is spent — so finalize has to
    // be safe to run again. Not safe as in "does nothing", safe as in "does not count the same
    // account twice", because use_count is what an admin reads.
    const user = await createSyntheticUser(service, 'finalize-retry')

    const { data: claimData } = await service
      .from('invitation_claims')
      .select('id,invitation_id')
      .eq('consumed_user_id', user.id)
      .single()
    const claim = claimData as { id: string; invitation_id: string }

    for (let i = 0; i < 3; i += 1) {
      const { error } = await service.rpc('finalize_invitation_redemption', {
        p_claim_id: claim.id,
        p_user_id: user.id,
      })
      expect(error, `retry ${i} should not fail`).toBeNull()
    }

    const { data: invitation } = await service
      .from('invitations')
      .select('use_count')
      .eq('id', claim.invitation_id)
      .single()
    expect((invitation as { use_count: number }).use_count).toBe(1)

    const { data: redemptions } = await service
      .from('invitation_redemptions')
      .select('id')
      .eq('invitation_id', claim.invitation_id)
    expect((redemptions ?? []).length).toBe(1)

    await deleteSyntheticUser(service, user.id)
  })

  it('refuses to record a redemption for a user the claim did not create', async () => {
    const victim = await createSyntheticUser(service, 'finalize-victim')
    const attacker = await createSyntheticUser(service, 'finalize-attacker')

    const { data: claimData } = await service
      .from('invitation_claims')
      .select('id,invitation_id')
      .eq('consumed_user_id', victim.id)
      .single()
    const claim = claimData as { id: string; invitation_id: string }

    const { error } = await service.rpc('finalize_invitation_redemption', {
      p_claim_id: claim.id,
      p_user_id: attacker.id,
    })
    expect(error, "another user's id must not be attachable to this claim").not.toBeNull()

    const { data: redemptions } = await service
      .from('invitation_redemptions')
      .select('user_id')
      .eq('invitation_id', claim.invitation_id)
    expect((redemptions ?? []).map((r) => r.user_id)).toEqual([victim.id])

    await deleteSyntheticUser(service, victim.id)
    await deleteSyntheticUser(service, attacker.id)
  })

  it('refuses a claim that was never consumed', async () => {
    const invitation = await createInvitationDirect(service)
    const claim = await service.rpc('claim_invitation', { p_token: invitation.token }).maybeSingle()
    const claimId = (claim.data as { claim_id: string } | null)?.claim_id

    const { error } = await service.rpc('finalize_invitation_redemption', {
      p_claim_id: claimId!,
      p_user_id: crypto.randomUUID(),
    })
    expect(error, 'an unconsumed claim authorizes no account').not.toBeNull()

    await service.rpc('release_invitation_claim', { p_claim_id: claimId! })
  })
})

describe('a token that never existed leaves no trace', () => {
  it('claiming an unissued token creates nothing', async () => {
    const { count: before } = await service
      .from('invitation_claims')
      .select('id', { count: 'exact', head: true })

    const { error } = await service.rpc('claim_invitation', { p_token: randomInvitationToken() })
    expect(error).not.toBeNull()

    const { count: after } = await service
      .from('invitation_claims')
      .select('id', { count: 'exact', head: true })
    expect(after).toBe(before)
  })
})

afterAll(async () => {
  // Nothing here owns rows beyond what each test deletes; this exists so a failure mid-file does
  // not leave a live claim blocking a later run against a persistent local stack.
  await service
    .from('invitation_claims')
    .delete()
    .is('consumed_at', null)
    .lt('expires_at', new Date().toISOString())
})
