import { describe, expect, it, vi } from 'vitest'
vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))
import {
  describeError,
  TECHNICAL_DETAIL,
  USER_ERROR_TEXT,
  userMessage,
  UserFacingError,
  type UserErrorKind,
} from '../../src/platform/user-error'
import { InvalidMoneyInputError } from '../../src/domain/errors'
import { FxRateNotFoundError, FxRateUnavailableError } from '../../src/data/fx'
import {
  AuthCredentialsUnavailableError,
  AuthIdentityChangedError,
} from '../../src/auth/identity-lease'
import { DeliveryError } from '../../src/features/export/fileDelivery'

/**
 * P130-26: no screen renders a backend message. These are representative injected backend and
 * transport failures — the exact strings PostgREST, Postgres and fetch produce — and the contract
 * is that what reaches a person is one of the closed-vocabulary sentences and contains none of the
 * infrastructure markers.
 */

const BACKEND_FAILURES: { raw: unknown; kind: UserErrorKind; name: string }[] = [
  {
    name: 'unique violation',
    raw: new Error(
      'duplicate key value violates unique constraint "holdings_identity_idx" (SQLSTATE 23505)',
    ),
    kind: 'invalid_input',
  },
  {
    name: 'RLS refusal',
    raw: new Error('new row violates row-level security policy for table "purchases"'),
    kind: 'not_authorized',
  },
  {
    name: 'permission denied with code',
    raw: Object.assign(new Error('permission denied for table acquisition_lots'), {
      code: '42501',
    }),
    kind: 'not_authorized',
  },
  {
    name: 'PostgREST not-found',
    raw: new Error(
      'PostgREST: Could not find the function public.create_purchase in the schema cache',
    ),
    kind: 'could_not_complete',
  },
  {
    name: 'rpc path in message',
    raw: new Error('Failed to fetch https://x.supabase.co/rest/v1/rpc/create_sale'),
    kind: 'connection',
  },
  {
    name: 'edge function path',
    raw: new Error('FunctionsHttpError: /functions/v1/delete-account returned 502'),
    kind: 'temporary',
  },
  {
    name: 'JWT expired',
    raw: Object.assign(new Error('JWT expired'), { code: 'PGRST301' }),
    kind: 'session_expired',
  },
  {
    name: 'check constraint',
    raw: new Error(
      'new row for relation "sale_lines" violates check constraint "sale_lines_qty_positive"',
    ),
    kind: 'invalid_input',
  },
  {
    name: 'stack trace',
    raw: new Error('TypeError: x is not a function\n    at doThing (assets/index-abc.js:1:2)'),
    kind: 'could_not_complete',
  },
  {
    name: 'HTTP 503',
    raw: Object.assign(new Error('upstream'), { status: 503 }),
    kind: 'temporary',
  },
  {
    name: 'bare string',
    raw: 'public.create_purchase(date, text) failed',
    kind: 'could_not_complete',
  },
]

describe('P130-26 — backend failures become closed-vocabulary text', () => {
  for (const { name, raw, kind } of BACKEND_FAILURES) {
    it(`${name} → ${kind}, with no infrastructure detail`, () => {
      const text = userMessage(raw)
      expect(text).toBe(USER_ERROR_TEXT[kind])
      expect(text).not.toMatch(TECHNICAL_DETAIL)
      expect(text).not.toMatch(
        /SQLSTATE|duplicate key|row-level|PostgREST|supabase|public\.create_|constraint|stack trace/i,
      )
      // The diagnostic keeps the raw detail for dev tooling; it is not what userMessage returns.
      expect(describeError(raw).message).toBe(text)
    })
  }

  it('every vocabulary sentence is itself free of technical markers', () => {
    for (const text of Object.values(USER_ERROR_TEXT)) expect(text).not.toMatch(TECHNICAL_DETAIL)
  })

  it('a form-supplied context replaces ONLY the generic outcome, never a classified one', () => {
    expect(userMessage(new Error('something odd'), 'Could not save this card.')).toBe(
      'Could not save this card.',
    )
    // A classified failure keeps its category sentence even when a context is offered.
    expect(userMessage(new Error('Failed to fetch'), 'Could not save this card.')).toBe(
      USER_ERROR_TEXT.connection,
    )
  })
})

describe('P130-26 — product-authored text passes through, technical-looking text does not', () => {
  it('user-written classes keep their own message', () => {
    expect(userMessage(new InvalidMoneyInputError('Enter an amount like 12.50.'))).toBe(
      'Enter an amount like 12.50.',
    )
    expect(userMessage(new FxRateNotFoundError('No rate for 2026-01-01.'))).toBe(
      'No rate for 2026-01-01.',
    )
    expect(describeError(new FxRateUnavailableError('Could not resolve a rate.')).kind).toBe(
      'price_unavailable',
    )
    expect(userMessage(new AuthIdentityChangedError())).toMatch(/sign-in changed/)
    expect(userMessage(new AuthCredentialsUnavailableError())).toMatch(/Could not verify/)
    expect(userMessage(new DeliveryError('Sharing is not available.'))).toBe(
      'Sharing is not available.',
    )
    expect(userMessage(new UserFacingError('Pick a storage location first.'))).toBe(
      'Pick a storage location first.',
    )
  })

  it('a plain Error is never trusted, even when its text reads like a sentence', () => {
    expect(userMessage(new Error('Pick a storage location first.'))).not.toBe(
      'Pick a storage location first.',
    )
  })

  it('a user-facing error that carries infrastructure detail is refused (defence in depth)', () => {
    const leaky = new UserFacingError('insert violates foreign key constraint holdings_fk')
    expect(userMessage(leaky)).not.toMatch(TECHNICAL_DETAIL)
    expect(userMessage(leaky)).toBe(USER_ERROR_TEXT.invalid_input)
    const leakyWithPath = new FxRateUnavailableError('see /functions/v1/fetch-fx-rate')
    expect(userMessage(leakyWithPath)).not.toMatch(/functions\/v1/)
  })
})
