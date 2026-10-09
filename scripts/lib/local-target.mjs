/**
 * The one fail-closed definition of "this is a local test backend".
 *
 * Everything that creates or deletes accounts, or writes rows at volume, with a service-role key or a
 * direct Postgres connection — the database and authorization suites, the independent adversarial
 * packages, authenticated Playwright, the P117 / P132 campaigns, the portfolio benchmarks and the
 * synthetic-account seeders — reads its target from the same environment variables an operator
 * exports to run a hosted-project tool. A shell that still holds hosted values would otherwise aim a
 * destructive run at Production without any line of the run noticing. The project has exactly one
 * hosted instance and it is Production, so there is no "throwaway hosted project" to allow.
 *
 * This is a plain ES module (not TypeScript) so that `node scripts/x.mjs`, `tsx scripts/y.ts`,
 * Vitest, Playwright and the CI shell can all load the same code. `tests/support/local-target.ts`
 * only re-exports it.
 *
 * Policy
 * - Supabase API URLs (`SUPABASE_URL`, `VITE_SUPABASE_URL`): protocol http(s), host exactly
 *   `localhost`, `127.0.0.1` or `[::1]`, and no userinfo (`http://127.0.0.1@evil.example` and
 *   `http://localhost:80@evil.example` both name a REMOTE host, and a userinfo part is never
 *   legitimate here).
 * - Postgres URLs (`DB_URL`, `P153_DB_URL`): protocol postgres(ql), same host rule, and no query
 *   parameter that can redirect the connection. libpq and node-postgres let `?host=`, `?hostaddr=`
 *   or `?service=` override the host written in the authority, so only a short allow-list of
 *   harmless parameters is accepted.
 * - The host is judged on the WHATWG-parsed hostname, never a substring, so `localhost.evil.com`,
 *   `127.0.0.1.nip.io` and `localhost@evil.com` are remote. The parser normalises numeric IPv4
 *   spellings (`http://2130706433`, `http://0x7f.1`) to `127.0.0.1`; the host that is actually
 *   contacted is then loopback, so they are accepted. Other 127/8 addresses, `0.0.0.0`,
 *   IPv4-mapped IPv6 forms, a trailing-dot `localhost.` and `*.localhost` are refused: nothing here
 *   uses them and a name that has to be resolved is not a verified loopback endpoint.
 * - A value containing whitespace, a control character or a backslash is refused outright. The
 *   WHATWG parser silently strips tabs and newlines and rewrites `\` to `/`, so the string it
 *   judges can differ from the string a different parser (libpq, curl) would act on.
 * - The erasure-registry address is the one target that is legitimately not loopback: it is the
 *   address the stack's CONTAINERS use to reach the harness's own sink on the host. It may be
 *   loopback, `host.docker.internal` or a private IPv4 literal (the 172.17.0.1 docker0 bridge on a
 *   CI runner); a public name is a real registry and is refused. This rule is separate from the
 *   database rule, so a safe local stack is never rejected because Docker names its host differently.
 * - A legacy JWT key carrying a project `ref` claim is a hosted-project key and is refused even
 *   behind a loopback URL (a tunnelled project). Opaque `sb_*` keys cannot be inspected and rely
 *   on the URL rules.
 * - Unset or empty variables are accepted: there is nothing to aim, and the independent packages
 *   skip their database-backed suites with an explicit reason when no stack is configured.
 * - There is deliberately NO override flag or environment variable. A run that needs a remote
 *   database is a different tool, not a loosened test.
 *
 * Error messages name the variable and the offending host only — never a value that could carry a
 * credential, and never the URL's userinfo or query.
 */

export class NonLocalTargetError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NonLocalTargetError'
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True only for the three exact loopback host spellings the WHATWG parser can produce. */
export function isLocalHostname(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase())
}

const REMEDIATION =
  'These runs create and delete users and rows, so they only run against a local Supabase stack ' +
  '(docs/TESTING.md §9.1). Unset the variable or point it at the local stack: ' +
  '`pnpm exec supabase status -o env`.'

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:'])

/** Query parameters a Postgres URL may carry; anything else could re-point the connection. */
const SAFE_POSTGRES_PARAMS = new Set([
  'sslmode',
  'connect_timeout',
  'application_name',
  'statement_timeout',
])

// Whitespace, ASCII control characters (incl. NUL and DEL) and backslash.
const AMBIGUOUS_CHARACTERS = /[\s\\\u0000-\u001f\u007f]/

function refuse(name, detail) {
  throw new NonLocalTargetError(
    `Refusing to run destructive tests: ${name} ${detail} ${REMEDIATION}`,
  )
}

/** Parses `value` or throws; the raw value is never echoed. */
function parseTarget(name, value) {
  if (AMBIGUOUS_CHARACTERS.test(value)) {
    refuse(
      name,
      'contains whitespace, a control character or a backslash, so different URL parsers could read ' +
        'a different host from it.',
    )
  }
  try {
    return new URL(value)
  } catch {
    return refuse(name, 'is not a parseable URL, so its target cannot be shown to be local.')
  }
}

/**
 * Throws unless `value` is absent/empty or a URL that is shown to be a local Supabase API or
 * Postgres endpoint (see the module header). `name` is the variable, used in the message.
 */
export function assertLocalUrl(name, value) {
  if (value === undefined || value === null || value === '') return
  const url = parseTarget(name, String(value))
  const isHttp = HTTP_PROTOCOLS.has(url.protocol)
  const isPostgres = POSTGRES_PROTOCOLS.has(url.protocol)
  if (!isHttp && !isPostgres) {
    refuse(name, `uses the protocol "${url.protocol}", which is neither http(s) nor postgres(ql).`)
  }
  const host = url.hostname.toLowerCase()
  if (host === '' || !isLocalHostname(host)) {
    refuse(name, `points at host "${host}", which is not a loopback address.`)
  }
  if (isHttp && (url.username !== '' || url.password !== '')) {
    refuse(name, 'carries a userinfo part, which a Supabase API URL never legitimately has.')
  }
  if (isPostgres) {
    for (const key of url.searchParams.keys()) {
      if (!SAFE_POSTGRES_PARAMS.has(key.toLowerCase())) {
        refuse(
          name,
          `carries the query parameter "${key}", which can override the connection host.`,
        )
      }
    }
  }
}

/** RFC 1918 private IPv4 literals: the Docker bridge (172.17.0.1 on a CI runner) lives here. */
function isPrivateIPv4(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * The erasure-registry address: loopback, the Docker host name or a private IPv4 literal. This is
 * the harness's own test sink as the stack's containers see it, never the database target.
 */
export function assertLocalOrDockerHostUrl(name, value) {
  if (value === undefined || value === null || value === '') return
  const url = parseTarget(name, String(value))
  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    refuse(name, `uses the protocol "${url.protocol}", which is not http(s).`)
  }
  const host = url.hostname.toLowerCase()
  if (
    host === '' ||
    !(isLocalHostname(host) || host === 'host.docker.internal' || isPrivateIPv4(host))
  ) {
    refuse(
      name,
      `points at host "${host}", which is neither a loopback address, the Docker host nor a ` +
        'private network address.',
    )
  }
  if (url.username !== '' || url.password !== '') {
    refuse(name, 'carries a userinfo part, which a registry sink URL never legitimately has.')
  }
}

/**
 * Hosted Supabase JWT keys carry the project in a `ref` claim; the local stack's demo keys do not.
 * A key that names a project is refused even when the URL looks local (a tunnelled or proxied
 * hosted project). Opaque keys (`sb_secret_...`) cannot be inspected and rely on the URL check.
 */
export function assertNotHostedKey(name, value) {
  if (value === undefined || value === null || value === '') return
  const parts = String(value).split('.')
  if (parts.length !== 3) return
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return
  }
  if (typeof payload === 'object' && payload !== null && 'ref' in payload) {
    refuse(name, 'is a hosted-project key (it carries a project "ref" claim).')
  }
}

const URL_VARIABLES = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'DB_URL', 'P153_DB_URL']

const KEY_VARIABLES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
]

/**
 * Checks every connection-target variable a destructive run can read. Call it as the first
 * statement of an entrypoint, before any client, connection or file is created.
 */
export function assertLocalTestTarget(env) {
  for (const name of URL_VARIABLES) assertLocalUrl(name, env[name])
  assertLocalOrDockerHostUrl('ERASURE_REGISTRY_URL', env.ERASURE_REGISTRY_URL)
  for (const name of KEY_VARIABLES) assertNotHostedKey(name, env[name])
}
