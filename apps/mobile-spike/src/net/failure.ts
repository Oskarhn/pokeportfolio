/**
 * One place that turns "something failed" into a state the UI can show. Nothing in a screen inspects
 * an error itself: it renders a {@link Failure}, whose text is fixed (no URL, token, SQL or server
 * message can reach the screen through it).
 */

export type FailureKind =
  | 'offline'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'server'
  | 'unsafe_numeric'
  | 'write_refused'
  | 'request_rejected'
  | 'identity_changed'
  | 'credentials_unavailable'
  | 'unknown'

export interface Failure {
  kind: FailureKind
  /** HTTP status when one is known. */
  status: number | null
  /** Fixed, user-safe text. */
  message: string
  /** Whether "Try again" can be expected to help. */
  retryable: boolean
}

const MESSAGE: Record<FailureKind, string> = {
  offline: 'Could not reach the server. Check your connection and try again.',
  unauthorized: 'Your session is no longer valid. Sign in again.',
  forbidden: 'You do not have access to this.',
  not_found: 'This item could not be found.',
  server: 'The server had a problem. Try again in a moment.',
  unsafe_numeric:
    'A value in the response could not be read exactly, so it is not shown. Nothing was changed.',
  write_refused: 'This build is read-only.',
  request_rejected: 'The server rejected this request.',
  identity_changed: 'Your sign-in changed before this finished, so it was not completed.',
  credentials_unavailable: 'Could not verify your session. Check your connection and try again.',
  unknown: 'Something went wrong. Try again.',
}

const RETRYABLE: ReadonlySet<FailureKind> = new Set(['offline', 'server', 'unknown'])

function make(kind: FailureKind, status: number | null): Failure {
  return { kind, status, message: MESSAGE[kind], retryable: RETRYABLE.has(kind) }
}

function statusToKind(status: number): FailureKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404 || status === 406) return 'not_found'
  if (status >= 500) return 'server'
  return 'request_rejected'
}

const OFFLINE = /network request failed|failed to fetch|fetch failed|network error|timed out/i
const STATUS_IN_MESSAGE = /HttpStatusError: HTTP (\d{3})/
const JWT = /\bjw[ts]\b|pgrst30[13]/i

export function classifyFailure(error: unknown): Failure {
  // Structural on purpose: PostgREST errors are plain objects, auth-js errors are Error subclasses.
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown
    message?: unknown
  }
  const name = typeof record.name === 'string' ? record.name : ''
  const message =
    typeof record.message === 'string' ? record.message : typeof error === 'string' ? error : ''
  const code = (error as { code?: unknown } | null)?.code

  if (name === 'UnsafeNumericResponseError' || name === 'UnsafeMoneyTransportError') {
    return make('unsafe_numeric', null)
  }
  if (name === 'WriteRefusedError' || message.includes('WriteRefusedError')) {
    return make('write_refused', null)
  }
  if (name === 'AuthIdentityChangedError') {
    return make('identity_changed', null)
  }
  if (name === 'AuthCredentialsUnavailableError') {
    return make('credentials_unavailable', null)
  }
  if (
    message.includes('UnsafeNumericResponseError') ||
    message.includes('UnsafeMoneyTransportError')
  ) {
    return make('unsafe_numeric', null)
  }

  const status = (error as { status?: unknown } | null)?.status
  if (name === 'HttpStatusError' && typeof status === 'number') {
    return make(statusToKind(status), status)
  }
  const inMessage = STATUS_IN_MESSAGE.exec(message)
  if (inMessage?.[1] !== undefined) {
    const parsed = Number(inMessage[1])
    return make(statusToKind(parsed), parsed)
  }

  if (name === 'AuthRetryableFetchError' && (status === 0 || status === undefined)) {
    return make('offline', null)
  }
  if (name === 'AuthApiError' && (status === 400 || status === 401 || status === 403)) {
    return make('unauthorized', typeof status === 'number' ? status : null)
  }
  if (code === 'PGRST301' || code === 'PGRST303' || JWT.test(message)) {
    return make('unauthorized', 401)
  }
  if (OFFLINE.test(message) || (name === 'TypeError' && message !== '')) {
    return make('offline', null)
  }
  return make('unknown', null)
}
