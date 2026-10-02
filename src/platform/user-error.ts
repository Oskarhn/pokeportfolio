import { InvalidMoneyInputError } from '../domain/errors'

/**
 * The one place a failure becomes text a person reads (P130-26).
 *
 * Backend and transport errors reach the UI as `new Error(postgrestError.message)`: a PostgREST or
 * Postgres message names tables, constraints, SQLSTATEs and function paths. That is infrastructure
 * detail the user cannot act on, and on a public repository it is a free map of the schema. So no
 * screen renders an error's own message. A screen asks {@link userMessage}, which answers from a
 * CLOSED vocabulary ({@link USER_ERROR_TEXT}); the only text that passes through verbatim is text
 * the product wrote itself — a {@link UserFacingError} or an `InvalidMoneyInputError`, whose
 * messages are authored in this codebase — and even that is refused if it looks technical.
 *
 * Structured diagnostics (code, status, the raw message) stay available to dev tooling through
 * {@link describeError}'s `diagnostic`; it is never rendered.
 */

export type UserErrorKind =
  | 'connection'
  | 'session_expired'
  | 'not_authorized'
  | 'invalid_input'
  | 'temporary'
  | 'could_not_complete'
  | 'price_unavailable'

export const USER_ERROR_TEXT: Readonly<Record<UserErrorKind, string>> = {
  connection: 'Could not reach the server. Check your connection and try again.',
  session_expired: 'Your session has expired. Sign in again.',
  not_authorized: 'You do not have access to that.',
  invalid_input: 'Some of the details could not be accepted. Check them and try again.',
  temporary: 'The service had a temporary problem. Try again in a moment.',
  could_not_complete: 'That could not be completed. Try again.',
  price_unavailable: 'No price is available for this right now.',
}

/** An error whose message was written for the person reading it. The only generic pass-through. */
export class UserFacingError extends Error {
  readonly userFacing = true
  readonly kind: UserErrorKind
  constructor(message: string, kind: UserErrorKind = 'invalid_input') {
    super(message)
    this.kind = kind
  }
}

export interface DescribedError {
  kind: UserErrorKind
  message: string
  /** Raw detail for logs and tests. Never render this. */
  diagnostic: string
}

/**
 * Words that mark infrastructure detail. Applied to every candidate pass-through message as a last
 * line of defence, and by the tests that inject backend failures into forms.
 */
export const TECHNICAL_DETAIL =
  /sqlstate|\bpgrst\w*|postgrest|postgres|supabase|duplicate key|violates|row-level security|\brls\b|constraint|\bpublic\.|\bauth\.|functions\/v1|\brpc\/|stack trace|\bat [\w.<>]+ \(|\bjwt\b|\becon\w+|etimedout|typeerror|syntaxerror|null value in column|relation "|column "/i

const CONNECTION =
  /failed to fetch|networkerror|network request failed|network error|load failed|fetch failed|timed? ?out|econn|enotfound|offline/i
const SESSION =
  /\bjw[ts]\b|pgrst30[13]|invalid refresh token|not authenticated|session (?:has )?expired|token (?:is )?expired/i
const FORBIDDEN =
  /row-level security|permission denied|42501|forbidden|not authorized|must belong to the same owner|not accessible/i
const INVALID =
  /violates|duplicate key|invalid input syntax|check constraint|null value in column|out of range|\b2[23]\d{3}\b|invalid |must be|cannot |exceed/i
const TEMPORARY =
  /service unavailable|bad gateway|gateway time-?out|too many requests|rate limit|overload|statement timeout|57014|\b53\d{3}\b|\b5\d{2}\b|temporar/i

function rawMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const m = (error as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return ''
}

function structured(error: unknown): { code: string; status: number | null } {
  const o = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown
    status?: unknown
  }
  return {
    code: typeof o.code === 'string' ? o.code : '',
    status: typeof o.status === 'number' ? o.status : null,
  }
}

/** Classify any thrown value into the closed vocabulary. Order matters: most specific first. */
export function describeError(error: unknown): DescribedError {
  const raw = rawMessage(error)
  const { code, status } = structured(error)
  const probe = `${code} ${raw}`

  if (
    (error instanceof UserFacingError || error instanceof InvalidMoneyInputError) &&
    error.message !== '' &&
    !TECHNICAL_DETAIL.test(error.message)
  ) {
    const kind: UserErrorKind = error instanceof UserFacingError ? error.kind : 'invalid_input'
    return { kind, message: error.message, diagnostic: raw }
  }

  let kind: UserErrorKind
  if (status === 401 || SESSION.test(probe)) kind = 'session_expired'
  else if (status === 403 || FORBIDDEN.test(probe)) kind = 'not_authorized'
  else if (CONNECTION.test(probe)) kind = 'connection'
  else if ((status !== null && status >= 500) || TEMPORARY.test(probe)) kind = 'temporary'
  else if (INVALID.test(probe)) kind = 'invalid_input'
  else kind = 'could_not_complete'

  return { kind, message: USER_ERROR_TEXT[kind], diagnostic: raw }
}

/**
 * The text a screen may show for a failure. `context` is optional product-authored text
 * ("Could not save this card.") used only for the generic outcome, so a form can say what it was
 * doing without ever echoing why the backend refused.
 */
export function userMessage(error: unknown, context?: string): string {
  const described = describeError(error)
  if (context !== undefined && described.kind === 'could_not_complete') return context
  return described.message
}
