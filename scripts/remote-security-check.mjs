/**
 * Remote security verification — run against a deployed project, by hand, after any deploy that
 * touches auth, invitations or grants. Not part of CI: CI must stay reproducible from Git with no
 * remote credentials (docs/TESTING.md §10), and this needs a real project to point at.
 *
 * It uses ONLY the publishable key — the key a browser holds, which is public by design. The secret
 * key is deliberately never read into this process. Everything asserted here is asserted from the
 * attacker's side of the boundary, which is the side that matters, and it means running this can
 * never leak a credential.
 *
 * Usage (PowerShell):
 *
 *   $env:SUPABASE_URL = "https://<ref>.supabase.co"
 *   $env:SUPABASE_PUBLISHABLE_KEY = "<publishable key>"
 *   node scripts/remote-security-check.mjs
 *
 * This exists because CI and the real project disagreed once already — see
 * supabase/migrations/20260820120040_m4_explicit_function_revokes.sql. A deployment is not
 * verified by the fact that CI was green on the code that produced it.
 */

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_PUBLISHABLE_KEY
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set')

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` }

async function post(path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers,
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

const stamp = Date.now()

// 1 — public signup, unknown address.
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
    'the rejection comes from the invite-only hook (gate 1 reached the remote)',
    /invite-only/i.test(message),
    message.slice(0, 90) || '(no message)',
  )
}

// 2 — public signup carrying forged metadata and a claimed role.
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

// 3 — the public invitation pre-check answers, and answers negatively, for a token nobody issued.
{
  const r = await post('/rest/v1/rpc/invitation_status', { p_token: 'a-token-nobody-ever-issued' })
  const row = Array.isArray(r.body) ? r.body[0] : r.body
  record(
    'invitation_status is reachable anonymously and denies an unissued token',
    r.status === 200 && row?.valid === false && row?.invited_email === null,
    `HTTP ${r.status}`,
  )
}

// 4 — the privileged internals are not callable with a browser key.
for (const [fn, args] of [
  ['claim_invitation', { p_token: 'anything' }],
  [
    'finalize_invitation_redemption',
    { p_claim_id: crypto.randomUUID(), p_user_id: crypto.randomUUID() },
  ],
  ['release_invitation_claim', { p_claim_id: crypto.randomUUID() }],
  ['hash_invitation_token', { p_token: 'anything' }],
]) {
  const r = await post(`/rest/v1/rpc/${fn}`, args)
  record(`${fn} is not callable with the publishable key`, r.status >= 400, `HTTP ${r.status}`)
}

// 5 — invitations and claims are not readable anonymously.
for (const table of ['invitations', 'invitation_claims', 'invitation_overview', 'profiles']) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*`, { headers })
  let payload = []
  try {
    payload = await response.json()
  } catch {
    payload = []
  }
  const empty = Array.isArray(payload) && payload.length === 0
  record(
    `${table} yields nothing to an anonymous caller`,
    response.status >= 400 || empty,
    `HTTP ${response.status}`,
  )
}

// 6 — the redemption function is deployed and refuses a nonsense token.
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

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} remote checks passed`)
if (failed.length) process.exitCode = 1
