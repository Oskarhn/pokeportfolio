/* global Deno */
/**
 * Runs the REAL Edge Function code for one browser-reachable function once under Deno and prints
 * how it answers a CORS preflight and a request without a session, as JSON on stdout.
 *
 *   deno run --no-lock --allow-read --allow-env cors-harness.mjs <functionsDir> <slug> <origin> <disallowedOrigin>
 *
 * `ALLOWED_ORIGINS` is set to `<origin>` before the function is imported, exactly like the
 * deployed secret. The function's handler is captured from `Deno.serve`. Nothing is fetched and no
 * database is touched: the unauthenticated request is refused (401) before either happens.
 *
 * `functionsDir` is a `supabase/functions` directory: the working tree's, or a checkout of an older
 * release, so the same probe can show the "before" behaviour.
 */
import { pathToFileURL } from 'node:url'

const [functionsDir, slug, origin, disallowedOrigin] = Deno.args

Deno.env.set('ALLOWED_ORIGINS', origin)
Deno.env.set('SUPABASE_URL', 'http://stub.invalid')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'stub-not-a-key')

let handler
Deno.serve = (h) => {
  handler = h
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }
}
await import(pathToFileURL(`${functionsDir}/${slug}/index.ts`).href)
if (handler === undefined) throw new Error('the function did not register a Deno.serve handler')

const url = `http://localhost/functions/v1/${slug}`
const preflightHeaders = {
  origin,
  'access-control-request-method': 'POST',
  'access-control-request-headers': 'authorization,apikey,content-type,x-client-info',
}
const describeResponse = async (response) => ({
  status: response.status,
  allowOrigin: response.headers.get('access-control-allow-origin'),
  allowHeaders: response.headers.get('access-control-allow-headers'),
  allowMethods: response.headers.get('access-control-allow-methods'),
  vary: response.headers.get('vary'),
  contentType: response.headers.get('content-type'),
  body: await response.text(),
})

const postWithoutSession = (from) =>
  handler(
    new Request(url, {
      method: 'POST',
      headers: { origin: from, 'content-type': 'application/json' },
      body: '{}',
    }),
  )

console.log(
  JSON.stringify({
    preflight: await describeResponse(
      await handler(new Request(url, { method: 'OPTIONS', headers: preflightHeaders })),
    ),
    preflightDisallowed: await describeResponse(
      await handler(
        new Request(url, {
          method: 'OPTIONS',
          headers: { ...preflightHeaders, origin: disallowedOrigin },
        }),
      ),
    ),
    unauthorized: await describeResponse(await postWithoutSession(origin)),
    unauthorizedDisallowed: await describeResponse(await postWithoutSession(disallowedOrigin)),
  }),
)
