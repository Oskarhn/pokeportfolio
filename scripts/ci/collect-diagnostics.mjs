#!/usr/bin/env node
/**
 * Collects redacted diagnostics from the local Supabase stack's containers after a failed job (P203).
 *
 *   node scripts/ci/collect-diagnostics.mjs [--out ci-diagnostics] [--filter supabase_] [--tail 400]
 *
 * Writes `containers.txt` (docker ps -a) and one `<container>.log` per matching container, each run
 * through the repository's credential redactor. Logs from a stack that failed mid-suite are the only
 * evidence of a gateway, auth or edge-runtime fault, and the stack is torn down by the next step;
 * without this a red db-tests job leaves only the test output.
 *
 * Never fails the job: it runs under `if: failure()` and a diagnostics problem must not mask the real
 * failure. Exits 0 even when docker is unavailable, saying so in containers.txt.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../lib/redact.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const outDir = option('--out', 'ci-diagnostics')
const filter = option('--filter', 'supabase_')
const tail = option('--tail', '400')

const docker = (...dockerArgs) =>
  spawnSync('docker', dockerArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

mkdirSync(outDir, { recursive: true })

const listing = docker(
  'ps',
  '-a',
  '--filter',
  `name=${filter}`,
  '--format',
  '{{.Names}}\t{{.Status}}',
)
if (listing.error || listing.status !== 0) {
  writeFileSync(
    join(outDir, 'containers.txt'),
    `docker unavailable: ${listing.error?.message ?? listing.stderr}\n`,
  )
  process.exit(0)
}
writeFileSync(join(outDir, 'containers.txt'), redact(listing.stdout))

for (const line of listing.stdout.split('\n').filter(Boolean)) {
  const name = line.split('\t')[0]
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) continue
  const logs = docker('logs', '--tail', tail, name)
  writeFileSync(join(outDir, `${name}.log`), redact(`${logs.stdout ?? ''}${logs.stderr ?? ''}`))
}
process.stdout.write(`diagnostics written to ${outDir}\n`)
