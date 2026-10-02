/**
 * delete-account — permanently deletes the CALLING user's account and data.
 *
 * Requires a real user session (`verify_jwt = true`), and then does not trust that: the bearer
 * token is re-resolved against the Auth server (`getUser(jwt)`, which also rejects a revoked
 * session or a deleted user — a bare signature check would not). The account deleted is the one
 * that token identifies; no id, email or role in the request body is ever used to choose a target.
 * A fresh password is required and is verified by Auth against the token's own account address.
 *
 * The decision logic lives in ../_shared/account-deletion.ts, dependency-injected so the same code
 * is exercised in-process by the test suites with deliberately failing dependencies. This file
 * only wires the real dependencies and speaks HTTP. In particular it contains NO fault-injection
 * hook, header or environment switch: nothing an HTTP caller sends can make a deletion fail.
 *
 * The service-role credential lives only in this function's environment. It is never returned,
 * never logged and has no path into the browser bundle. Logs carry event labels only — never a
 * token, password, email or user id.
 *
 * Sequence and recovery: docs/SECURITY.md §8 and docs/DEVELOPMENT.md ("Account deletion").
 */

import { createClient } from 'npm:@supabase/supabase-js@2.112.3'
import { handleAccountDeletion, type AccountDeletionDeps } from '../_shared/account-deletion.ts'
import { resolvePublishableKey, resolveServiceRoleKey } from '../_shared/service-key.ts'

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// A valid body is well under 1 KiB. Anything larger is refused before it is parsed.
const MAX_BODY_BYTES = 4096

// Purge budget for one request (the platform's Edge Function wall-clock limit is far larger; this
// leaves room for the Auth deletion and the response). Anything left over is finished by a retry.
const PURGE_TIME_BUDGET_MS = 90_000
const MAX_PURGE_CALLS = 500

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
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json',
      // A deletion response must never be cached or replayed by an intermediary.
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Refuses a request without having read its body. Replying while a large upload is still in
 * flight can leave the connection waiting for the client to finish sending (measured locally: a
 * 50 KB body answered early never completed), so the body is released first.
 */
async function refuse(request: Request, status: number, body: unknown): Promise<Response> {
  await request.body?.cancel().catch(() => undefined)
  return json(request, status, body)
}

function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/.exec(header.trim())
  return match?.[1] ?? null
}

interface AuthUserShape {
  identities?: { provider?: string }[] | null
  app_metadata?: { providers?: unknown }
  factors?: { status?: string }[] | null
}

/**
 * True only when a password typed just now is an honest proof of recent authentication for this
 * account: it has an email/password identity, and no verified second factor that a password alone
 * would sidestep. Positive evidence is required — an unexpected shape means false, not true.
 */
function passwordReauthenticationSupported(user: AuthUserShape): boolean {
  const providers = new Set<string>()
  for (const identity of user.identities ?? []) {
    if (typeof identity.provider === 'string') providers.add(identity.provider)
  }
  const listed = user.app_metadata?.providers
  if (Array.isArray(listed)) {
    for (const provider of listed) if (typeof provider === 'string') providers.add(provider)
  }
  if (!providers.has('email')) return false
  return !(user.factors ?? []).some((factor) => factor.status === 'verified')
}

/**
 * Reads at most `maxBytes` of the request body. `Content-Length` is only a hint (a chunked request
 * has none), so the limit is enforced on the stream itself and the read stops the moment it is
 * exceeded instead of buffering an arbitrarily large body first.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

interface AuthLikeError {
  status?: number
  code?: string
  message?: string
}

function buildDeps(
  supabaseUrl: string,
  secretKey: string,
  publishableKey: string,
): AccountDeletionDeps {
  const admin = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return {
    async authenticate(bearerToken) {
      const { data, error } = await admin.auth.getUser(bearerToken)
      if (error) {
        const status = (error as AuthLikeError).status
        // 4xx: the token is not a live session for a live user. Anything else is Auth being
        // unavailable, which is not the same statement and must not read as "unauthenticated".
        if (status !== undefined && status >= 400 && status < 500) return null
        throw new Error('auth unavailable')
      }
      const user = data.user
      if (!user?.email) return null
      return {
        id: user.id,
        email: user.email,
        passwordReauthentication: passwordReauthenticationSupported(user as AuthUserShape),
      }
    },

    async verifyPassword(email, password) {
      // A throwaway client: no storage, no refresh. A successful sign-in mints a session for a
      // user who is about to be deleted anyway.
      const verifier = createClient(supabaseUrl, publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      })
      const { error } = await verifier.auth.signInWithPassword({ email, password })
      if (!error) return 'ok'
      const status = (error as AuthLikeError).status
      if (status === 400) return 'invalid'
      return 'unavailable'
    },

    async beginDeletion(userId) {
      const { error } = await admin.rpc('begin_account_deletion', { p_user_id: userId })
      if (!error) return 'pending'
      // 23503: the auth user no longer exists, so the pending record's foreign key refused it.
      if (error.code === '23503') return 'user_gone'
      throw new Error('begin failed')
    },

    async purgeData(userId) {
      // Batched: each call deletes at most a bounded number of rows in one atomic transaction and
      // reports `complete` (a single call over a 10,000-lot account exceeded the 8 s statement
      // timeout in measurement). Progress is durable, so a request that runs out of time or budget
      // fails retryably and the next attempt carries on from where this one stopped.
      const deadline = Date.now() + PURGE_TIME_BUDGET_MS
      for (let call = 0; call < MAX_PURGE_CALLS && Date.now() < deadline; call++) {
        const { data, error } = await admin.rpc('purge_account_data', { p_user_id: userId })
        if (error) {
          if (error.message.includes('account_deletion_not_requested')) return 'account_gone'
          throw new Error('purge failed')
        }
        if ((data as { complete?: boolean } | null)?.complete === true) return 'purged'
      }
      throw new Error('purge did not finish within its budget')
    },

    async deleteAuthUser(userId) {
      // Hard delete: shouldSoftDelete = false. A soft-deleted user keeps a hashed identifier and
      // is not what "delete my account" promises.
      const { error } = await admin.auth.admin.deleteUser(userId, false)
      if (!error) return 'deleted'
      const status = (error as AuthLikeError).status
      const code = (error as AuthLikeError).code
      if (status === 404 || code === 'user_not_found') return 'not_found'
      throw new Error('auth delete failed')
    },

    async scrubAuditTrail(userId) {
      // Best effort by design: the function returns -1 where the platform withholds the privilege,
      // and an error here must never fail a deletion that has already happened.
      await admin.rpc('scrub_account_audit_trail', { p_user_id: userId })
    },

    async recordStage(userId, stage) {
      await admin
        .from('account_deletion_requests')
        .update({ last_stage: stage })
        .eq('user_id', userId)
    },

    log(event, fields) {
      console.log(JSON.stringify({ event, ...fields }))
    },
  }
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) })
  }
  if (request.method !== 'POST') {
    return refuse(request, 405, { error: 'method_not_allowed' })
  }

  // No bearer, no work: an anonymous caller (the publishable key alone passes the gateway's JWT
  // check) never gets its body read.
  const bearerToken = bearerTokenOf(request)
  if (!bearerToken) return refuse(request, 401, { error: 'unauthenticated' })

  const declaredLength = Number(request.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return refuse(request, 413, { error: 'bad_request' })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretKey = resolveServiceRoleKey()
  const publishableKey = resolvePublishableKey()
  if (!supabaseUrl || !secretKey || !publishableKey) {
    console.error(JSON.stringify({ event: 'delete-account.misconfigured' }))
    return json(request, 500, { error: 'server_error' })
  }

  let body: unknown
  try {
    const text = await readBoundedText(request, MAX_BODY_BYTES)
    if (text === null) return json(request, 413, { error: 'bad_request' })
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }

  try {
    const result = await handleAccountDeletion(buildDeps(supabaseUrl, secretKey, publishableKey), {
      bearerToken,
      body,
    })
    return json(request, result.status, result.body)
  } catch {
    // Anything not anticipated by the core. No detail leaves the function.
    console.error(JSON.stringify({ event: 'delete-account.unexpected_error' }))
    return json(request, 500, { error: 'server_error' })
  }
})
