/**
 * Password policy for the one place in this application where a password is chosen.
 *
 * Enforced twice on purpose. GoTrue enforces `minimum_password_length` itself (supabase/
 * config.toml), which is the control that actually holds for any caller. Checking here as well
 * means a password that was never going to be accepted is rejected *before* the invitation is
 * claimed, so a typo cannot burn an invitation or hold it for two minutes.
 *
 * Deliberately not implemented: composition rules and a leaked-password corpus. Requiring "one
 * uppercase, one symbol" reliably produces `Passw0rd!` and fights password managers; NIST
 * SP 800-63B advises against it. Supabase's leaked-password check (HaveIBeenPwned) exists but is
 * a paid-plan feature, and shipping a breach corpus of our own would cost more than it buys for
 * ten invited users choosing a 12-character password. What is left is the part that pays for
 * itself: length, and a short list of the guesses anyone would actually try first.
 */

export const MIN_PASSWORD_LENGTH = 12

/**
 * bcrypt — which GoTrue uses — silently ignores everything past 72 bytes. Rejecting rather than
 * truncating means nobody ends up with a password whose tail does not matter.
 */
export const MAX_PASSWORD_BYTES = 72

const OBVIOUS_PASSWORDS = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  'passwordpassword',
  'password1234',
  'password12345',
  'passw0rd1234',
  'qwertyuiop12',
  'qwertyuiopas',
  'iloveyou1234',
  'letmein12345',
  'administrator',
  'pokeportfolio',
  'pokemoncards1',
  'pokemonpokemon',
  'changemeplease',
  'welcome123456',
  'trustno1trustno1',
])

export type PasswordProblem =
  | { code: 'too_short'; message: string }
  | { code: 'too_long'; message: string }
  | { code: 'too_obvious'; message: string }

/** Returns a problem to report, or null if the password is acceptable. */
export function checkPassword(password: string, email: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      code: 'too_short',
      message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }

  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return {
      code: 'too_long',
      message: `Choose a password of at most ${MAX_PASSWORD_BYTES} bytes.`,
    }
  }

  const normalized = password.toLowerCase().replace(/\s+/g, '')

  if (OBVIOUS_PASSWORDS.has(normalized)) {
    return { code: 'too_obvious', message: 'That password is too easy to guess. Choose another.' }
  }

  // A single repeated character reaches any length requirement without adding anything.
  if (new Set(normalized).size <= 2) {
    return { code: 'too_obvious', message: 'That password is too easy to guess. Choose another.' }
  }

  // The address is public knowledge to whoever sent the invitation.
  const localPart = email.split('@')[0]?.toLowerCase() ?? ''
  if (localPart.length >= 4 && normalized.includes(localPart)) {
    return {
      code: 'too_obvious',
      message: 'Do not use your email address in your password.',
    }
  }

  return null
}
