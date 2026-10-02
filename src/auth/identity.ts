/**
 * Authenticated-identity vocabulary shared by the query-cache boundary and the React identity
 * boundary (P143). Pure and dependency-free so every rule here is unit-testable without a DOM.
 *
 * The identity of a tab is the auth USER ID and nothing else. An access token, a refresh token,
 * a session object, `user_metadata` or `updated_at` all change routinely for the SAME person
 * (TOKEN_REFRESHED, USER_UPDATED, a repeated SIGNED_IN on tab refocus) and none of those may
 * destroy unsaved work.
 */

/**
 * `undefined` until this tab has observed any authenticated identity at all (fresh page load);
 * `null` once a signed-in user has been observed and then signed out; otherwise the last signed-in
 * user id.
 */
export type ObservedUserId = string | null | undefined

/** The React key for the signed-out / not-yet-restored state. */
export const ANONYMOUS_IDENTITY_KEY = 'anonymous'

/**
 * The key the authenticated React subtree is mounted under. Two renders that produce the same key
 * keep every component's state; a different key remounts the subtree from scratch.
 *
 * `null` (signed out, or the initial session still loading) deliberately maps to ONE key: a
 * loading -> signed-out resolution is not an identity change and must not remount public pages.
 */
export function identityKey(userId: string | null): string {
  return userId === null ? ANONYMOUS_IDENTITY_KEY : `user:${userId}`
}

export type IdentityTransition =
  /** The first identity this tab lifetime has seen; nothing earlier could hold state to leak. */
  | 'first-observation'
  /** Same user id (token refresh, user update, repeated SIGNED_IN) or still signed out. */
  | 'unchanged'
  /** Signed out -> signed in as somebody. */
  | 'sign-in'
  /** Signed in as somebody -> signed out. */
  | 'sign-out'
  /** Signed in as A -> signed in as a DIFFERENT user B, with no signed-out state in between. */
  | 'switch'

export function classifyIdentityTransition(
  previous: ObservedUserId,
  next: string | null,
): IdentityTransition {
  if (previous === undefined) return 'first-observation'
  if (previous === next) return 'unchanged'
  if (previous === null) return 'sign-in'
  if (next === null) return 'sign-out'
  return 'switch'
}

/** True for every transition after which nothing user-scoped from the previous identity may
 *  remain reachable: the boundary must fire. */
export function isIdentityChange(transition: IdentityTransition): boolean {
  return transition === 'sign-in' || transition === 'sign-out' || transition === 'switch'
}
