import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'
import { connectDb, ownedDigests } from '../db/lib/account-deletion-deps'
import { boundedPost, classifyHostileOutcome, type BoundedPostResult } from '../db/lib/bounded-post'
import { seedAccountLedger } from '../db/lib/account-ledger-fixture'

/**
 * P156: what P152's 32 HTTP attacks did not cover at the edge of the delete-account function —
 * accounts a password cannot stand in for, the request-body bound, HTTP verbs, response headers
 * on every refusal, and the preflight. Everything runs against the deployed local function.
 */

const FUNCTION_URL = `${process.env.SUPABASE_URL ?? ''}/functions/v1/delete-account`
const ANON = process.env.SUPABASE_ANON_KEY ?? ''

let service: TestClient
let db: pg.Client
const created: SyntheticUser[] = []

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
  // A cold Edge worker is slow on its first request; warm it first so the assertions below
  // measure the function and not the boot.
  await send({ token: ANON, body: '{}' })
})

afterAll(async () => {
  for (const user of created) {
    await service.from('account_deletion_requests').delete().eq('user_id', user.id)
    await deleteSyntheticUser(service, user.id)
  }
  await db.end()
}, 180_000)

interface Actor {
  user: SyntheticUser
  token: string
}

async function actor(label: string): Promise<Actor> {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  const client = await signInAs(user)
  await seedAccountLedger(service, user, client, label)
  return { user, token: (await client.auth.getSession()).data.session!.access_token }
}

async function send(init: {
  token?: string | null
  method?: string
  body?: BodyInit | null
  headers?: Record<string, string>
}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: ANON,
    ...init.headers,
  }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  const res = await fetch(FUNCTION_URL, {
    method: init.method ?? 'POST',
    headers,
    body: init.body ?? null,
  })
  const text = await res.text()
  let json: Record<string, unknown> | null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: res.status, text, json, headers: res.headers }
}

const bodyFor = (a: Actor) =>
  JSON.stringify({ expectedUserId: a.user.id, password: a.user.password, confirm: true })

/**
 * Per-table digests of everything the account owns, minus the two tables the
 * `m12-recompute-snapshots` pg_cron job (every minute) rewrites on its own: `portfolio_recompute_queue`
 * (drained) and `portfolio_snapshots` (recomputed). Both are derived, cron-owned and changed mid-test
 * in P196C without any request being involved; neither is account data a deletion path acts on.
 */
const CRON_DERIVED_TABLES = ['portfolio_recompute_queue', 'portfolio_snapshots']

const stableDigests = async (id: string): Promise<Record<string, string>> => {
  const owned = await ownedDigests(db, id)
  for (const table of CRON_DERIVED_TABLES) Reflect.deleteProperty(owned, table)
  return owned
}

const exists = async (id: string): Promise<boolean> =>
  Boolean((await service.auth.admin.getUserById(id)).data.user)

const pendingRow = async (id: string): Promise<boolean> =>
  ((await service.from('account_deletion_requests').select('user_id').eq('user_id', id)).data ?? [])
    .length > 0

describe('an account a password cannot stand in for is refused explicitly', () => {
  it('no email/password identity: 403 reauthentication_unsupported, no password check, nothing pending, nothing deleted', async () => {
    const a = await actor('p156-oauth-like')
    // Make it look like a sign-in method this endpoint has no reauthentication for: drop the email
    // identity and record another provider. (A real OAuth account would have been created that way.)
    await db.query("delete from auth.identities where user_id = $1 and provider = 'email'", [
      a.user.id,
    ])
    const updated = await service.auth.admin.updateUserById(a.user.id, {
      app_metadata: { provider: 'google', providers: ['google'] },
    })
    expect(updated.error).toBeNull()
    const before = await stableDigests(a.user.id)

    const res = await send({ token: a.token, body: bodyFor(a) })
    expect(res.status).toBe(403)
    expect(res.json).toEqual({ error: 'reauthentication_unsupported' })
    expect(await exists(a.user.id)).toBe(true)
    expect(await pendingRow(a.user.id)).toBe(false)
    expect(await stableDigests(a.user.id)).toEqual(before)
  })

  it('the same refusal holds with the CORRECT password: a correct password must not unlock it', async () => {
    const a = await actor('p156-oauth-like-2')
    await db.query("delete from auth.identities where user_id = $1 and provider = 'email'", [
      a.user.id,
    ])
    await service.auth.admin.updateUserById(a.user.id, {
      app_metadata: { provider: 'github', providers: ['github'] },
    })
    const res = await send({ token: a.token, body: bodyFor(a) })
    expect(res.status).toBe(403)
    expect((res.json as { error: string }).error).toBe('reauthentication_unsupported')
    expect(await exists(a.user.id)).toBe(true)
  })

  it('a password account is still deleted normally (the refusal is not a blanket refusal)', async () => {
    const a = await actor('p156-password-ok')
    const res = await send({ token: a.token, body: bodyFor(a) })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ status: 'deleted' })
    expect(await exists(a.user.id)).toBe(false)
  })
})

// The function's own bound (supabase/functions/delete-account/index.ts MAX_BODY_BYTES): a body of
// exactly this many bytes is read, one byte more is refused with 413.
const FUNCTION_BODY_LIMIT = 4096

// Measured behaviour of the LOCAL gateway (Kong -> Edge Runtime), P196C, docs/TESTING.md
// "Request-body bound over the local gateway". When the function answers 413 without consuming a
// body larger than about 16 KiB, the response intermittently never reaches the client: the Edge
// Runtime logs `user body write aborted` and Kong logs 499 once the client gives up, with no upstream
// error. Measured per request: 0 of ~600 at <= 16 KiB, 1-20 % at 20-48 KiB. Tests that must see the
// refusal therefore stay at or below 8 KiB (half the threshold) and demand exactly 413; the larger
// bodies are a separate, explicitly bounded tier that proves fail-closed behaviour with state checks.
const DETERMINISTIC_BODY_BYTES = 8192
const SPOOLED_BODY_BYTES = 24 * 1024
const REFUSAL_DEADLINE_MS = 10_000
const SPOOLED_DEADLINE_MS = 5_000
const SETTLE_MS = 1_000

const encoder = new TextEncoder()
const zeros = (n: number): Uint8Array => encoder.encode('x'.repeat(n))

/** `parts` chunks of `total / parts` bytes: sent with Transfer-Encoding: chunked, no Content-Length. */
const splitChunks = (total: number, parts: number): Uint8Array[] =>
  Array.from({ length: parts }, () => zeros(total / parts))

function hostile(
  token: string,
  payload: { body?: Uint8Array; chunks?: Uint8Array[] },
  deadlineMs: number,
): Promise<BoundedPostResult> {
  return boundedPost(FUNCTION_URL, {
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      Connection: 'close',
    },
    ...payload,
    deadlineMs,
  })
}

/** A syntactically valid body padded with an ignored field to exactly `bytes` bytes. */
function paddedBody(base: Record<string, unknown>, bytes: number): Uint8Array {
  const unpadded = JSON.stringify({ ...base, pad: '' })
  const body = JSON.stringify({ ...base, pad: 'x'.repeat(bytes - unpadded.length) })
  expect(body.length).toBe(bytes)
  return encoder.encode(body)
}

/** The server-side proof that a refused or aborted request changed nothing about the account. */
async function expectAccountUntouched(a: Actor, before: unknown): Promise<void> {
  expect(await exists(a.user.id)).toBe(true)
  expect(await pendingRow(a.user.id)).toBe(false)
  expect(await stableDigests(a.user.id)).toEqual(before)
}

describe('the request body is bounded before it is buffered, and only for someone who is signed in', () => {
  it('a body of exactly the limit is NOT refused as oversize: it reaches password handling (403 for a wrong password)', async () => {
    const a = await actor('p156-limit-under')
    const other = await actor('p156-limit-under-other')
    const before = await stableDigests(a.user.id)
    const body = paddedBody(
      { expectedUserId: a.user.id, password: other.user.password, confirm: true },
      FUNCTION_BODY_LIMIT,
    )
    const res = await hostile(a.token, { body }, REFUSAL_DEADLINE_MS)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.text)).toEqual({ error: 'reauthentication_failed' })
    await expectAccountUntouched(a, before)
  })

  it('the same exact-limit body from the publishable key (a real JWT for a non-user) reaches authentication: 401, not 413', async () => {
    const body = paddedBody(
      { expectedUserId: '00000000-0000-4000-8000-000000000000', password: 'x', confirm: true },
      FUNCTION_BODY_LIMIT,
    )
    expect((await hostile(ANON, { body }, REFUSAL_DEADLINE_MS)).status).toBe(401)
  })

  it('one byte over the limit, with an explicit Content-Length, is refused with 413 for a real session, and nothing is deleted', async () => {
    const a = await actor('p156-limit-over')
    const before = await stableDigests(a.user.id)
    const res = await hostile(
      a.token,
      { body: zeros(FUNCTION_BODY_LIMIT + 1) },
      REFUSAL_DEADLINE_MS,
    )
    expect(classifyHostileOutcome(res)).toBe('refused')
    expect(res.status).toBe(413)
    await expectAccountUntouched(a, before)
  })

  it('a chunked (streamed) body of 6 KB with no Content-Length is refused with 413 for a real session, and nothing is deleted', async () => {
    const a = await actor('p156-chunked')
    const before = await stableDigests(a.user.id)
    const res = await hostile(a.token, { chunks: splitChunks(6144, 3) }, REFUSAL_DEADLINE_MS)
    expect(classifyHostileOutcome(res)).toBe('refused')
    expect(res.status).toBe(413)
    await expectAccountUntouched(a, before)
  })

  it('the largest body that stays below the gateway threshold (8 KiB) is refused with 413 both ways', async () => {
    const a = await actor('p156-limit-max-det')
    const before = await stableDigests(a.user.id)
    const withLength = await hostile(
      a.token,
      { body: zeros(DETERMINISTIC_BODY_BYTES) },
      REFUSAL_DEADLINE_MS,
    )
    const streamed = await hostile(
      a.token,
      { chunks: splitChunks(DETERMINISTIC_BODY_BYTES, 4) },
      REFUSAL_DEADLINE_MS,
    )
    expect(withLength.status).toBe(413)
    expect(streamed.status).toBe(413)
    await expectAccountUntouched(a, before)
  })

  it('the publishable key is 401 with a small body and 413 with an oversize one (both framings), never 200', async () => {
    expect((await send({ token: ANON, body: '{}' })).status).toBe(401)
    const withLength = await hostile(
      ANON,
      { body: zeros(FUNCTION_BODY_LIMIT + 1) },
      REFUSAL_DEADLINE_MS,
    )
    const streamed = await hostile(ANON, { chunks: splitChunks(6144, 3) }, REFUSAL_DEADLINE_MS)
    expect(withLength.status).toBe(413)
    expect(streamed.status).toBe(413)
  })
})

describe('a body beyond the gateway threshold is bounded and fails closed, with the account proven untouched', () => {
  // 413 is the expected answer. The only other outcome allowed is the measured gateway behaviour: no
  // response before the deadline although every body byte was handed over. That is accepted ONLY
  // together with the state proof below; it is never accepted for a client that gave up before sending.
  const framings: Array<[string, { body?: Uint8Array; chunks?: Uint8Array[] }]> = [
    ['an explicit Content-Length', { body: zeros(SPOOLED_BODY_BYTES) }],
    ['chunked, no Content-Length', { chunks: splitChunks(SPOOLED_BODY_BYTES, 6) }],
  ]
  it.each(framings)(
    '24 KiB with %s: 413 or a bounded transport failure after the body was sent; never 2xx; nothing deleted',
    async (_name, payload) => {
      const a = await actor('p156-spooled')
      const before = await stableDigests(a.user.id)
      const res = await hostile(a.token, payload, SPOOLED_DEADLINE_MS)
      expect(['refused', 'fail-closed-transport']).toContain(classifyHostileOutcome(res))
      expect(res.elapsedMs).toBeLessThan(SPOOLED_DEADLINE_MS + 2_000)
      if (res.status !== null) expect(res.status).toBe(413)
      // With no response the server may still be working on the request; let it finish before the
      // state proof, otherwise a late mutation would be missed.
      if (res.status === null) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      await expectAccountUntouched(a, before)
      // The aborted request must not have wedged the function: a normal request still works.
      expect((await send({ token: ANON, body: '{}' })).status).toBe(401)
    },
    30_000,
  )
})

describe('only POST does anything', () => {
  it.each(['PUT', 'PATCH', 'DELETE', 'GET', 'HEAD'])(
    '%s with a valid session and a valid body is 405 and deletes nothing',
    async (method) => {
      const a = await actor(`p156-verb-${method.toLowerCase()}`)
      const res = await send({
        token: a.token,
        method,
        body: method === 'GET' || method === 'HEAD' ? null : bodyFor(a),
      })
      expect(res.status).toBe(405)
      expect(await exists(a.user.id)).toBe(true)
      expect(await pendingRow(a.user.id)).toBe(false)
    },
  )
})

describe('every refusal is uncacheable and origin-scoped', () => {
  it('401, 400, 403, 405 and 409 all carry Cache-Control: no-store and Vary: Origin', async () => {
    const a = await actor('p156-headers')
    const other = await actor('p156-headers-other')
    const cases = [
      {
        name: '401 non-user token (reaches the function)',
        run: () => send({ token: ANON, body: bodyFor(a) }),
        status: 401,
      },
      {
        name: '400 bad body',
        run: () => send({ token: a.token, body: '{"nope":true}' }),
        status: 400,
      },
      {
        name: '403 wrong password',
        run: () =>
          send({
            token: a.token,
            body: JSON.stringify({
              expectedUserId: a.user.id,
              password: other.user.password,
              confirm: true,
            }),
          }),
        status: 403,
      },
      {
        name: '405 verb',
        run: () => send({ token: a.token, method: 'PUT', body: bodyFor(a) }),
        status: 405,
      },
      {
        name: '409 mismatch',
        run: () =>
          send({
            token: a.token,
            body: JSON.stringify({
              expectedUserId: other.user.id,
              password: a.user.password,
              confirm: true,
            }),
          }),
        status: 409,
      },
    ]
    for (const c of cases) {
      const res = await c.run()
      expect(res.status, c.name).toBe(c.status)
      expect(res.headers.get('cache-control'), c.name).toBe('no-store')
      expect(res.headers.get('vary') ?? '', c.name).toContain('Origin')
    }
    expect(await exists(a.user.id)).toBe(true)
    expect(await exists(other.user.id)).toBe(true)
  })

  // The LOCAL stack's Kong answers preflights itself (200 with `Access-Control-Allow-Origin: *`) and
  // adds that header to every response, so the function's own origin allow-list cannot be observed
  // through it; hosted Supabase leaves CORS to the function. What can be pinned here is what must
  // hold in both: no credentialed cross-origin access is ever granted, and a preflight touches no account.
  it('a preflight or a foreign-origin POST never grants credentialed access and touches no account', async () => {
    const a = await actor('p156-cors')
    const pre = await fetch(FUNCTION_URL, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(pre.status).toBeLessThan(300)
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull()
    const post = await send({
      token: a.token,
      headers: { Origin: 'https://evil.example' },
      body: '{}',
    })
    expect(post.status).toBe(400)
    expect(post.headers.get('access-control-allow-credentials')).toBeNull()
    expect(await exists(a.user.id)).toBe(true)
  })
})
