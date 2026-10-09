/**
 * One-line structured logging for the ingest and pricing Edge Functions.
 *
 * Why this exists: until now the functions logged free-form `console.error` strings built from
 * caught errors, which can carry anything a library chose to put in a message (a URL with a key, a
 * header, an email in a Postgres error). The rules here are the logging contract:
 *
 *   - a log line is ONE JSON object: `{ fn, event, level, ...fields }`, so it can be filtered and
 *     counted instead of grepped;
 *   - fields are primitives only (string / number / boolean / null) with `snake_case` keys — no
 *     nested objects, no arrays, no raw errors, no provider payloads;
 *   - string values are control-character-stripped, redacted (bearer tokens, Supabase/JWT-shaped
 *     keys, `apikey`/`secret`/`token` assignments, e-mail addresses) and truncated;
 *   - callers pass error CLASSES and counts (`failure_kind: 'rate_limited'`), not error messages,
 *     wherever a class exists. `describeError` is the fallback for an unclassified one.
 */

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFields = Record<string, string | number | boolean | null>

const MAX_VALUE_LENGTH = 200
const KEY_SHAPE = /^[a-z][a-z0-9_]{0,40}$/

const REDACTIONS: [RegExp, string][] = [
  [/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'bearer [redacted]'],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[redacted-key]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [
    /\b(apikey|api_key|secret|token|password|authorization)\s*[=:]\s*[^\s,;&"']+/gi,
    '$1=[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'],
]

export function sanitizeLogValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  let out = value.replace(/[\u0000-\u001f\u007f]/g, ' ')
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out.length > MAX_VALUE_LENGTH ? `${out.slice(0, MAX_VALUE_LENGTH)}…` : out
}

/** The error's class name only — never its message — for an error that has no better class. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

export function buildLogLine(
  fn: string,
  event: string,
  level: LogLevel,
  fields: LogFields = {},
): string {
  const entry: Record<string, string | number | boolean | null> = {
    fn: sanitizeLogValue(fn),
    event: sanitizeLogValue(event),
    level,
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!KEY_SHAPE.test(key) || key === 'fn' || key === 'event' || key === 'level') continue
    if (typeof value === 'string') entry[key] = sanitizeLogValue(value)
    else if (typeof value === 'number') entry[key] = Number.isFinite(value) ? value : null
    else if (typeof value === 'boolean' || value === null) entry[key] = value
  }
  return JSON.stringify(entry)
}

export function logEvent(
  fn: string,
  event: string,
  fields: LogFields = {},
  level: LogLevel = 'info',
): void {
  const line = buildLogLine(fn, event, level, fields)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
