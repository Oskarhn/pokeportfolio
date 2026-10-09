/**
 * delete-account rehearsal against a LOCAL/ISOLATED stack and a REAL (test-namespace) registry (P195).
 *
 *   source <stack>/env.sh
 *   REGISTRY_URL=https://<test worker> ERASURE_OPERATOR_TOKEN=… ERASURE_REGISTRY_KEY=… \
 *     tsx scripts/release-rehearsal/delete-account-rehearsal.ts delete-normal <seed-ids.json>
 *     tsx scripts/release-rehearsal/delete-account-rehearsal.ts failure-attempt <state.json>
 *     tsx scripts/release-rehearsal/delete-account-rehearsal.ts failure-retry <state.json>
 *
 * `delete-normal` deletes the seeded deletion user through the deployed function and checks, from
 * outside, that the data and the login are gone, the old session is dead and the registry holds
 * the receipt. `failure-attempt` runs while the registry is made unavailable by the operator: it
 * creates a fresh synthetic user, requests deletion and requires a retryable refusal with the data
 * untouched and writes blocked. `failure-retry` runs after the registry is restored and requires
 * the deletion to complete. Prints statuses only; never an id, address or token.
 */
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- operator rehearsal tool over an untyped service client; every result is checked explicitly */
import { readFileSync, writeFileSync } from 'node:fs'
import { hashAccountId, parseRegistry, parseRegistryKey } from '../restore-gate/erasure-registry'
import {
  createServiceClient,
  createSyntheticUser,
  seedCatalog,
  signInAs,
  type SyntheticUser,
} from '../../tests/db/setup'
import { assertLocalTestTarget } from '../lib/local-target.mjs'

// P206: the shared fail-closed guard (SUPABASE_URL, DB_URL, keys) replaces a per-script regex. It
// does not judge REGISTRY_URL: this rehearsal talks to a real test-namespace registry by design.
assertLocalTestTarget(process.env)
const [command, file] = process.argv.slice(2)
const url = process.env.SUPABASE_URL ?? ''
const registry = process.env.REGISTRY_URL
const operator = process.env.ERASURE_OPERATOR_TOKEN
if (!command || !file || !registry || !operator || url === '') {
  console.error(
    'usage: see header; needs a loopback SUPABASE_URL, REGISTRY_URL and ERASURE_OPERATOR_TOKEN',
  )
  process.exit(64)
}
const key = parseRegistryKey(process.env.ERASURE_REGISTRY_KEY)
const service = createServiceClient()
let failed = false
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

const registryHead = async () =>
  (await (
    await fetch(`${registry}/v1/head`, { headers: { Authorization: `Bearer ${operator}` } })
  ).json()) as {
    seq: number
    records: number
  }
const registryExport = async () =>
  parseRegistry(
    await (
      await fetch(`${registry}/v1/export`, { headers: { Authorization: `Bearer ${operator}` } })
    ).text(),
    key,
  )

async function requestDeletion(user: SyntheticUser, token: string) {
  const res = await fetch(`${url}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_ANON_KEY ?? '',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ expectedUserId: user.id, password: user.password, confirm: true }),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  }
}

const purchasesOf = async (id: string) =>
  (await service.from('purchases').select('id', { count: 'exact', head: true }).eq('user_id', id))
    .count ?? -1
const authUserExists = async (id: string) =>
  (await service.auth.admin.getUserById(id)).data.user !== null

async function assertGone(user: SyntheticUser, oldToken: string) {
  check('auth account removed', !(await authUserExists(user.id)))
  check('owned purchases removed', (await purchasesOf(user.id)) === 0)
  const profile = await service
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('id', user.id)
  check('profile removed', (profile.count ?? -1) === 0)
  const me = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${oldToken}` },
  })
  check('old session is invalid', me.status >= 400, String(me.status))
  const relogin = await createRelogin(user)
  check('signing in again fails', !relogin)
  const parsed = await registryExport()
  check(
    'registry holds the receipt (external)',
    parsed.records.some((r) => r.subject === hashAccountId(user.id)),
  )
  const witness = await service
    .from('account_erasure_receipts')
    .select('registry_seq', { count: 'exact', head: true })
  check('database witness receipt exists', (witness.count ?? 0) >= 1)
}

async function createRelogin(user: SyntheticUser): Promise<boolean> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  })
  return res.ok
}

if (command === 'delete-normal') {
  const ids = JSON.parse(readFileSync(file, 'utf8')) as {
    userDelete: string
    userDeleteEmail: string
    userDeletePassword: string
  }
  const user: SyntheticUser = {
    id: ids.userDelete,
    email: ids.userDeleteEmail,
    password: ids.userDeletePassword,
  }
  const client = await signInAs(user)
  const token = (await client.auth.getSession()).data.session?.access_token ?? ''
  check(
    'before: account and data exist',
    (await authUserExists(user.id)) && (await purchasesOf(user.id)) > 0,
  )
  const before = await registryHead()
  const res = await requestDeletion(user, token)
  check(
    'delete-account answered 200 deleted',
    res.status === 200 && res.body?.status === 'deleted',
    String(res.status),
  )
  const after = await registryHead()
  check(
    'registry head advanced by exactly one',
    after.seq === before.seq + 1,
    `${String(before.seq)} -> ${String(after.seq)}`,
  )
  await assertGone(user, token)
} else if (command === 'failure-attempt') {
  const user = await createSyntheticUser(service, 'p195-registry-down')
  const client = await signInAs(user)
  const token = (await client.auth.getSession()).data.session?.access_token ?? ''
  const created = await client
    .rpc('create_purchase', {
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 1000,
        },
      ],
    })
    .single()
  check('synthetic user and purchase created', created.error === null)
  writeFileSync(file, JSON.stringify({ id: user.id, email: user.email, password: user.password }))
  const res = await requestDeletion(user, token)
  check(
    'no false success while the registry is unavailable',
    res.status !== 200,
    String(res.status),
  )
  check(
    'answer is a retryable registry-stage refusal',
    res.body?.retryable === true && res.body?.stage === 'registry',
    JSON.stringify({ error: res.body?.error, stage: res.body?.stage }),
  )
  check('account still exists (no destructive purge)', await authUserExists(user.id))
  check('data untouched', (await purchasesOf(user.id)) === 1)
  const blocked = await client
    .rpc('create_purchase', {
      p_purchased_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.pikachuVariantId,
          condition: 'NM',
          quantity: 1,
          unit_price_minor: 1000,
        },
      ],
    })
    .single()
  check('pending state blocks further writes', blocked.error !== null, blocked.error?.code ?? '')
  check('data still untouched after the blocked write', (await purchasesOf(user.id)) === 1)
} else if (command === 'failure-retry') {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as SyntheticUser
  const res0 = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: saved.email, password: saved.password }),
  })
  const session = (await res0.json()) as { access_token?: string }
  check('pending user can still authenticate to retry', Boolean(session.access_token))
  const before = await registryHead()
  const res = await requestDeletion(saved, session.access_token ?? '')
  check(
    'retry after recovery completes',
    res.status === 200 && res.body?.status === 'deleted',
    String(res.status),
  )
  const after = await registryHead()
  check('registry head advanced by exactly one', after.seq === before.seq + 1)
  await assertGone(saved, session.access_token ?? '')
} else {
  console.error('unknown command')
  process.exit(64)
}
process.exit(failed ? 1 : 0)
