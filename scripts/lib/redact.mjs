/**
 * Credential redaction shared by everything that writes diagnostics to a place other people read:
 * the release-evidence report and the CI failure-log artifact (P203). Pattern-based, so it is a
 * safety net for output nobody meant to put a secret in, not a licence to log one.
 */

const SECRET_PATTERNS = [
  // JWTs (Supabase keys, session tokens)
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED-JWT]'],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[REDACTED-KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '[REDACTED-TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]'],
  // postgres://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:[REDACTED]@'],
  [/\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2[REDACTED]'],
  // unlabelled hex of 48+ characters is how tokens look; a 40-character commit SHA is left readable
  [/\b[0-9a-f]{48,}\b/gi, '[REDACTED-HEX]'],
]

/** @param {string} text @returns {string} text with credential-shaped substrings replaced */
export function redact(text) {
  let out = String(text)
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** @param {string} output @param {number} lines @returns {string} redacted last `lines` lines */
export function tailRedacted(output, lines = 25) {
  const kept = String(output).replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-lines)
  return redact(kept.join('\n'))
}
