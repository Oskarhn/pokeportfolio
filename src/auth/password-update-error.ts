/**
 * What a failed password change tells the person (P130-20, P130-26).
 *
 * With `secure_password_change` on (supabase/config.toml), GoTrue refuses a password change from a
 * session older than 24 hours unless it carries a reauthentication nonce, and answers
 * `reauthentication_needed`. The product has no nonce flow on purpose: its only password-change path
 * is the emailed recovery link, which creates a fresh session. So that refusal means "this session
 * is stale — start again from a new link", and that is what the person is told. Every other failure
 * is reduced to fixed copy; the auth service's own message never reaches the screen.
 */

export const PASSWORD_UPDATE_COPY = {
  stale:
    'For your security this sign-in is too old to change the password. Request a new reset link and use it straight away.',
  same: 'Choose a password that is different from your current one.',
  weak: 'That password is too easy to guess. Choose a longer or less common one.',
  ended: 'Your session has ended. Request a new reset link.',
  generic: 'That password could not be set. Choose a different one and try again.',
} as const

export function describePasswordUpdateError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const status = (error as { status?: unknown } | null)?.status
  switch (code) {
    case 'reauthentication_needed':
    case 'reauthentication_not_valid':
      return PASSWORD_UPDATE_COPY.stale
    case 'same_password':
      return PASSWORD_UPDATE_COPY.same
    case 'weak_password':
      return PASSWORD_UPDATE_COPY.weak
    case 'session_not_found':
    case 'session_expired':
    case 'bad_jwt':
      return PASSWORD_UPDATE_COPY.ended
    default:
      return status === 401 ? PASSWORD_UPDATE_COPY.ended : PASSWORD_UPDATE_COPY.generic
  }
}
