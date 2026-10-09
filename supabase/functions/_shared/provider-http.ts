/**
 * Bounded, classified HTTP access to third-party JSON providers (TCGdex, Norges Bank).
 *
 * Before this module the TCGdex adapter called `fetch` with no timeout, no retry and no handling of
 * 429 / 5xx, although docs/API_SOURCES.md's failure strategy promises "retry with backoff". One slow
 * or throttled provider response could hold an Edge Function until the platform killed it, and a
 * burst of 429s was hammered once per card with no pause. This is the one place that policy lives.
 *
 * Contract:
 *   - every attempt has its own timeout (AbortController) and the whole call has a total budget;
 *   - only transient failures are retried — network errors, timeouts, HTTP 429 and 5xx — never a
 *     404 or another 4xx, never invalid JSON (a deterministic answer does not improve on repeat);
 *   - retries are bounded (`maxAttempts`) and spaced by exponential backoff with full jitter;
 *   - `Retry-After` is honoured when it fits the budget; a longer wait is NOT slept through — the
 *     call fails at once as `rate_limited` carrying `retryAfterMs`, so the caller can stop the batch
 *     instead of parking an Edge Function;
 *   - every failure is a `ProviderError` with a stable `kind`, so callers count and report outcomes
 *     by class rather than by message text;
 *   - messages never contain a response body, only the path and status (a provider payload can be
 *     arbitrarily large or hostile, and logs must stay small and free of third-party content).
 *
 * Timing is injectable (`sleep`, `random`, `now`) so the policy is tested deterministically.
 */

export type ProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'not_found'
  | 'invalid_json'
  | 'budget_exhausted'

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind
  readonly status: number | null
  readonly attempts: number
  /** Milliseconds the provider asked us to wait (429 only), when it said. */
  readonly retryAfterMs: number | null

  constructor(
    kind: ProviderFailureKind,
    message: string,
    details: { status?: number | null; attempts?: number; retryAfterMs?: number | null } = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = details.status ?? null
    this.attempts = details.attempts ?? 1
    this.retryAfterMs = details.retryAfterMs ?? null
  }
}

export interface ProviderHttpPolicy {
  /** Wall-clock limit for ONE attempt. */
  attemptTimeoutMs: number
  /** Attempts including the first one. 1 disables retrying. */
  maxAttempts: number
  /** First backoff ceiling; doubles per retry, capped at `maxDelayMs`. */
  baseDelayMs: number
  maxDelayMs: number
  /** A `Retry-After` longer than this is not waited out. */
  maxRetryAfterMs: number
  /** Wall-clock limit for the whole call, attempts and sleeps included. */
  totalBudgetMs: number
}

export const DEFAULT_PROVIDER_POLICY: Readonly<ProviderHttpPolicy> = Object.freeze({
  attemptTimeoutMs: 6000,
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 2000,
  maxRetryAfterMs: 3000,
  totalBudgetMs: 15000,
})

export interface ProviderClock {
  sleep(ms: number): Promise<void>
  random(): number
  now(): number
}

export const realClock: ProviderClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  now: () => Date.now(),
}

/**
 * Seam for tests and for the Deno edge harness: they replace the clock (so backoff does not cost
 * wall time) and the policy (to shrink timeouts) without any production code path reading an
 * environment variable.
 */
export const providerRuntime: { clock: ProviderClock; policy: ProviderHttpPolicy } = {
  clock: realClock,
  policy: { ...DEFAULT_PROVIDER_POLICY },
}

export interface FetchJsonOptions {
  /** Absolute epoch-ms deadline shared by a whole batch; no new attempt starts after it. */
  deadlineMs?: number
  policy?: Partial<ProviderHttpPolicy>
  clock?: ProviderClock
  /** Used instead of `fetch` when given (tests). */
  fetchImpl?: typeof fetch
}

/** Parses a `Retry-After` header: delta-seconds or an HTTP date. Null when absent or unusable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null
  }
  // An HTTP-date always carries a month name; without that guard `Date.parse` accepts fragments such
  // as "-4" (year -4) and a nonsense wait would follow.
  if (!/[A-Za-z]{3}/.test(trimmed)) return null
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - nowMs)
}

/** Full-jitter exponential backoff: uniform in [0, min(maxDelay, base * 2^(attempt-1))]. */
export function backoffDelayMs(
  attempt: number,
  policy: Pick<ProviderHttpPolicy, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  return Math.floor(random() * ceiling)
}

function isRetryable(kind: ProviderFailureKind): boolean {
  return (
    kind === 'timeout' || kind === 'network' || kind === 'rate_limited' || kind === 'server_error'
  )
}

async function attemptOnce(
  url: string,
  path: string,
  attemptTimeoutMs: number,
  fetchImpl: typeof fetch,
  clock: ProviderClock,
): Promise<{ ok: true; value: unknown } | { ok: false; error: ProviderError }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), attemptTimeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, { signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          error: new ProviderError(
            'timeout',
            `provider timed out after ${attemptTimeoutMs}ms: ${path}`,
          ),
        }
      }
      const detail = error instanceof Error ? error.name : 'unknown'
      return {
        ok: false,
        error: new ProviderError('network', `provider request failed (${detail}): ${path}`),
      }
    }

    if (response.status === 404) {
      return {
        ok: false,
        error: new ProviderError('not_found', `not found: ${path}`, { status: 404 }),
      }
    }
    if (response.status === 429) {
      return {
        ok: false,
        error: new ProviderError('rate_limited', `provider rate limited (429): ${path}`, {
          status: 429,
          retryAfterMs: parseRetryAfter(
            response.headers?.get?.('retry-after') ?? null,
            clock.now(),
          ),
        }),
      }
    }
    if (response.status >= 500) {
      return {
        ok: false,
        error: new ProviderError('server_error', `provider error ${response.status}: ${path}`, {
          status: response.status,
        }),
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        error: new ProviderError(
          'client_error',
          `provider rejected request ${response.status}: ${path}`,
          {
            status: response.status,
          },
        ),
      }
    }
    try {
      // The body is read inside the attempt window so a stalled body cannot outlive the timeout.
      return { ok: true, value: await response.json() }
    } catch {
      if (controller.signal.aborted) {
        return {
          ok: false,
          error: new ProviderError(
            'timeout',
            `provider body timed out after ${attemptTimeoutMs}ms: ${path}`,
          ),
        }
      }
      return {
        ok: false,
        error: new ProviderError('invalid_json', `provider returned invalid JSON: ${path}`, {
          status: response.status,
        }),
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** GET `url` and return its parsed JSON, under the retry policy described in the file header. */
export async function fetchJsonWithPolicy(
  url: string,
  path: string,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  const policy: ProviderHttpPolicy = { ...providerRuntime.policy, ...options.policy }
  const clock = options.clock ?? providerRuntime.clock
  const fetchImpl = options.fetchImpl ?? fetch
  const startedAt = clock.now()
  const budgetEnd = Math.min(startedAt + policy.totalBudgetMs, options.deadlineMs ?? Infinity)

  let last: ProviderError | null = null
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const remaining = budgetEnd - clock.now()
    if (remaining <= 0) {
      throw last !== null
        ? new ProviderError(last.kind, last.message, {
            status: last.status,
            attempts: attempt - 1,
            retryAfterMs: last.retryAfterMs,
          })
        : new ProviderError(
            'budget_exhausted',
            `provider budget exhausted before request: ${path}`,
            { attempts: 0 },
          )
    }

    const result = await attemptOnce(
      url,
      path,
      Math.min(policy.attemptTimeoutMs, remaining),
      fetchImpl,
      clock,
    )
    if (result.ok) return result.value

    last = new ProviderError(result.error.kind, result.error.message, {
      status: result.error.status,
      attempts: attempt,
      retryAfterMs: result.error.retryAfterMs,
    })
    if (!isRetryable(last.kind) || attempt === policy.maxAttempts) throw last

    let wait = backoffDelayMs(attempt, policy, clock.random)
    if (last.kind === 'rate_limited' && last.retryAfterMs !== null) {
      // The provider said how long; never retry sooner, never sleep through an unreasonable ask.
      if (last.retryAfterMs > policy.maxRetryAfterMs) throw last
      wait = Math.max(wait, last.retryAfterMs)
    }
    if (clock.now() + wait >= budgetEnd) throw last
    await clock.sleep(wait)
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw (
    last ??
    new ProviderError('budget_exhausted', `provider call made no attempt: ${path}`, { attempts: 0 })
  )
}
