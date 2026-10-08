/**
 * CORS for the browser-reachable, JWT-verified Edge Functions (`search-prices`, `fetch-fx-rate`).
 *
 * `supabase.functions.invoke` from the web app is a cross-origin request carrying `Authorization`
 * and `Content-Type: application/json`, so the browser sends an `OPTIONS` preflight first and
 * refuses to send the real request unless that preflight is answered with matching
 * `Access-Control-Allow-*` headers. The platform does not answer it for the function: before this
 * helper existed both functions replied `405` to `OPTIONS`, so from a deployed origin the browser
 * blocked every call ("Failed to fetch", no request reached the function) and the client — which
 * deliberately swallows pricing failures — showed "—" for every Search/Card Detail market price
 * (P197D; the same shape `redeem-invitation` and `delete-account` already handle themselves).
 *
 * Same origin allow-list as those two (`ALLOWED_ORIGINS`, comma-separated, default the local dev
 * origin). CORS is not an authorization control here: the platform's `verify_jwt` is.
 */

const DEFAULT_ORIGIN = 'http://localhost:5173'

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? DEFAULT_ORIGIN)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

const ALLOWED_ORIGINS = parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS'))

export function corsHeaders(
  request: Request,
  allowedOrigins: readonly string[] = ALLOWED_ORIGINS,
): Record<string, string> {
  const origin = request.headers.get('Origin')
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

/**
 * Wraps a request handler so that `OPTIONS` is answered as a preflight and every other response —
 * success and error alike — carries the CORS headers. A browser hides a response that lacks them
 * (including a 401/405/500), so the caller could not even read the error status.
 */
export function withCors(
  handler: (request: Request) => Promise<Response>,
  allowedOrigins: readonly string[] = ALLOWED_ORIGINS,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, allowedOrigins) })
    }
    const response = await handler(request)
    for (const [name, value] of Object.entries(corsHeaders(request, allowedOrigins))) {
      response.headers.set(name, value)
    }
    return response
  }
}
