/**
 * P203: the fail-closed guard that keeps destructive test suites away from any hosted backend.
 *
 * The database, authorization, adversarial and authenticated-E2E suites create and delete real
 * `auth.users` rows, issue invitations and write ledger data with the service-role key. They read
 * their target from the environment (`SUPABASE_URL`, `DB_URL`, ...), the same variables an
 * operator exports to run a hosted-project script — so a shell that still holds hosted values
 * would otherwise aim a destructive suite at Production without a single line of the suite
 * noticing. This module is the one place that decides what "local" means; every runner calls it
 * before a test can execute (tests/db/global-setup.ts, tests/support/local-target-global-setup.ts,
 * playwright.config.ts) and tests/config/local-target-guard.test.ts proves the wiring cannot be
 * silently removed.
 *
 * Policy: a target is local only when its hostname is a loopback name — `localhost`, `*.localhost`,
 * `127.0.0.1` or `[::1]`. The WHATWG URL parser normalises decimal/hex/octal IPv4 spellings, so
 * `http://2130706433` arrives here as `127.0.0.1`. Anything else, unparseable or hostless is
 * refused. There is deliberately no override switch: a test run that needs a remote database is a
 * different tool (scripts/), not a loosened test.
 *
 * Absent variables are accepted — the independent adversarial packages skip their DB-backed suites
 * with an explicit reason when no stack is configured, and that is the correct behaviour.
 *
 * Error messages name the variable and the offending host only, never a value that could be a
 * credential.
 */

export class NonLocalTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonLocalTargetError'
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost')
}

const REMEDIATION =
  'These suites create and delete users and rows, so they only run against a local Supabase stack ' +
  '(docs/TESTING.md). Unset the variable or point it at the local stack: ' +
  '`pnpm exec supabase status -o env`.'

/** Throws unless `value` is absent/empty or a URL whose host is loopback. */
export function assertLocalUrl(name: string, value: string | undefined): void {
  if (value === undefined || value === '') return
  let host: string
  try {
    host = new URL(value).hostname
  } catch {
    throw new NonLocalTargetError(
      `Refusing to run destructive tests: ${name} is not a parseable URL, so its target cannot be ` +
        `shown to be local. ${REMEDIATION}`,
    )
  }
  if (host === '' || !isLocalHostname(host)) {
    throw new NonLocalTargetError(
      `Refusing to run destructive tests: ${name} points at host "${host}", which is not a ` +
        `loopback address. ${REMEDIATION}`,
    )
  }
}

/** RFC 1918 private IPv4 literals: the Docker bridge (172.17.0.1 on a CI runner) lives here. */
function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * The erasure-registry address is the one target that is legitimately not loopback: it is the
 * address the stack's CONTAINERS use to reach the test harness's own sink on the host
 * (`host.docker.internal` on Docker Desktop, the 172.17.0.1 bridge on a Linux runner). It may be
 * loopback, the Docker host name or a private IPv4 literal; a public DNS name is a real registry
 * and is refused.
 */
export function assertLocalOrDockerHostUrl(name: string, value: string | undefined): void {
  if (value === undefined || value === '') return
  let host: string
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    throw new NonLocalTargetError(
      `Refusing to run destructive tests: ${name} is not a parseable URL, so its target cannot be ` +
        `shown to be local. ${REMEDIATION}`,
    )
  }
  if (
    host === '' ||
    !(isLocalHostname(host) || host === 'host.docker.internal' || isPrivateIPv4(host))
  ) {
    throw new NonLocalTargetError(
      `Refusing to run destructive tests: ${name} points at host "${host}", which is neither a ` +
        `loopback address, the Docker host nor a private network address. ${REMEDIATION}`,
    )
  }
}

/**
 * Hosted Supabase JWT keys carry the project in a `ref` claim; the local stack's demo keys do not.
 * A key that names a project is refused even when the URL looks local (a tunnelled or proxied
 * hosted project). Opaque keys (`sb_secret_...`) cannot be inspected and rely on the URL check.
 */
export function assertNotHostedKey(name: string, value: string | undefined): void {
  if (value === undefined || value === '') return
  const parts = value.split('.')
  if (parts.length !== 3) return
  let payload: unknown
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
    payload = JSON.parse(json)
  } catch {
    return
  }
  if (typeof payload === 'object' && payload !== null && 'ref' in payload) {
    throw new NonLocalTargetError(
      `Refusing to run destructive tests: ${name} is a hosted-project key (it carries a project ` +
        `"ref" claim). ${REMEDIATION}`,
    )
  }
}

const URL_VARIABLES = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'DB_URL', 'P153_DB_URL'] as const

const KEY_VARIABLES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
] as const

/** Checks every connection-target variable a destructive suite can read. */
export function assertLocalTestTarget(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of URL_VARIABLES) assertLocalUrl(name, env[name])
  assertLocalOrDockerHostUrl('ERASURE_REGISTRY_URL', env.ERASURE_REGISTRY_URL)
  for (const name of KEY_VARIABLES) assertNotHostedKey(name, env[name])
}
