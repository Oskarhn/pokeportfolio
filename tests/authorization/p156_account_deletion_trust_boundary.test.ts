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
  // A cold Edge worker plus a streamed request body is slow on the local relay; warm it first so
  // the assertions below measure the function and not the boot.
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
  duplex?: boolean
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
    ...(init.duplex ? { duplex: 'half' } : {}),
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

const exists = async (id: string): Promise<boolean> =>
  Boolean((await service.auth.admin.getUserById(id)).data.user)

const pendingRow = async (id: string): Promise<boolean> =>
  ((await service.from('account_deletion_requests').select('user_id').eq('user_id', id)).data ?? [])
    .length > 0

/** A stream that yields `chunks` chunks of `size` bytes and never sets a Content-Length. */
function chunked(chunks: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(new TextEncoder().encode('x'.repeat(size)))
    },
  })
}

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
    const before = await ownedDigests(db, a.user.id)

    const res = await send({ token: a.token, body: bodyFor(a) })
    expect(res.status).toBe(403)
    expect(res.json).toEqual({ error: 'reauthentication_unsupported' })
    expect(await exists(a.user.id)).toBe(true)
    expect(await pendingRow(a.user.id)).toBe(false)
    expect(await ownedDigests(db, a.user.id)).toEqual(before)
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

// Sizes are kept small on purpose: the LOCAL gateway relay does not complete a request whose body is
// larger than roughly 48-50 KB when the function answers before reading it (measured with curl and
// undici; the function's own bound is 4 KiB and does not depend on this). A hosted gateway's limit
// is not verified here.
describe('the request body is bounded before it is buffered, and only for someone who is signed in', () => {
  it('a chunked (streamed) body of 24 KB with no Content-Length is refused with 413 for a real session, and nothing is deleted', async () => {
    const a = await actor('p156-chunked')
    const res = await send({ token: a.token, body: chunked(6, 4096), duplex: true })
    expect(res.status).toBe(413)
    expect(await exists(a.user.id)).toBe(true)
    expect(await pendingRow(a.user.id)).toBe(false)
  })

  it('the publishable key (a real JWT for a non-user) is 401 with a small body and 413 with an oversize one, never 200', async () => {
    expect((await send({ token: ANON, body: '{}' })).status).toBe(401)
    expect((await send({ token: ANON, body: chunked(6, 4096), duplex: true })).status).toBe(413)
  })
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
