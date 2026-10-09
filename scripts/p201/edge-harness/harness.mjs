/* global Deno */
/**
 * Runs the REAL code of one Edge Function (sync-catalog, ingest-prices, ingest-fx, fetch-fx-rate or
 * search-prices) once under Deno and prints what it did as JSON on stdout.
 *
 *   deno run --no-lock --import-map=import_map.json --allow-read --allow-env \
 *     harness.mjs <functionsDir> <scenario.json>
 *
 * Controlled by the scenario: the provider's HTTP answers (`globalThis.fetch` — scripted per URL path,
 * one entry per call, the last entry repeating), the database (stub-supabase.mjs) and the request.
 * Observed: the function's HTTP response, every provider request it made, every database operation
 * it issued. Retry sleeps are instant so a scenario that exercises backoff costs no wall time; the
 * number and size of sleeps are reported.
 *
 * Provider script entry shapes (scenario.provider["/en/cards/x-1"] is an ARRAY of them):
 *   { status: 200, body: {...} | "raw text", headers: { "retry-after": "2" } }
 *   { throw: "network" }                       fetch() rejects
 *   { hang: true }                             never answers until the request is aborted
 */
import { pathToFileURL } from 'node:url'

const [functionsDir, scenarioPath] = Deno.args
const scenario = JSON.parse(await Deno.readTextFile(scenarioPath))
globalThis.__scenario = scenario

for (const [key, value] of Object.entries({
  SUPABASE_URL: 'http://stub.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'stub-not-a-key',
  ...(scenario.env ?? {}),
})) {
  Deno.env.set(key, String(value))
}

let handler
Deno.serve = (h) => {
  handler = h
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }
}

// Import the policy module FIRST so the function (which imports the same URL) shares its runtime.
const http = await import(pathToFileURL(`${functionsDir}/_shared/provider-http.ts`).href)
const sleeps = []
http.providerRuntime.clock = {
  sleep: (ms) => {
    sleeps.push(ms)
    return Promise.resolve()
  },
  random: () => 0.5,
  now: () => Date.now(),
}
if (scenario.policy) Object.assign(http.providerRuntime.policy, scenario.policy)

const providerCalls = {}
const providerRequests = []
globalThis.fetch = (input, init) => {
  const url = new URL(String(input))
  const key = url.pathname.replace(/^\/v2/, '') + url.search
  providerRequests.push(url.host + url.pathname + url.search)
  const script = scenario.provider?.[key] ?? scenario.provider?.[url.pathname.replace(/^\/v2/, '')]
  if (script === undefined) return Promise.resolve(new Response('', { status: 404 }))
  const n = providerCalls[key] ?? 0
  providerCalls[key] = n + 1
  const step = script[Math.min(n, script.length - 1)]
  if (step.throw) return Promise.reject(new TypeError('fetch failed'))
  if (step.hang) {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      )
    })
  }
  return Promise.resolve(
    new Response(typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
    }),
  )
}

const originalLog = console.log
const originalWarn = console.warn
const originalError = console.error
const logLines = []
const capture = (...args) => logLines.push(args.map(String).join(' '))
console.log = capture
console.warn = capture
console.error = capture

await import(pathToFileURL(`${functionsDir}/${scenario.function}/index.ts`).href)
if (handler === undefined) throw new Error('the function did not register a Deno.serve handler')

const response = await handler(
  new Request(`http://localhost/functions/v1/${scenario.function}`, {
    method: scenario.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(scenario.headers ?? {}) },
    body: scenario.method === 'GET' ? undefined : JSON.stringify(scenario.request ?? {}),
  }),
)
const text = await response.text()

console.log = originalLog
console.warn = originalWarn
console.error = originalError
console.log(
  JSON.stringify({
    status: response.status,
    text,
    providerRequests,
    sleeps,
    ops: globalThis.__ops,
    logs: logLines,
  }),
)
