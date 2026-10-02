/* global Deno */
/**
 * Runs the REAL search-prices Edge Function code (index.ts and everything it imports from
 * ../_shared) once under Deno and prints what it answered, as JSON on stdout.
 *
 *   deno run --no-lock --import-map=import_map.json --allow-read --allow-env \
 *     harness.mjs <functionsDir> <scenario.json>
 *
 * Two things are controlled: the provider's HTTP answer (`globalThis.fetch` — the function's only
 * outbound call is to api.tcgdex.net) and the database rows (stub-supabase.mjs). The function's
 * handler is captured from `Deno.serve` and called with a real Request; the response TEXT is what
 * a client would receive, so it can be inspected before any JSON parser touches it.
 *
 * `functionsDir` is a `supabase/functions` directory: the working tree's, or a checkout of an
 * older release, so the same scenario can be run against both.
 */
import { pathToFileURL } from 'node:url'

const [functionsDir, scenarioPath] = Deno.args
const scenario = JSON.parse(await Deno.readTextFile(scenarioPath))
globalThis.__scenario = scenario

Deno.env.set('SUPABASE_URL', 'http://stub.invalid')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'stub-not-a-key')

let handler
Deno.serve = (h) => {
  handler = h
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }
}

const providerRequests = []
globalThis.fetch = (input) => {
  const url = String(input)
  providerRequests.push(url)
  const match = /^https:\/\/api\.tcgdex\.net\/v2\/[a-z-]+\/cards\/(.+)$/.exec(url)
  if (match === null)
    return Promise.resolve(new Response(`unexpected request ${url}`, { status: 500 }))
  const body = scenario.provider[decodeURIComponent(match[1])]
  if (body === undefined) return Promise.resolve(new Response('', { status: 404 }))
  // A string is sent verbatim, so a scenario can put any numeric literal on the provider's wire.
  return Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

await import(pathToFileURL(`${functionsDir}/search-prices/index.ts`).href)
if (handler === undefined) throw new Error('the function did not register a Deno.serve handler')

const response = await handler(
  new Request('http://localhost/functions/v1/search-prices', {
    method: 'POST',
    headers: { authorization: 'Bearer stub', 'content-type': 'application/json' },
    body: JSON.stringify(scenario.request),
  }),
)
console.log(
  JSON.stringify({
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
    providerRequests,
  }),
)
