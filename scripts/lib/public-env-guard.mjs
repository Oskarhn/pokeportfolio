/**
 * Fail-closed validator for the PUBLIC build-time configuration (P160).
 *
 * Everything with the `VITE_` prefix is inlined into the browser bundle by Vite, so a value that
 * lands in one of those variables is published to every visitor. The incident this exists for: a
 * Supabase SECRET key (`sb_secret_…`, full data access, bypasses RLS) was found in the repository
 * Actions variable `VITE_SUPABASE_URL` — a URL slot holding a key. This module makes that class of
 * mix-up impossible to build.
 *
 * Non-negotiable output contract: a failure names the FIELD and an error CATEGORY, and nothing
 * else. Never the value, a substring of it, its length, its prefix, a URL query, or an exception
 * message that might embed it (Node's own `new URL(...)` errors carry the rejected input, so every
 * parse in here swallows its exception and reports a category instead).
 *
 * What this can and cannot establish:
 *   - It rejects anything shaped like a secret key, a service-role JWT, or a key in a URL slot.
 *   - It accepts a `sb_publishable_…` key by SHAPE only. Shape is not proof of privilege level; the
 *     platform decides that. A legacy `anon` JWT is accepted for a LOCAL stack only, and is reported
 *     as a note rather than declared safe — an opaque JWT is never "safe by shape".
 *   - In the hosted/production profile the URL must be exactly `https://<20-char ref>.supabase.co`
 *     and the key must be a `sb_publishable_…` key; placeholders and legacy JWTs are refused.
 */

/** The only `VITE_` names the application reads (src/, vite.config.ts, .env.example). */
export const KNOWN_PUBLIC_VARS = Object.freeze([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_SUPABASE_PROJECT_REF',
  'VITE_APP_URL',
  'VITE_CF_ANALYTICS_TOKEN',
])

const SECRET_KEY_PREFIX = 'sb_secret_'
const PUBLISHABLE_PREFIX = 'sb_publishable_'
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{16,}$/
/** The placeholder convention CI and Playwright already use (`ci-placeholder-not-a-key`). */
const PLACEHOLDER_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*-placeholder-not-a-key$/
const PROJECT_REF = /^[a-z0-9]{20}$/
const HOSTED_HOST = /^([a-z0-9]{20})\.supabase\.co$/
/** Non-global for `.test()` (a global regex keeps `lastIndex` state); the global twin is for `.match()`. */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./
const JWT_EMBEDDED = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/
const SENSITIVE_NAME =
  /SECRET|SERVICE_?ROLE|PRIVATE|PASSW(?:OR)?D|CREDENTIAL|API_?KEY|ACCESS_?TOKEN|JWT|CLIENT_?SECRET/i
const SAFE_NAME = /^VITE_[A-Z0-9_]{1,64}$/

/** @typedef {{ field: string, category: string }} EnvFinding */

/** A variable name is echoed back only when it looks like a name; anything else is masked. */
function safeName(name) {
  return SAFE_NAME.test(name) ? name : 'VITE_<unprintable-name>'
}

/**
 * @param {string} token a JWT-shaped string
 * @returns {'service_role' | 'anon' | 'other' | 'undecodable'}
 */
function jwtRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const role = typeof payload === 'object' && payload !== null ? payload.role : undefined
    if (role === 'service_role') return 'service_role'
    if (role === 'anon') return 'anon'
    return 'other'
  } catch {
    return 'undecodable'
  }
}

/**
 * Secret-shape scan of arbitrary text — used on the built artefact, where the literal prefix
 * `sb_secret_` legitimately appears inside `@supabase/supabase-js` itself (it refuses a secret key
 * in a browser client), so the prefix alone would fail every correct bundle. The shape is the
 * prefix followed by a real token tail. Returns booleans only, never the match.
 *
 * @param {string} text
 * @returns {{ secretKey: boolean, serviceRoleJwt: boolean }}
 */
export function findSecretShapes(text) {
  const secretKey = /sb_secret_[A-Za-z0-9_-]{16,}/.test(text)
  let serviceRoleJwt = false
  for (const token of text.match(JWT_EMBEDDED) ?? []) {
    if (jwtRole(token) === 'service_role') serviceRoleJwt = true
  }
  return { secretKey, serviceRoleJwt }
}

/**
 * Config-value secret check. Stricter than {@link findSecretShapes}: a configured value has no
 * reason to contain the secret-key prefix at all, tail or not.
 *
 * @param {string} value
 * @returns {string | null} a category, or null
 */
function secretShapeCategory(value) {
  if (value.toLowerCase().includes(SECRET_KEY_PREFIX)) return 'secret_key_shaped'
  for (const token of value.match(JWT_EMBEDDED) ?? []) {
    if (jwtRole(token) === 'service_role') return 'service_role_jwt_shaped'
  }
  return null
}

/** RFC 1918 / loopback hosts a developer's local Supabase stack answers on. */
function isLocalHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/**
 * @param {string} raw
 * @returns {{ category: string | null, kind: 'hosted' | 'local' | null, ref: string | null }}
 */
function classifySupabaseUrl(raw) {
  const secret = secretShapeCategory(raw)
  if (secret) return { category: `url_is_${secret}`, kind: null, ref: null }
  if (raw.startsWith(PUBLISHABLE_PREFIX) || PUBLISHABLE_KEY.test(raw)) {
    return { category: 'url_is_publishable_key_shaped', kind: null, ref: null }
  }
  if (JWT_SHAPE.test(raw)) return { category: 'url_is_jwt_shaped', kind: null, ref: null }
  if (WHITESPACE_OR_CONTROL.test(raw)) {
    return { category: 'value_has_whitespace_or_control', kind: null, ref: null }
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    // Node's error object carries the rejected input. Discard it; report a category only.
    return { category: 'not_a_url', kind: null, ref: null }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { category: 'url_scheme_not_allowed', kind: null, ref: null }
  }
  if (url.username !== '' || url.password !== '') {
    return { category: 'url_has_credentials', kind: null, ref: null }
  }
  if (raw.includes('?') || raw.includes('#')) {
    return { category: 'url_has_query_or_fragment', kind: null, ref: null }
  }
  if (url.pathname !== '/') return { category: 'url_has_path', kind: null, ref: null }
  if (isLocalHost(url.hostname)) return { category: null, kind: 'local', ref: null }
  const host = HOSTED_HOST.exec(url.hostname)
  if (url.protocol !== 'https:') return { category: 'url_not_https', kind: null, ref: null }
  if (!host || url.port !== '') {
    return { category: 'url_host_not_supabase', kind: null, ref: null }
  }
  return { category: null, kind: 'hosted', ref: host[1] ?? null }
}

/**
 * @param {string} raw
 * @param {'hosted' | 'local' | null} urlKind
 * @param {boolean} requireHosted
 * @returns {{ category: string | null, note: string | null }}
 */
function classifyPublishableKey(raw, urlKind, requireHosted) {
  const localAllowed = urlKind === 'local' && !requireHosted
  if (WHITESPACE_OR_CONTROL.test(raw)) {
    return { category: 'value_has_whitespace_or_control', note: null }
  }
  if (raw.toLowerCase().includes(SECRET_KEY_PREFIX)) {
    return { category: 'key_secret_shaped', note: null }
  }
  const tokens = raw.match(JWT_EMBEDDED) ?? []
  if (tokens.length > 0) {
    const roles = tokens.map(jwtRole)
    if (roles.includes('service_role')) return { category: 'key_service_role_jwt', note: null }
    if (roles.every((r) => r === 'anon') && localAllowed) {
      return { category: null, note: 'legacy_anon_jwt_accepted_local_only' }
    }
    if (roles.every((r) => r === 'anon')) {
      return { category: 'key_legacy_jwt_not_allowed_here', note: null }
    }
    return { category: 'key_jwt_unverifiable', note: null }
  }
  if (/^https?:\/\//i.test(raw)) return { category: 'key_is_url', note: null }
  if (PUBLISHABLE_KEY.test(raw)) {
    return { category: null, note: 'publishable_key_accepted_by_shape_only' }
  }
  if (PLACEHOLDER_KEY.test(raw)) {
    return localAllowed
      ? { category: null, note: null }
      : { category: 'key_placeholder_not_allowed_here', note: null }
  }
  return { category: 'key_unrecognized_shape', note: null }
}

/** Non-secret http(s) URL with no userinfo (VITE_APP_URL). */
function classifyPlainUrl(raw) {
  const secret = secretShapeCategory(raw)
  if (secret) return `value_${secret}`
  if (WHITESPACE_OR_CONTROL.test(raw)) return 'value_has_whitespace_or_control'
  let url
  try {
    url = new URL(raw)
  } catch {
    return 'not_a_url'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url_scheme_not_allowed'
  if (url.username !== '' || url.password !== '') return 'url_has_credentials'
  return null
}

/**
 * Validates the effective `VITE_*` environment. Pure: no I/O, no logging.
 *
 * @param {Readonly<Record<string, string | undefined>>} env only the `VITE_` entries are read
 * @param {{ requireHosted?: boolean, requirePresent?: boolean }} [options]
 *   `requirePresent`: URL and publishable key must both be set (every build). `requireHosted`:
 *   the deploy profile — a real `https://<ref>.supabase.co` URL and a `sb_publishable_…` key; a
 *   local URL, a placeholder or a legacy JWT is refused.
 * @returns {{ ok: boolean, profile: 'hosted' | 'local' | 'invalid', problems: EnvFinding[],
 *   notes: EnvFinding[] }}
 */
export function validatePublicEnv(env, options = {}) {
  const requireHosted = options.requireHosted === true
  const requirePresent = options.requirePresent === true || requireHosted
  /** @type {EnvFinding[]} */
  const problems = []
  /** @type {EnvFinding[]} */
  const notes = []
  const isSet = (v) => typeof v === 'string' && v !== ''
  const problem = (field, category) => problems.push({ field, category })

  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY
  let urlKind = null
  let urlRef = null

  if (isSet(url)) {
    const c = classifySupabaseUrl(url)
    if (c.category) problem('VITE_SUPABASE_URL', c.category)
    else {
      urlKind = c.kind
      urlRef = c.ref
      if (requireHosted && c.kind !== 'hosted') {
        problem('VITE_SUPABASE_URL', 'local_config_not_allowed_in_production')
      }
    }
  } else if (requirePresent) {
    problem('VITE_SUPABASE_URL', 'missing')
  }

  if (isSet(key)) {
    const c = classifyPublishableKey(key, urlKind, requireHosted)
    if (c.category) problem('VITE_SUPABASE_PUBLISHABLE_KEY', c.category)
    if (c.note) notes.push({ field: 'VITE_SUPABASE_PUBLISHABLE_KEY', category: c.note })
  } else if (requirePresent) {
    problem('VITE_SUPABASE_PUBLISHABLE_KEY', 'missing')
  }

  const ref = env.VITE_SUPABASE_PROJECT_REF
  if (isSet(ref)) {
    if (!PROJECT_REF.test(ref)) problem('VITE_SUPABASE_PROJECT_REF', 'project_ref_malformed')
    else if (urlRef !== null && ref !== urlRef) {
      problem('VITE_SUPABASE_PROJECT_REF', 'project_ref_mismatch')
    }
  }

  const appUrl = env.VITE_APP_URL
  if (isSet(appUrl)) {
    const c = classifyPlainUrl(appUrl)
    if (c) problem('VITE_APP_URL', c)
  }

  const analytics = env.VITE_CF_ANALYTICS_TOKEN
  if (isSet(analytics)) {
    const secret = secretShapeCategory(analytics)
    if (secret) problem('VITE_CF_ANALYTICS_TOKEN', `value_${secret}`)
    else if (WHITESPACE_OR_CONTROL.test(analytics) || analytics.length > 128) {
      problem('VITE_CF_ANALYTICS_TOKEN', 'value_malformed')
    }
  }

  // Any other VITE_ variable is inlined the same way, so it gets the same secret-shape scrutiny,
  // plus a name check: a variable named like a credential has no business in a public bundle.
  for (const name of Object.keys(env)) {
    if (!name.startsWith('VITE_') || KNOWN_PUBLIC_VARS.includes(name)) continue
    const field = safeName(name)
    const value = env[name]
    if (SENSITIVE_NAME.test(name) && isSet(value)) {
      problem(field, 'sensitive_variable_name')
      continue
    }
    if (isSet(value)) {
      const secret = secretShapeCategory(value)
      if (secret) problem(field, `value_${secret}`)
    }
  }

  const profile = problems.length > 0 ? 'invalid' : urlKind === 'hosted' ? 'hosted' : 'local'
  return { ok: problems.length === 0, profile, problems, notes }
}

/**
 * Renders a result as printable lines. Field names and categories only.
 * @param {{ ok: boolean, profile: string, problems: EnvFinding[], notes: EnvFinding[] }} result
 * @returns {string[]}
 */
export function formatGuardReport(result) {
  const lines = []
  if (result.ok) {
    lines.push(`public-env-guard: OK (profile: ${result.profile})`)
  } else {
    lines.push(`public-env-guard: FAIL (${String(result.problems.length)} problem(s))`)
    for (const p of result.problems) lines.push(`  ${p.field}: ${p.category}`)
    lines.push(
      '  No values are printed. Fix the value in its source (the GitHub repository secret,',
      '  the Cloudflare Pages environment, .env.local); see docs/security/P160_SECRET_INCIDENT_RUNBOOK.md.',
    )
  }
  for (const n of result.notes) lines.push(`  note ${n.field}: ${n.category}`)
  return lines
}

/** Thrown by {@link assertPublicEnv}. Its message holds categories only. */
export class PublicEnvGuardError extends Error {
  /** @param {{ problems: EnvFinding[] }} result */
  constructor(result) {
    super(
      'public-env-guard refused this build: ' +
        result.problems.map((p) => `${p.field}=${p.category}`).join(', '),
    )
    this.name = 'PublicEnvGuardError'
    this.problems = result.problems
  }
}

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ requireHosted?: boolean, requirePresent?: boolean }} [options]
 */
export function assertPublicEnv(env, options) {
  const result = validatePublicEnv(env, options)
  if (!result.ok) throw new PublicEnvGuardError(result)
  return result
}

/**
 * The effective `VITE_*` set Vite will inline: `.env*` file values, overridden by variables that
 * already exist in the process environment (Vite's own precedence rule).
 *
 * @param {Readonly<Record<string, string>>} fileEnv `loadEnv(mode, dir, 'VITE_')`
 * @param {Readonly<Record<string, string | undefined>>} processEnv
 * @returns {Record<string, string | undefined>}
 */
export function collectPublicEnv(fileEnv, processEnv) {
  /** @type {Record<string, string | undefined>} */
  const merged = {}
  for (const [k, v] of Object.entries(fileEnv)) if (k.startsWith('VITE_')) merged[k] = v
  for (const [k, v] of Object.entries(processEnv)) if (k.startsWith('VITE_')) merged[k] = v
  return merged
}

/**
 * The deploy profile applies to every Cloudflare Pages build (`CF_PAGES=1`, set by Cloudflare's
 * own builder) and to any job that opts in explicitly (`PP_REQUIRE_HOSTED_PUBLIC_ENV=1`, set by the
 * CI Production deploy job).
 *
 * @param {Readonly<Record<string, string | undefined>>} processEnv
 */
export function resolveRequireHosted(processEnv) {
  return processEnv.CF_PAGES === '1' || processEnv.PP_REQUIRE_HOSTED_PUBLIC_ENV === '1'
}
