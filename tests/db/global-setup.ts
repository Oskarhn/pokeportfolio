import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startSink } from '../../scripts/restore-gate/registry-sink'
import { parseRegistryKey } from '../../scripts/restore-gate/erasure-registry'

/**
 * P189: starts the file-backed erasure registry sink the delete-account Edge Function records to.
 *
 * The local/CI stack hands the function ERASURE_REGISTRY_URL / ERASURE_REGISTRY_TOKEN at start
 * (supabase/config.toml [edge_runtime.secrets]); this serves exactly that address, so the DEPLOYED
 * function really talks to a registry over HTTP instead of a mock. It does not pretend to solve
 * production storage — see scripts/restore-gate/registry-sink.ts. When the variables are absent no
 * sink starts and every deletion through the function is refused (503 deletion_unavailable), which
 * the suites assert as the fail-closed behaviour.
 *
 * Exposes the registry file path as P189_REGISTRY_FILE so suites can read the real registry.
 */
let server: Server | undefined

export async function setup(): Promise<void> {
  const url = process.env.ERASURE_REGISTRY_URL
  const token = process.env.ERASURE_REGISTRY_TOKEN
  const keyText = process.env.ERASURE_REGISTRY_KEY
  if (!url || !token || !keyText) return
  const port = Number(new URL(url).port)
  // A STABLE path keyed by the port: the stack's database keeps its receipts across runs, so the
  // registry must outlive a run too (a registry that vanished while receipts remain is precisely
  // the stale-registry condition the gate refuses). `supabase db reset` clears the receipts; delete
  // this file together with it.
  const registryPath = join(tmpdir(), `p189-erasure-registry-${String(port)}.ndjson`)
  server = await startSink({
    registryPath,
    key: parseRegistryKey(keyText),
    token,
    host: '0.0.0.0',
    port,
  })
  process.env.P189_REGISTRY_FILE = registryPath
}

export async function teardown(): Promise<void> {
  if (server) {
    const s = server
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve()
      })
    })
  }
}
