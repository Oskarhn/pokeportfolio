/**
 * redeem-invitation — the only path by which an account comes into existence.
 *
 * Public endpoint by necessity: the person redeeming an invitation has no session yet, so there
 * is no JWT to verify (`verify_jwt = false` in supabase/config.toml). The invitation token is the
 * credential, and it is authenticated server-side against a stored SHA-256 hash. CORS is
 * configured but is not a security control — a non-browser client is not bound by it, and does
 * not need to be, because nothing here trusts the caller's origin, headers or body beyond
 * validating shape.
 *
 * The three-step shape exists to make failure recoverable (docs/SECURITY.md §5):
 *
 *   1. claim_invitation      validates the token, issues a two-minute claim   (service role)
 *   2. auth.admin.createUser creates the user; the S2 trigger spends the claim (Auth Admin API)
 *   3. finalize_…            records the redemption, increments use_count      (service role)
 *
 * If step 2 fails, step 3 never runs and the claim is released immediately; if this function dies
 * outright, the claim expires on its own. Either way the invitation becomes usable again, and no
 * sequence of failures can leave it permanently burnt or produce two accounts.
 *
 * The service-role credential lives only in the function's environment, injected by the platform.
 * It is never returned, never logged, and has no path into the browser bundle.
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import { checkPassword } from './password.ts'

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/** Deliberately identical for every invitation failure — see docs/SECURITY.md §5 on error detail. */
const INVITATION_INVALID = {
  error: 'invitation_invalid',
  message: 'This invitation link is not valid. It may have expired, been revoked, or been used.',
} as const

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin')
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function json(request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' },
  })
}

interface RedeemBody {
  token?: unknown
  password?: unknown
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }
  if (request.method !== 'POST') {
    return json(request, 405, { error: 'method_not_allowed' })
  }

  let body: RedeemBody
  try {
    body = (await request.json()) as RedeemBody
  } catch {
    return json(request, 400, { error: 'bad_request' })
  }

  const token = typeof body.token === 'string' ? body.token.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  // Shape only. Whether the token means anything is the database's decision, and the answer is
  // the same generic one either way.
  if (token.length < 16 || token.length > 256) {
    return json(request, 400, INVITATION_INVALID)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('redeem-invitation is missing its Supabase environment configuration')
    return json(request, 500, { error: 'server_error' })
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Step 1 — prove possession of the token, and take the claim the S2 trigger will demand.
  const claimed = await admin.rpc('claim_invitation', { p_token: token }).maybeSingle()
  if (claimed.error || !claimed.data) {
    if (claimed.error?.message.includes('invitation_pending')) {
      return json(request, 409, {
        error: 'invitation_pending',
        message: 'This invitation is already being redeemed. Try again in a couple of minutes.',
      })
    }
    // Logged without the token: an invitation id is a safe correlation handle, a token is not.
    console.warn('invitation claim rejected')
    return json(request, 400, INVITATION_INVALID)
  }

  const claimId = claimed.data.claim_id as string
  const email = claimed.data.invited_email as string

  // Checked after claiming rather than before only for the parts that need the address. Length
  // does not, so it is checked first and cheaply.
  const passwordProblem = checkPassword(password, email)
  if (passwordProblem) {
    await admin.rpc('release_invitation_claim', { p_claim_id: claimId })
    return json(request, 400, { error: 'password_invalid', message: passwordProblem.message })
  }

  // Step 2 — create the account. `email_confirm: true` because confirmation would be theatre
  // here: an administrator chose this address and delivered a 256-bit secret to it out of band,
  // and possession of that secret is stronger evidence of control than a confirmation click.
  // It also keeps account creation off the built-in mail provider's 2-emails-per-hour budget,
  // which is reserved for password recovery. See docs/SECURITY.md §5.
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (created.error || !created.data.user) {
    await admin.rpc('release_invitation_claim', { p_claim_id: claimId })
    const message = created.error?.message ?? ''
    if (/password/i.test(message)) {
      return json(request, 400, {
        error: 'password_invalid',
        message: 'That password was rejected. Choose a longer one.',
      })
    }
    console.error('account creation failed during invitation redemption')
    return json(request, 400, INVITATION_INVALID)
  }

  // Step 3 — record it. A failure here leaves a usable account whose invitation shows one fewer
  // redemption than reality; that is an accounting blemish in an admin-only view, not a security
  // problem, and it is not worth deleting a working account over.
  const finalized = await admin.rpc('finalize_invitation_redemption', {
    p_claim_id: claimId,
    p_user_id: created.data.user.id,
  })
  if (finalized.error) {
    console.error('invitation redemption recorded incompletely')
  }

  // No session is returned. The client signs in with the password it just set, through the
  // ordinary password grant, so there is exactly one way a session is ever minted.
  return json(request, 200, { ok: true, email })
})
