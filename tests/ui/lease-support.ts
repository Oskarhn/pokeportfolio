import { IdentityAuthority, type IdentityLease } from '../../src/auth/identity-lease'

/**
 * Test vocabulary for identity leases (P145): a fresh authority observing `userId`, and a live lease
 * taken from it. Returned together so a test can then move the identity (`authority.observe(...)`)
 * and watch the lease die.
 */
export function leaseFor(userId: string): { authority: IdentityAuthority; lease: IdentityLease } {
  const authority = new IdentityAuthority()
  authority.observe(userId)
  return { authority, lease: authority.begin(userId) }
}

export function liveLease(userId = 'user-a'): IdentityLease {
  return leaseFor(userId).lease
}
