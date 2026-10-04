/**
 * Synthetic smoke test for a deployed erasure registry (P195). Writes two RANDOM, throw-away
 * subjects — never a real account — so run it only against the `-test` Worker namespace
 * (`wrangler deploy --env test`); the production ledger is append-only and cannot be cleaned.
 *
 *   ERASURE_APPEND_TOKEN=… ERASURE_OPERATOR_TOKEN=… ERASURE_REGISTRY_KEY=… \
 *     tsx scripts/erasure-registry-worker/smoke.ts https://<test worker>
 *
 * Exits non-zero on the first contract violation. Prints statuses and counts only.
 */
import { hashAccountId, parseRegistry, parseRegistryKey } from '../restore-gate/erasure-registry'

const base = process.argv[2]
const append = process.env.ERASURE_APPEND_TOKEN
const operator = process.env.ERASURE_OPERATOR_TOKEN
if (!base || !append || !operator) {
  console.error(
    'usage: smoke.ts <worker url>  (env: ERASURE_APPEND_TOKEN, ERASURE_OPERATOR_TOKEN, ERASURE_REGISTRY_KEY)',
  )
  process.exit(64)
}
if (/pokeportfolio-erasure-registry\.[^/]*workers\.dev/.test(base)) {
  console.error(
    'refused: this looks like the PRODUCTION registry; the smoke test writes synthetic records',
  )
  process.exit(64)
}
const key = parseRegistryKey(process.env.ERASURE_REGISTRY_KEY)

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
const iso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const post = (deletion: string, user: string) =>
  fetch(`${base}/v1/erasures`, {
    method: 'POST',
    headers: bearer(append),
    body: JSON.stringify({
      deletion_id: deletion,
      subject: hashAccountId(user),
      deleted_at: iso(),
      scope: 1,
    }),
  })
let failed = false
const expectStatus = (label: string, got: number, want: number) => {
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${String(got)}`)
  if (got !== want) failed = true
}

const userA = crypto.randomUUID()
const userB = crypto.randomUUID()
const delA = crypto.randomUUID()
const delB = crypto.randomUUID()
const before = (await (await fetch(`${base}/v1/head`, { headers: bearer(operator) })).json()) as {
  seq: number
}
expectStatus('append A', (await post(delA, userA)).status, 201)
expectStatus('repeat A (idempotent)', (await post(delA, userA)).status, 200)
expectStatus('append B', (await post(delB, userB)).status, 201)
expectStatus('deletion id reused for another subject', (await post(delA, userB)).status, 409)
expectStatus(
  'append token cannot read head',
  (await fetch(`${base}/v1/head`, { headers: bearer(append) })).status,
  403,
)
expectStatus('no token', (await fetch(`${base}/v1/export`)).status, 401)
const exported = await fetch(`${base}/v1/export`, { headers: bearer(operator) })
expectStatus('export', exported.status, 200)
const parsed = parseRegistry(await exported.text(), key)
const grew = parsed.head.seq - before.seq
console.log(
  `${grew === 2 ? 'ok  ' : 'FAIL'} export verifies with the canonical parser; head grew by ${String(grew)}`,
)
if (grew !== 2) failed = true
process.exit(failed ? 1 : 0)
