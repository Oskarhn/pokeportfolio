import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type pg from 'pg'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
  type TestClient,
} from '../db/setup'
import { connectDb, ownedDigests } from '../db/lib/account-deletion-deps'
import {
  countOwnedRows,
  seedAccountLedger,
  USER_OWNED_TABLES,
} from '../db/lib/account-ledger-fixture'

/**
 * P152: attacking the DEPLOYED delete-account function over HTTP, from the outside, with nothing
 * but what a hostile signed-in user (or an anonymous one) actually holds. The invariant under
 * attack: a request can only ever delete the account its own verified session belongs to — and
 * only with a password typed for that account — never an unrelated auth.users row or anyone's data.
 */

const FUNCTION_URL = `${process.env.SUPABASE_URL ?? ''}/functions/v1/delete-account`
// The local stack's well-known JWT secret; used only to forge tokens for the negative tests.
const LOCAL_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long'

let service: TestClient
let db: pg.Client
const created: SyntheticUser[] = []

beforeAll(async () => {
  service = createServiceClient()
  db = await connectDb()
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
  client: TestClient
  token: string
}

async function actor(label: string, seed = true): Promise<Actor> {
  const user = await createSyntheticUser(service, label)
  created.push(user)
  const client = await signInAs(user)
  if (seed) await seedAccountLedger(service, user, client, label)
  const token = (await client.auth.getSession()).data.session!.access_token
  return { user, client, token }
}

interface HttpResult {
  status: number
  text: string
  json: Record<string, unknown> | null
  headers: Headers
}

async function call(
  token: string | null,
  body: unknown,
  init: { method?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: process.env.SUPABASE_ANON_KEY ?? '',
    ...init.headers,
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(FUNCTION_URL, {
    method: init.method ?? 'POST',
    headers,
    body: init.method === 'GET' ? undefined : (init.raw ?? JSON.stringify(body)),
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

const good = (who: Actor, overrides: Record<string, unknown> = {}) => ({
  expectedUserId: who.user.id,
  password: who.user.password,
  confirm: true,
  ...overrides,
})

async function exists(id: string): Promise<boolean> {
  const { data } = await service.auth.admin.getUserById(id)
  return Boolean(data.user)
}

async function pending(id: string): Promise<boolean> {
  const { data } = await service
    .from('account_deletion_requests')
    .select('user_id')
    .eq('user_id', id)
  return (data ?? []).length > 0
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** A correctly signed HS256 JWT — the forger knows the secret; the server must still say no. */
function forgeJwt(claims: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const sig = createHmac('sha256', LOCAL_JWT_SECRET)
    .update(`${head}.${payload}`)
    .digest('base64url')
  return `${head}.${payload}.${sig}`
}

const now = () => Math.floor(Date.now() / 1000)

async function untouched(who: Actor, before: Record<string, string>) {
  expect(await exists(who.user.id)).toBe(true)
  expect(await pending(who.user.id)).toBe(false)
  expect(await ownedDigests(db, who.user.id)).toEqual(before)
}

describe('unauthenticated and forged callers delete nothing', () => {
  it('no Authorization header at all is refused by the gateway', async () => {
    const victim = await actor('p152-atk-anon-victim')
    const before = await ownedDigests(db, victim.user.id)
    const res = await call(null, good(victim))
    expect(res.status).toBe(401)
    await untouched(victim, before)
  }, 60_000)

  it('the publishable (anon) key as bearer is refused by the function itself', async () => {
    const victim = await actor('p152-atk-anonkey-victim')
    const before = await ownedDigests(db, victim.user.id)
    const res = await call(process.env.SUPABASE_ANON_KEY ?? '', good(victim))
    expect(res.status).toBe(401)
    expect(res.json).toEqual({ error: 'unauthenticated' })
    await untouched(victim, before)
  }, 60_000)

  it('the service-role key is not an accepted way to name a victim', async () => {
    // Even a caller holding the secret key cannot use this endpoint as an "impersonate anyone"
    // primitive: it is not a user session, so the function refuses it.
    const victim = await actor('p152-atk-svc-victim')
    const before = await ownedDigests(db, victim.user.id)
    const res = await call(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', good(victim))
    expect(res.status).toBe(401)
    await untouched(victim, before)
  }, 60_000)

  it('garbage and truncated tokens are refused', async () => {
    const victim = await actor('p152-atk-garbage-victim')
    const before = await ownedDigests(db, victim.user.id)
    for (const token of ['garbage', 'a.b.c', victim.token.slice(0, -5), `${victim.token}x`]) {
      const res = await call(token, good(victim))
      expect(res.status, token.slice(0, 12)).toBe(401)
    }
    await untouched(victim, before)
  }, 60_000)

  it('an expired token with a valid signature is refused', async () => {
    const victim = await actor('p152-atk-expired-victim')
    const before = await ownedDigests(db, victim.user.id)
    const expired = forgeJwt({
      aud: 'authenticated',
      role: 'authenticated',
      sub: victim.user.id,
      email: victim.user.email,
      iat: now() - 7200,
      exp: now() - 3600,
      session_id: crypto.randomUUID(),
    })
    const res = await call(expired, good(victim))
    expect(res.status).toBe(401)
    await untouched(victim, before)
  }, 60_000)

  it('a validly signed, unexpired token for a session that does not exist is refused', async () => {
    // The forger knows the signing secret and names the victim in `sub`. Authority comes from a
    // live session server-side, not from a well-formed claim set.
    const victim = await actor('p152-atk-forged-victim')
    const before = await ownedDigests(db, victim.user.id)
    const forged = forgeJwt({
      aud: 'authenticated',
      role: 'authenticated',
      sub: victim.user.id,
      email: victim.user.email,
      iat: now(),
      exp: now() + 3600,
      session_id: crypto.randomUUID(),
    })
    const res = await call(forged, good(victim))
    expect(res.status).toBe(401)
    await untouched(victim, before)
  }, 60_000)

  it('a session revoked after the token was issued is refused even though the JWT still verifies', async () => {
    const a = await actor('p152-atk-revoked')
    const before = await ownedDigests(db, a.user.id)
    await service.auth.admin.signOut(a.token, 'global')
    const res = await call(a.token, good(a))
    expect(res.status).toBe(401)
    await untouched(a, before)
  }, 60_000)
})

describe('a signed-in user cannot name anyone else', () => {
  it('A with B as the intended account: 409, and A, B and every pending table are untouched', async () => {
    const a = await actor('p152-atk-mismatch-a')
    const b = await actor('p152-atk-mismatch-b')
    const beforeA = await ownedDigests(db, a.user.id)
    const beforeB = await ownedDigests(db, b.user.id)
    const res = await call(a.token, good(a, { expectedUserId: b.user.id }))
    expect(res.status).toBe(409)
    expect(res.json).toEqual({ error: 'identity_mismatch' })
    await untouched(a, beforeA)
    await untouched(b, beforeB)
  }, 60_000)

  it("A with B's password and B's id: still refused, nothing changes", async () => {
    const a = await actor('p152-atk-pw-a')
    const b = await actor('p152-atk-pw-b')
    const beforeA = await ownedDigests(db, a.user.id)
    const beforeB = await ownedDigests(db, b.user.id)
    const res = await call(a.token, {
      expectedUserId: b.user.id,
      password: b.user.password,
      confirm: true,
    })
    expect(res.status).toBe(409)
    await untouched(a, beforeA)
    await untouched(b, beforeB)
  }, 60_000)

  it("A's token with A's id but B's password: the password is checked against A, not B", async () => {
    const a = await actor('p152-atk-pw2-a')
    const b = await actor('p152-atk-pw2-b')
    const beforeA = await ownedDigests(db, a.user.id)
    const beforeB = await ownedDigests(db, b.user.id)
    const res = await call(a.token, good(a, { password: b.user.password }))
    expect(res.status).toBe(403)
    expect(res.json).toEqual({ error: 'reauthentication_failed' })
    await untouched(a, beforeA)
    await untouched(b, beforeB)
  }, 60_000)

  it("A naming B's email/id in every other field deletes only A — and only with A's password", async () => {
    const a = await actor('p152-atk-fields-a')
    const b = await actor('p152-atk-fields-b')
    const beforeB = await ownedDigests(db, b.user.id)
    const res = await call(
      a.token,
      good(a, {
        userId: b.user.id,
        user_id: b.user.id,
        id: b.user.id,
        target: b.user.id,
        email: b.user.email,
        sub: b.user.id,
      }),
    )
    expect(res.status).toBe(200)
    expect(await exists(a.user.id)).toBe(false)
    await untouched(b, beforeB)
  }, 60_000)

  it('forged user_metadata naming B has no effect on who is deleted or authorised', async () => {
    const a = await actor('p152-atk-meta-a')
    const b = await actor('p152-atk-meta-b')
    // A rewrites its own metadata (user-writable by design) to look like B and like an admin.
    const upd = await a.client.auth.updateUser({
      data: {
        sub: b.user.id,
        user_id: b.user.id,
        email: b.user.email,
        role: 'service_role',
        is_admin: true,
      },
    })
    expect(upd.error).toBeNull()
    const token = (await a.client.auth.getSession()).data.session!.access_token
    const beforeB = await ownedDigests(db, b.user.id)

    // Claiming B via the intent field is still an identity mismatch.
    const asB = await call(token, good(a, { expectedUserId: b.user.id }))
    expect(asB.status).toBe(409)
    await untouched(b, beforeB)

    // And the metadata does not stand in for a password.
    const noPassword = await call(token, good(a, { password: 'not the password at all' }))
    expect(noPassword.status).toBe(403)
    expect(await exists(a.user.id)).toBe(true)

    // The genuine request deletes A alone.
    const real = await call(token, good(a))
    expect(real.status).toBe(200)
    expect(await exists(a.user.id)).toBe(false)
    await untouched(b, beforeB)
  }, 90_000)

  it('a direct call that skips the UI but has the wrong password is refused and leaves no pending state', async () => {
    const a = await actor('p152-atk-nopw')
    const before = await ownedDigests(db, a.user.id)
    for (const password of ['wrong-password-000', ' ', a.user.password + 'x']) {
      const res = await call(a.token, good(a, { password }))
      expect(res.status, password).toBe(403)
    }
    await untouched(a, before)
  }, 60_000)
})

describe('malformed requests', () => {
  const bad: [string, unknown][] = [
    ['array body', [{ expectedUserId: 'x' }]],
    ['string body', 'delete'],
    ['null', null],
    ['no confirm', { expectedUserId: '00000000-0000-4000-8000-000000000000', password: 'x' }],
    ['non-uuid id', { expectedUserId: "'; drop table profiles; --", password: 'x', confirm: true }],
    [
      'object password',
      {
        expectedUserId: '00000000-0000-4000-8000-000000000000',
        password: { $gt: '' },
        confirm: true,
      },
    ],
    [
      'huge password',
      {
        expectedUserId: '00000000-0000-4000-8000-000000000000',
        password: 'x'.repeat(2000),
        confirm: true,
      },
    ],
  ]
  for (const [name, body] of bad) {
    it(`${name} → 400 with a stable code and no internals`, async () => {
      const a = await actor(`p152-atk-bad-${name.replace(/\W/g, '')}`, false)
      const res = await call(a.token, body)
      expect(res.status).toBe(400)
      expect(res.json).toEqual({ error: 'bad_request' })
      expect(await exists(a.user.id)).toBe(true)
      expect(await pending(a.user.id)).toBe(false)
    }, 60_000)
  }

  it('non-JSON and empty bodies are 400 for an authenticated caller, 401 for an anonymous one', async () => {
    const a = await actor('p152-atk-nonjson', false)
    expect((await call(a.token, null, { raw: '{not json' })).status).toBe(400)
    expect((await call(a.token, null, { raw: '' })).status).toBe(400)
    expect(
      (await call(process.env.SUPABASE_ANON_KEY ?? '', null, { raw: '{not json' })).status,
    ).toBe(401)
  }, 60_000)

  it('oversize bodies are refused before parsing; GET is 405', async () => {
    const a = await actor('p152-atk-size', false)
    // 5 000 bytes: over the function's 4 KiB bound, below the ~16 KiB size at which the local gateway
    // can lose the early 413 (docs/TESTING.md, "Request-body bound over the local gateway").
    const big = await call(a.token, null, { raw: JSON.stringify({ password: 'x'.repeat(5_000) }) })
    expect(big.status).toBe(413)
    const get = await call(a.token, null, { method: 'GET' })
    expect(get.status).toBe(405)
  }, 60_000)
})

describe('nothing internal ever leaves the function', () => {
  it('error and success bodies carry only stable codes — no stack, key, SQL or address', async () => {
    const a = await actor('p152-atk-leak')
    const b = await actor('p152-atk-leak-b')
    const responses = [
      await call(a.token, good(a, { expectedUserId: b.user.id })),
      await call(a.token, good(a, { password: 'nope-nope-nope' })),
      await call(a.token, 'garbage'),
      await call('garbage', good(a)),
      await call(null, good(a)),
    ]
    const secrets = [
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'x-never',
      'sb_secret',
      'service_role',
      'postgres',
      'SUPABASE_',
      'stack',
      '.ts:',
      'at Object',
      'select ',
      'insert ',
      a.user.email,
      b.user.email,
      a.user.password,
    ]
    for (const r of responses) {
      for (const secret of secrets) expect(r.text, `${r.status} ${secret}`).not.toContain(secret)
      for (const [name, value] of r.headers) {
        expect(`${name}: ${value}`).not.toContain(
          process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'x-never',
        )
      }
    }
    expect(
      (await call(a.token, good(a, { expectedUserId: b.user.id }))).headers.get('cache-control'),
    ).toBe('no-store')
  }, 90_000)

  it('CORS grants no credentialed cross-origin access to a foreign origin', async () => {
    // The local gateway (Kong) answers CORS itself with a wildcard; on the hosted platform the
    // function's own allow-list applies. Either way this endpoint authenticates by bearer header,
    // never by ambient cookie, so a wildcard without credentials exposes nothing — what must never
    // appear is credentialed access or an echoed foreign origin.
    const a = await actor('p152-atk-cors', false)
    const res = await call(a.token, 'garbage', { headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-credentials')).not.toBe('true')
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    const pre = await fetch(FUNCTION_URL, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(pre.headers.get('access-control-allow-credentials')).not.toBe('true')
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
  }, 60_000)
})

describe('replay and parallelism', () => {
  it("A's captured request, replayed after A is deleted (even naming B), is inert", async () => {
    const a = await actor('p152-atk-replay-a')
    const b = await actor('p152-atk-replay-b')
    const beforeB = await ownedDigests(db, b.user.id)
    expect((await call(a.token, good(a))).status).toBe(200)
    expect((await call(a.token, good(a))).status).toBe(401)
    expect((await call(a.token, good(a, { expectedUserId: b.user.id }))).status).toBe(401)
    await untouched(b, beforeB)
  }, 90_000)

  it("A's captured body replayed with B's session is an identity mismatch, not B's deletion", async () => {
    const a = await actor('p152-atk-swap-a', false)
    const b = await actor('p152-atk-swap-b')
    const beforeB = await ownedDigests(db, b.user.id)
    const res = await call(b.token, good(a))
    expect(res.status).toBe(409)
    await untouched(b, beforeB)
  }, 60_000)

  it('parallel requests for one account converge and never spill onto a neighbour', async () => {
    const a = await actor('p152-atk-par-a')
    const b = await actor('p152-atk-par-b')
    const beforeB = await ownedDigests(db, b.user.id)
    const results = await Promise.all([1, 2, 3].map(() => call(a.token, good(a))))
    for (const r of results) expect([200, 401, 500]).toContain(r.status)
    expect(results.some((r) => r.status === 200)).toBe(true)
    if (await exists(a.user.id)) expect((await call(a.token, good(a))).status).toBe(200)
    expect(await exists(a.user.id)).toBe(false)
    await untouched(b, beforeB)
  }, 120_000)
})

describe('privilege inspection: the destructive surface is not browser-reachable', () => {
  const RPCS = [
    ['begin_account_deletion', { p_user_id: '00000000-0000-4000-8000-000000000000' }],
    ['purge_account_data', { p_user_id: '00000000-0000-4000-8000-000000000000' }],
    ['scrub_account_audit_trail', { p_user_id: '00000000-0000-4000-8000-000000000000' }],
  ] as const
  const refused = (e: { code?: string; message?: string } | null) =>
    e !== null &&
    (e.code === '42501' || /permission denied|PGRST202/i.test(`${e.code} ${e.message}`))

  it('anon and authenticated cannot execute any of them, even with a real victim id', async () => {
    const a = await actor('p152-atk-priv-a', false)
    const victim = await actor('p152-atk-priv-victim')
    const before = await ownedDigests(db, victim.user.id)
    for (const [name] of RPCS) {
      for (const client of [createAnonClient(), a.client]) {
        const { error } = await client.rpc(name, { p_user_id: victim.user.id })
        expect(refused(error), `${name}: ${error?.message}`).toBe(true)
      }
    }
    await untouched(victim, before)
  }, 60_000)

  it('the catalog agrees: PUBLIC, anon and authenticated hold no EXECUTE; service_role does', async () => {
    for (const [name] of RPCS) {
      const res = await db.query<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
                coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false) as pub
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
        [name],
      )
      expect(res.rows[0], name).toEqual({ anon: false, auth: false, svc: true, pub: false })
    }
  })

  it('the request table is invisible and unwritable to browser roles, and cannot be forged', async () => {
    const a = await actor('p152-atk-tbl', false)
    for (const client of [createAnonClient(), a.client]) {
      expect(
        (await client.from('account_deletion_requests').select('user_id')).error,
      ).not.toBeNull()
      expect(
        (await client.from('account_deletion_requests').insert({ user_id: a.user.id })).error,
      ).not.toBeNull()
      expect(
        (
          await client
            .from('account_deletion_requests')
            .update({ last_stage: 'purged' })
            .eq('user_id', a.user.id)
        ).error,
      ).not.toBeNull()
      expect(
        (await client.from('account_deletion_requests').delete().eq('user_id', a.user.id)).error,
      ).not.toBeNull()
    }
    const priv = await db.query(
      `select has_table_privilege('anon', 'public.account_deletion_requests', 'SELECT,INSERT,UPDATE,DELETE') as anon,
              has_table_privilege('authenticated', 'public.account_deletion_requests', 'SELECT,INSERT,UPDATE,DELETE') as auth`,
    )
    expect(priv.rows[0]).toEqual({ anon: false, auth: false })
    // A user cannot put ANOTHER user into pending (write-blocking them) either.
    expect(await pending(a.user.id)).toBe(false)
  }, 60_000)

  it('all four new SECURITY DEFINER functions pin an empty search_path', async () => {
    const res = await db.query<{ proname: string; cfg: string[] | null; secdef: boolean }>(
      `select proname, proconfig as cfg, prosecdef as secdef from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in ('begin_account_deletion','purge_account_data','scrub_account_audit_trail',
                          'account_deletion_write_guard','account_deletion_write_guard_sealed')`,
    )
    expect(res.rows).toHaveLength(5)
    for (const row of res.rows) {
      expect(row.secdef, row.proname).toBe(true)
      expect(row.cfg, row.proname).toContain('search_path=""')
    }
  })

  it('every owned table still has RLS enabled (nothing here weakened it)', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r'
          and relname = any($1::text[])`,
      [[...USER_OWNED_TABLES.map((t) => t.table), 'account_deletion_requests']],
    )
    for (const row of res.rows) expect(row.relrowsecurity, row.relname).toBe(true)
    expect(res.rows.length).toBe(USER_OWNED_TABLES.length + 1)
    expect(await countOwnedRows(service, '00000000-0000-4000-8000-000000000000')).toBeTruthy()
  })
})
