/**
 * registry-export — pull the production erasure registry into a verified local file (P195).
 *
 *   ERASURE_REGISTRY_KEY=<64+ hex> ERASURE_OPERATOR_TOKEN=<token> \
 *     tsx scripts/restore-gate/registry-export.ts --url https://<worker> --out <file outside the repo>
 *
 * This is the registry's independent backup: the Worker's ledger is the source of truth, this file
 * is a copy the operator keeps elsewhere and hands to `restore-gate` (it is the same NDJSON format).
 * The download is verified with the operator's own copy of the key before it is written, written
 * atomically, and never replaces a file whose head is NEWER than the download (a rollback of the
 * backup is refused). Output: counts only, never an id or a subject.
 *
 * Exit codes: 0 ok · 2 registry/download refused (unreachable, wrong key, failed integrity,
 * older than the existing file) · 64 usage.
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import {
  parseRegistry,
  parseRegistryKey,
  readRegistryFile,
  RegistryError,
} from './erasure-registry'

export async function exportRegistry(opts: {
  url: string
  token: string
  key: Buffer
  out: string
  fetchImpl?: typeof fetch
}): Promise<{ records: number; seq: number }> {
  const target = new URL(opts.url)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) {
    throw new RegistryError('unreadable', 'the registry URL must be https')
  }
  let response: Response
  try {
    response = await (opts.fetchImpl ?? fetch)(`${target.origin}/v1/export`, {
      headers: { Authorization: `Bearer ${opts.token}` },
      redirect: 'error',
    })
  } catch {
    throw new RegistryError('unreadable', 'the registry is unreachable')
  }
  if (response.status !== 200) {
    throw new RegistryError(
      'unreadable',
      `the registry refused the export (${String(response.status)})`,
    )
  }
  const text = await response.text()
  const parsed = parseRegistry(text, opts.key) // throws on any integrity failure
  if (existsSync(opts.out)) {
    const existing = readRegistryFile(opts.out, opts.key)
    if (existing.head.seq > parsed.head.seq) {
      throw new RegistryError(
        'conflicting_record',
        'the existing backup is newer than the download',
      )
    }
  }
  const tmp = `${opts.out}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, opts.out)
  return { records: parsed.head.records, seq: parsed.head.seq }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const url = arg('--url')
  const out = arg('--out')
  const token = process.env.ERASURE_OPERATOR_TOKEN
  if (!url || !out || !token) {
    console.error(
      'usage: registry-export.ts --url <https url> --out <file>  (env: ERASURE_REGISTRY_KEY, ERASURE_OPERATOR_TOKEN)',
    )
    process.exitCode = 64
    return
  }
  try {
    const result = await exportRegistry({
      url,
      token,
      key: parseRegistryKey(process.env.ERASURE_REGISTRY_KEY),
      out,
    })
    console.log(
      `registry exported and verified: ${String(result.records)} records, head seq ${String(result.seq)}`,
    )
  } catch (e) {
    console.error(e instanceof RegistryError ? `refused: ${e.code}` : 'refused: unexpected error')
    process.exitCode = 2
  }
}

if (process.argv[1] && /registry-export\.ts$/.test(process.argv[1].replaceAll('\\', '/'))) {
  await main()
}
