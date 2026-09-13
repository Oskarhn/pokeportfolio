/**
 * Bounded-timeout, bounded-retry HTTP fetch for the offline visual-index generator's per-card
 * image downloads (P110, prompt §6-7 — P107's DUAL_BUILD_RISK_VERDICT §19: "no timeout/retry/
 * backoff on image fetches, no 429-specific handling... a single transient failure is retried
 * automatically on the NEXT resume (fine), but a systemic event during an unattended multi-hour
 * run is not mitigated at all").
 *
 * Every request gets a finite timeout via `AbortController` — across ~19,500 sequential requests,
 * one dead connection must never hang the whole run. Transient failures (429, 5xx, timeout,
 * network error) get bounded exponential backoff with full jitter, honoring a numeric or
 * HTTP-date `Retry-After` header on 429 when the server sends one. Permanent failures (404, any
 * other non-retryable HTTP status) return immediately on the first attempt — hammering a
 * genuinely-missing image on every retry wastes the run's own time budget for nothing.
 */

export type FetchFailureKind =
  'timeout' | 'http_404' | 'http_429' | 'http_5xx' | 'http_other' | 'network'

export interface FetchWithRetryOptions {
  readonly timeoutMs?: number
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  /** Injectable for deterministic tests — defaults to a real `setTimeout`-based sleep. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Injectable for deterministic tests — defaults to `Math.random`. */
  readonly random?: () => number
}

export type FetchWithRetryResult =
  | { readonly ok: true; readonly response: Response; readonly attempts: number }
  | {
      readonly ok: false
      readonly kind: FetchFailureKind
      readonly attempts: number
      readonly message: string
    }

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_FETCH_ATTEMPTS = 5
export const DEFAULT_BASE_DELAY_MS = 500
export const DEFAULT_MAX_DELAY_MS = 15_000

function classifyStatus(status: number): FetchFailureKind {
  if (status === 404) return 'http_404'
  if (status === 429) return 'http_429'
  if (status >= 500 && status <= 599) return 'http_5xx'
  return 'http_other'
}

/** 404 and any other non-{429,5xx} status (401/403/etc.) are treated as permanent — retrying a
 *  genuinely wrong/missing/forbidden resource cannot succeed and only wastes the retry budget the
 *  transient cases actually need. */
function isRetryableKind(kind: FetchFailureKind): boolean {
  return kind === 'timeout' || kind === 'http_429' || kind === 'http_5xx' || kind === 'network'
}

/** Parses `Retry-After` per RFC 9110 §10.2.3: either a non-negative integer number of seconds, or
 *  an HTTP-date. Returns `null` when absent or unparseable, so the caller falls back to its own
 *  backoff schedule rather than trusting a malformed header value. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null || header.trim() === '') return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
  return null
}

/** Full-jitter exponential backoff (AWS's own recommended strategy over "equal jitter" or none):
 *  a uniform random delay in `[0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))]`. Bounded above by
 *  `maxDelayMs` so a long run's backoff never grows unboundedly across many consecutive failures. */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.floor(random() * cap)
}

/**
 * Fetches `url` with a finite per-attempt timeout and bounded retry/backoff for transient
 * failures. Never retries indefinitely — `maxAttempts` (default {@link DEFAULT_MAX_FETCH_ATTEMPTS})
 * is a hard ceiling. On success, returns the (still-unread-body) `Response`; the caller is
 * responsible for reading and releasing it exactly as it already does for a bare `fetch()` call.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<FetchWithRetryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_FETCH_ATTEMPTS
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (response.ok) {
        return { ok: true, response, attempts: attempt }
      }
      const kind = classifyStatus(response.status)
      const message = `HTTP ${String(response.status)}`
      const isLastAttempt = attempt === maxAttempts
      if (!isRetryableKind(kind) || isLastAttempt) {
        return { ok: false, kind, attempts: attempt, message }
      }
      const retryAfterMs =
        kind === 'http_429' ? parseRetryAfterMs(response.headers.get('retry-after')) : null
      await sleep(retryAfterMs ?? computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs, random))
    } catch (error) {
      clearTimeout(timer)
      const timedOut = controller.signal.aborted
      const kind: FetchFailureKind = timedOut ? 'timeout' : 'network'
      const message = timedOut
        ? `timed out after ${String(timeoutMs)}ms`
        : error instanceof Error
          ? error.message
          : 'network error'
      if (attempt === maxAttempts) {
        return { ok: false, kind, attempts: attempt, message }
      }
      await sleep(computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs, random))
    }
  }
  // Unreachable (the loop always returns on its last iteration) — kept for exhaustiveness/TS.
  return { ok: false, kind: 'network', attempts: maxAttempts, message: 'exhausted retries' }
}
