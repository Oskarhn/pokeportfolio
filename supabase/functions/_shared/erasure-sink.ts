/**
 * Client for the off-platform erasure registry (P189). Contract: scripts/restore-gate/registry-sink.ts.
 *
 * Imports nothing and touches no `Deno` global, so the same code runs in the Edge Function and in
 * the Node test suites. The registry is the one thing in the deletion workflow that must live
 * OUTSIDE the database and its backups; this module is the function's only way to write to it, and
 * it is deliberately strict: it treats anything other than a well-formed "recorded" answer for the
 * very record it sent as a failure, because a deletion must never be reported restore-safe on the
 * strength of an answer that might not mean "durably recorded".
 *
 * The function holds only a bearer token for APPEND. It never holds the registry's integrity key, so
 * a compromised function can add erasures (which the DB workflow already controls) but cannot read,
 * rewrite or forge the chain.
 */

export interface SinkConfig {
  url: string
  token: string
}

export interface ErasureRecordInput {
  deletionId: string
  subject: string
  deletedAt: string
}

export interface ErasureReceipt {
  seq: number
  deletionId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Loopback and the Docker host as a development/CI stack sees it. 172.17.0.1 is docker0's address on
// a Linux runner; none of these is reachable from the public internet, which is why plain http is
// tolerated for exactly them and nothing else.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', '172.17.0.1'])
export const SINK_TIMEOUT_MS = 10_000

/**
 * Reads the sink configuration. Returns null when it is not (validly) configured, which makes the
 * function refuse deletions up front: deleting without being able to record the erasure would be
 * exactly the unsafe state this design exists to prevent. https is required except for the local
 * loopback / Docker-host names a development stack uses.
 */
export function loadSinkConfig(env: { get(name: string): string | undefined }): SinkConfig | null {
  const url = env.get('ERASURE_REGISTRY_URL')?.trim()
  const token = env.get('ERASURE_REGISTRY_TOKEN')?.trim()
  if (!url || !token || token.length < 24) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const local = LOCAL_HOSTS.has(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, token }
}

export class SinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SinkError'
  }
}

export async function appendErasure(
  config: SinkConfig,
  input: ErasureRecordInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ErasureReceipt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SINK_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(`${config.url}/v1/erasures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        deletion_id: input.deletionId,
        subject: input.subject,
        deleted_at: input.deletedAt,
        scope: 1,
      }),
      signal: controller.signal,
      redirect: 'error',
    })
  } catch {
    throw new SinkError('registry unreachable')
  } finally {
    clearTimeout(timer)
  }
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel().catch(() => undefined)
    throw new SinkError(`registry refused (${String(response.status)})`)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new SinkError('registry answer unreadable')
  }
  const o = body as Record<string, unknown> | null
  if (
    !o ||
    o.status !== 'recorded' ||
    o.subject !== input.subject ||
    typeof o.deletion_id !== 'string' ||
    !UUID.test(o.deletion_id) ||
    typeof o.seq !== 'number' ||
    !Number.isSafeInteger(o.seq) ||
    o.seq < 1
  ) {
    throw new SinkError('registry answer did not confirm the record')
  }
  return { seq: o.seq, deletionId: o.deletion_id }
}
