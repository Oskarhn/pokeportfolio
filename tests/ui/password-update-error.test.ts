import { describe, expect, it } from 'vitest'
import {
  describePasswordUpdateError,
  PASSWORD_UPDATE_COPY,
} from '../../src/auth/password-update-error'
import { TECHNICAL_DETAIL } from '../../src/platform/user-error'

/** P130-20: the failures `secure_password_change` introduces are told as fixed copy. */
describe('password update failures', () => {
  const cases: [unknown, string][] = [
    [
      { code: 'reauthentication_needed', message: 'Password update requires reauthentication' },
      PASSWORD_UPDATE_COPY.stale,
    ],
    [{ code: 'reauthentication_not_valid', message: 'x' }, PASSWORD_UPDATE_COPY.stale],
    [
      { code: 'same_password', message: 'New password should be different from the old password.' },
      PASSWORD_UPDATE_COPY.same,
    ],
    [
      { code: 'weak_password', message: 'Password should contain at least one digit', status: 422 },
      PASSWORD_UPDATE_COPY.weak,
    ],
    [
      { code: 'session_not_found', message: 'Session from session_id claim in JWT does not exist' },
      PASSWORD_UPDATE_COPY.ended,
    ],
    [
      { status: 401, message: 'invalid JWT: unable to parse or verify signature' },
      PASSWORD_UPDATE_COPY.ended,
    ],
    [
      { code: 'unexpected_failure', message: 'Database error saving new user (SQLSTATE 23505)' },
      PASSWORD_UPDATE_COPY.generic,
    ],
    [new Error('fetch failed'), PASSWORD_UPDATE_COPY.generic],
    [null, PASSWORD_UPDATE_COPY.generic],
  ]
  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input).slice(0, 60)}`, () => {
      const text = describePasswordUpdateError(input)
      expect(text).toBe(expected)
      expect(text).not.toMatch(TECHNICAL_DETAIL)
    })
  }
})
