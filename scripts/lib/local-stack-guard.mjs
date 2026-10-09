/**
 * P200: a fail-closed guard for everything that holds a Supabase SERVICE-ROLE key and writes.
 *
 * The database suites, the stress campaigns and the benchmarks create and delete synthetic
 * accounts and write at volume with the service role. Their target is whatever `SUPABASE_URL` says,
 * so a shell that still holds a hosted project's URL and key (the operator tools legitimately
 * need them) would turn `pnpm test:db` into a destructive run against real data. The project has
 * exactly one hosted instance and it is Production, so there is no "throwaway hosted project" to
 * allow: these tools run against a loopback stack or not at all, and there is deliberately no
 * override switch.
 *
 * Only the URL's parsed hostname is judged, never a substring: `localhost.evil.example`,
 * `127.0.0.1.nip.io` and `http://127.0.0.1@evil.example` are all remote hosts. The error names the
 * rule and the host, never a key.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** True only for a URL whose parsed host is a loopback address (or `*.localhost`). */
export function isLoopbackUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost')
}

/**
 * Throws unless `raw` points at a loopback stack. `what` names the variable for the message.
 * Returns the URL unchanged so it can be used inline.
 */
export function assertLoopbackSupabaseUrl(raw, what = 'SUPABASE_URL') {
  if (typeof raw !== 'string' || !isLoopbackUrl(raw)) {
    let host = 'an unparsable value'
    try {
      host = new URL(String(raw)).hostname
    } catch {
      // keep the generic wording
    }
    throw new Error(
      `refusing to run: ${what} must be a local Supabase stack (127.0.0.1 / localhost), got host ` +
        `"${host}". This tool writes with the service-role key and must never touch a hosted ` +
        'project. Start the local stack (pnpm db:start) and export its values instead.',
    )
  }
  return raw
}
