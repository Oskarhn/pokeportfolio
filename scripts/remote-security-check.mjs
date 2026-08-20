/**
 * Remote security verification — run against a deployed project, by hand, after any deploy that
 * touches auth, invitations, policies or grants. Not part of CI: CI must stay reproducible from Git
 * with no remote credentials (docs/TESTING.md §10), and this needs a real project to point at.
 *
 * It uses ONLY the publishable key — the key a browser holds, which is public by design. The secret
 * key is deliberately never read into this process. Everything here is asserted from the attacker's
 * side of the boundary, which is the side that matters, and it means running this can never leak a
 * credential.
 *
 * This exists because CI and the real project disagreed twice, and the second disagreement was a
 * privilege escalation: a signed-in non-admin could set `is_admin` on their own profile, while the
 * authorization suite was green. See
 * supabase/migrations/20260820120050_m4_revoke_then_grant_table_privileges.sql. A deployment is not
 * verified by the fact that CI was green on the code that produced it.
 *
 * Usage (PowerShell):
 *
 *   $env:SUPABASE_URL = "https://<ref>.supabase.co"
 *   $env:SUPABASE_PUBLISHABLE_KEY = "<publishable key>"
 *   node scripts/remote-security-check.mjs
 *
 * Phase 2 — the full redemption and post-sign-in checks — additionally needs a fresh, unredeemed
 * invitation for a throwaway address. Create one through privileged database access
 * (DEVELOPMENT.md §7) for an address under `.invalid`, and pass its raw token:
 *
 *   $env:INVITE_TOKEN = "<raw token>"
 *
 * The token is consumed by the run. Delete the account it creates afterwards.
 */

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
const inviteToken = process.env.INVITE_TOKEN
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set')

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` }

async function post(path, body, override = headers) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: override,
    body: JSON.stringify(body),
  })
  let parsed = {}
  try {
    parsed = await response.json()
  } catch {
    parsed = {}
  }
  return { status: response.status, body: parsed }
}

async function read(path, override = headers) {
  const response = await fetch(`${url}${path}`, { headers: override })
  let parsed = []
  try {
    parsed = await response.json()
  } catch {
    parsed = []
  }
  return { status: response.status, body: parsed }
}

const stamp = Date.now()

console.log('\n— Phase 1: what an anonymous attacker can reach —\n')

// Public signup, unknown address.
{
  const r = await post('/auth/v1/signup', {
    email: `remote-attacker-${stamp}@example.invalid`,
    password: `Remote-${crypto.randomUUID()}`,
  })
  const message = String(r.body.msg ?? r.body.message ?? r.body.error_description ?? '')
  record(
    'public signup for an uninvited address is rejected',
    r.status >= 400 && !r.body.id,
    `HTTP ${r.status}`,
  )
  record(
    'the rejection comes from the invite-only hook (gate 1 reached this project)',
    /invite-only/i.test(message),
    message.slice(0, 80) || '(no message)',
  )
}

// Public signup carrying forged metadata and a claimed role.
{
  const r = await post('/auth/v1/signup', {
    email: `remote-forger-${stamp}@example.invalid`,
    password: `Remote-${crypto.randomUUID()}`,
    data: { invited: true, is_admin: true },
    app_metadata: { invited: true, is_admin: true },
    role: 'service_role',
  })
  record(
    'forged metadata does not buy an account',
    r.status >= 400 && !r.body.id,
    `HTTP ${r.status}`,
  )
}

// The public pre-check answers, and answers negatively, for a token nobody issued.
{
  const r = await post('/rest/v1/rpc/invitation_status', { p_token: 'a-token-nobody-ever-issued' })
  const row = Array.isArray(r.body) ? r.body[0] : r.body
  record(
    'invitation_status is reachable anonymously and denies an unissued token',
    r.status === 200 && row?.valid === false && row?.invited_email === null,
    `HTTP ${r.status}`,
  )
}

// The privileged internals are not callable with a browser key.
for (const [fn, args] of [
  ['claim_invitation', { p_token: 'anything' }],
  [
    'finalize_invitation_redemption',
    { p_claim_id: crypto.randomUUID(), p_user_id: crypto.randomUUID() },
  ],
  ['release_invitation_claim', { p_claim_id: crypto.randomUUID() }],
  ['hash_invitation_token', { p_token: 'anything' }],
  ['before_user_created', { event: {} }],
  ['is_admin', {}],
]) {
  const r = await post(`/rest/v1/rpc/${fn}`, args)
  record(`${fn} is not callable anonymously`, r.status >= 400, `HTTP ${r.status}`)
}

// Nothing readable without a session.
for (const table of [
  'invitations',
  'invitation_claims',
  'invitation_overview',
  'profiles',
  'holdings',
  'purchases',
]) {
  const r = await read(`/rest/v1/${table}?select=*`)
  record(
    `${table} yields nothing to an anonymous caller`,
    r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0),
    `HTTP ${r.status}`,
  )
}

// The redemption function is deployed and refuses nonsense.
{
  const r = await post('/functions/v1/redeem-invitation', {
    token: 'a-token-nobody-ever-issued-anywhere',
    password: `Remote-${crypto.randomUUID()}`,
  })
  record(
    'redeem-invitation is deployed and refuses an unissued token',
    r.status === 400 && r.body.error === 'invitation_invalid',
    `HTTP ${r.status} ${String(r.body.error ?? '')}`,
  )
}

if (inviteToken) {
  console.log('\n— Phase 2: redemption, and what the resulting session can do —\n')

  const password = `Remote-${crypto.randomUUID()}`
  const attackerPassword = `Remote-${crypto.randomUUID()}`
  let invitedEmail = null

  {
    const r = await post('/rest/v1/rpc/invitation_status', { p_token: inviteToken })
    const row = Array.isArray(r.body) ? r.body[0] : r.body
    invitedEmail = row?.invited_email ?? null
    record(
      'the supplied invitation is valid and names its address',
      row?.valid === true,
      invitedEmail ?? '(none)',
    )
  }

  if (!invitedEmail) {
    console.log('\nPhase 2 needs a valid, unredeemed invitation. Stopping here.')
  } else {
    // The invited-address attack, against the real project.
    {
      const r = await post('/auth/v1/signup', { email: invitedEmail, password: attackerPassword })
      record(
        'public signup for the INVITED address is still rejected',
        r.status >= 400 && !r.body.id,
        `HTTP ${r.status}`,
      )
    }

    // Redeem, with an attacker-chosen address in the body for good measure.
    {
      const r = await post('/functions/v1/redeem-invitation', {
        token: inviteToken,
        password,
        email: `attacker-redirect-${stamp}@example.invalid`,
      })
      record(
        'redemption succeeds through the deployed function',
        r.status === 200 && r.body.ok === true,
        `HTTP ${r.status}`,
      )
      record(
        'the account is the invited address, not the one in the body',
        r.body.email === invitedEmail,
        String(r.body.email),
      )
    }

    // Sign in, twice: once correctly, once as the attacker.
    let accessToken = null
    {
      const r = await post('/auth/v1/token?grant_type=password', { email: invitedEmail, password })
      accessToken = r.body.access_token ?? null
      record('the new account can sign in', Boolean(accessToken), `HTTP ${r.status}`)
    }
    {
      const r = await post('/auth/v1/token?grant_type=password', {
        email: invitedEmail,
        password: attackerPassword,
      })
      record(
        "the attacker's password does not work on it",
        !r.body.access_token,
        `HTTP ${r.status}`,
      )
    }

    // Replay.
    {
      const r = await post('/functions/v1/redeem-invitation', {
        token: inviteToken,
        password: `Remote-${crypto.randomUUID()}`,
      })
      record(
        'replaying the redeemed token is rejected',
        r.status === 400 && r.body.error === 'invitation_invalid',
        `HTTP ${r.status}`,
      )
    }

    if (accessToken) {
      const authed = { ...headers, Authorization: `Bearer ${accessToken}` }

      const profiles = await read('/rest/v1/profiles?select=id,is_admin', authed)
      const rows = Array.isArray(profiles.body) ? profiles.body : []
      record(
        'the session sees exactly one profile — its own',
        rows.length === 1,
        `${rows.length} rows`,
      )
      record('and it is not an admin', rows[0]?.is_admin === false, String(rows[0]?.is_admin))

      const invitations = await read('/rest/v1/invitation_overview?select=id', authed)
      record(
        'a non-admin session sees no invitations',
        Array.isArray(invitations.body) && invitations.body.length === 0,
        `HTTP ${invitations.status}`,
      )

      // The escalation this script was extended to catch. Asserted on the stored value, not on the
      // HTTP status: a write that is accepted and then filtered would still be a pass on status
      // alone, and a write that is accepted and applied is the whole problem.
      if (rows[0]?.id) {
        const attempt = await fetch(`${url}/rest/v1/profiles?id=eq.${rows[0].id}`, {
          method: 'PATCH',
          headers: { ...authed, Prefer: 'return=representation' },
          body: JSON.stringify({ is_admin: true }),
        })
        const after = await read('/rest/v1/profiles?select=is_admin', authed)
        const stillNotAdmin = Array.isArray(after.body) && after.body[0]?.is_admin === false
        record(
          'the session cannot make itself an admin',
          attempt.status >= 400,
          `HTTP ${attempt.status}`,
        )
        record(
          '  …and is_admin is still false afterwards',
          stillNotAdmin,
          String(after.body?.[0]?.is_admin),
        )

        const disable = await fetch(`${url}/rest/v1/profiles?id=eq.${rows[0].id}`, {
          method: 'PATCH',
          headers: authed,
          body: JSON.stringify({ disabled_at: new Date().toISOString() }),
        })
        record(
          'the session cannot write disabled_at',
          disable.status >= 400,
          `HTTP ${disable.status}`,
        )
      }

      const claims = await read('/rest/v1/invitation_claims?select=id', authed)
      record(
        'the session cannot read invitation_claims',
        claims.status >= 400 || (Array.isArray(claims.body) && claims.body.length === 0),
        `HTTP ${claims.status}`,
      )

      const tokenHash = await read('/rest/v1/invitations?select=token_hash', authed)
      record(
        'the session cannot read token_hash',
        tokenHash.status >= 400,
        `HTTP ${tokenHash.status}`,
      )

      const privileged = await post('/rest/v1/rpc/hash_invitation_token', { p_token: 'x' }, authed)
      record(
        'the session cannot call the privileged internals',
        privileged.status >= 400,
        `HTTP ${privileged.status}`,
      )
    }
  }
} else {
  console.log('\nINVITE_TOKEN not set — phase 2 skipped. See the header for what it covers.')
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = 1
}
