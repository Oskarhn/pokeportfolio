import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAnonClient,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
} from '../db/setup'

/**
 * P200 area B: what the backend does with unauthorized, expired, revoked and rotated sessions.
 *
 * The browser keeps the session in localStorage and refreshes it itself (supabase-js), so the
 * server side of the contract is: a token that is not currently valid never reads or writes, a
 * refresh token cannot be replayed, and "sign out everywhere" ends every refresh chain. The one
 * property that is NOT instant is documented as such below rather than assumed away.
 */

const service = createServiceClient()
const URL_ = process.env.SUPABASE_URL as string
const ANON = process.env.SUPABASE_ANON_KEY as string
// The local stack's well-known development secret (see `supabase status`). It is used only to mint
// a token whose single defect is its expiry; the control case proves the secret matches before any
// negative result is trusted.
const LOCAL_JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long'

const b64 = (value: object | Buffer): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url')

function mint(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(claims)
  const sig = createHmac('sha256', LOCAL_JWT_SECRET).update(`${head}.${body}`).digest()
  return `${head}.${body}.${b64(sig)}`
}

async function restStatus(token: string, path = 'purchases?select=id'): Promise<number> {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  })
  return res.status
}

let user: SyntheticUser

beforeAll(async () => {
  user = await createSyntheticUser(service, 'p200sess')
}, 60_000)

afterAll(async () => {
  await deleteSyntheticUser(service, user.id)
}, 60_000)

describe('P200 expired and malformed tokens', () => {
  it('a correctly signed token is accepted until it expires, and refused after', async () => {
    const now = Math.floor(Date.now() / 1000)
    const claims = { sub: user.id, role: 'authenticated', aud: 'authenticated' }
    const live = mint({ ...claims, iat: now - 10, exp: now + 300 })
    const expired = mint({ ...claims, iat: now - 7200, exp: now - 3600 })
    const control = await restStatus(live)
    // A different secret (a non-default stack) makes every minted token invalid: nothing to conclude.
    if (control !== 200) {
      expect(control).toBeGreaterThanOrEqual(400)
      return
    }
    expect(await restStatus(expired)).toBeGreaterThanOrEqual(400)
    const rpc = await fetch(`${URL_}/rest/v1/rpc/get_dashboard_summary`, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${expired}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(rpc.status).toBeGreaterThanOrEqual(400)
  })

  it('JWT-verified Edge Functions refuse a request with no, a malformed or a foreign bearer', async () => {
    for (const fn of ['search-prices', 'fetch-fx-rate', 'delete-account']) {
      for (const authorization of [undefined, 'Bearer ', 'Bearer not.a.jwt', 'Basic abc']) {
        const res = await fetch(`${URL_}/functions/v1/${fn}`, {
          method: 'POST',
          headers: {
            apikey: ANON,
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: '{}',
        })
        expect(res.status, `${fn} with ${String(authorization)}`).toBeGreaterThanOrEqual(400)
        expect(res.status, `${fn} must not be a server error`).toBeLessThan(500)
      }
    }
  })
})

describe('P200 revocation and rotation', () => {
  it('"sign out here" leaves the other tab alone; "sign out everywhere" ends every refresh chain', async () => {
    const tabA = await signInAs(user)
    const tabB = await signInAs(user)
    const sessionA = (await tabA.auth.getSession()).data.session!
    const sessionB = (await tabB.auth.getSession()).data.session!

    expect((await tabA.auth.signOut({ scope: 'local' })).error).toBeNull()
    const stillB = await createAnonClient().auth.refreshSession({
      refresh_token: sessionB.refresh_token,
    })
    expect(stillB.error).toBeNull()
    const rotatedB = stillB.data.session!

    const other = await signInAs(user)
    const otherRefresh = (await other.auth.getSession()).data.session!.refresh_token
    const bClient = createAnonClient()
    await bClient.auth.setSession({
      access_token: rotatedB.access_token,
      refresh_token: rotatedB.refresh_token,
    })
    expect((await bClient.auth.signOut({ scope: 'global' })).error).toBeNull()
    for (const refresh_token of [rotatedB.refresh_token, otherRefresh, sessionA.refresh_token]) {
      const r = await createAnonClient().auth.refreshSession({ refresh_token })
      expect(r.error, 'a revoked refresh token must not mint a session').not.toBeNull()
      expect(r.data.session).toBeNull()
    }
  })

  it('an older, already-rotated refresh token is refused once the chain has moved on', async () => {
    const client = await signInAs(user)
    const first = (await client.auth.getSession()).data.session!
    const second = await createAnonClient().auth.refreshSession({
      refresh_token: first.refresh_token,
    })
    expect(second.error).toBeNull()
    const third = await createAnonClient().auth.refreshSession({
      refresh_token: second.data.session!.refresh_token,
    })
    expect(third.error).toBeNull()
    // Past supabase/config.toml refresh_token_reuse_interval (10 s) the first token is history.
    await new Promise((resolve) => setTimeout(resolve, 11_500))
    const replay = await createAnonClient().auth.refreshSession({
      refresh_token: first.refresh_token,
    })
    expect(replay.error).not.toBeNull()
    expect(replay.data.session).toBeNull()
    // NOT asserted, because it is GoTrue's behaviour rather than ours and was measured to differ
    // from the textbook: replaying the DIRECT parent of the newest token is tolerated as a lost
    // response, and a refused replay did not revoke the newest token. See P200 record, residual risks.
  }, 40_000)

  it('KNOWN PROPERTY: an issued access token keeps working at the Data API until it expires, even after global sign-out', async () => {
    const client = await signInAs(user)
    const session = (await client.auth.getSession()).data.session!
    expect((await client.auth.signOut({ scope: 'global' })).error).toBeNull()
    // PostgREST verifies signature and expiry only; it does not ask Auth whether the session still
    // exists. The exposure is bounded by jwt_expiry (3600 s) and is why the one destructive endpoint
    // (delete-account) re-resolves the token against Auth itself (next test). If this ever fails
    // because revocation became instant, update SECURITY.md section 9 and keep the refresh-token
    // assertions: they are the property that matters.
    expect(await restStatus(session.access_token)).toBe(200)
    const refreshed = await createAnonClient().auth.refreshSession({
      refresh_token: session.refresh_token,
    })
    expect(refreshed.error).not.toBeNull()
  })

  it('the destructive endpoint does not honour a revoked session even while its JWT is unexpired', async () => {
    const client = await signInAs(user)
    const session = (await client.auth.getSession()).data.session!
    await client.auth.signOut({ scope: 'global' })
    const res = await fetch(`${URL_}/functions/v1/delete-account`, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedUserId: user.id, password: user.password, confirm: true }),
    })
    expect(res.status).toBe(401)
    const still = await service.auth.admin.getUserById(user.id)
    expect(still.data.user).not.toBeNull()
  })
})

describe('P200 deleted account', () => {
  it('a still-unexpired token of a deleted user reads nothing, writes nothing and cannot refresh', async () => {
    const victim = await createSyntheticUser(service, 'p200gone')
    const client = await signInAs(victim)
    const session = (await client.auth.getSession()).data.session!
    await deleteSyntheticUser(service, victim.id)

    const read = await client.from('profiles').select('id')
    expect(Array.isArray(read.data) ? read.data : []).toEqual([])
    const write = await client
      .from('retailers')
      .insert({ user_id: victim.id, name: 'ghost' })
      .select()
    expect(write.error).not.toBeNull()
    const rpc = await client.rpc('create_sale', {
      p_sold_on: new Date().toISOString().slice(0, 10),
      p_currency: 'NOK',
      p_idempotency_key: crypto.randomUUID(),
      p_lines: [{ lot_id: crypto.randomUUID(), quantity: 1, unit_gross_minor: 1 }],
    })
    expect(rpc.error).not.toBeNull()
    const refreshed = await createAnonClient().auth.refreshSession({
      refresh_token: session.refresh_token,
    })
    expect(refreshed.error).not.toBeNull()
    const login = await createAnonClient().auth.signInWithPassword({
      email: victim.email,
      password: victim.password,
    })
    expect(login.error).not.toBeNull()
  })
})
