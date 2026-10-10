/* global Deno */
/**
 * Runs the REAL redeem-invitation Edge Function code once under Deno and prints, as JSON on stdout,
 * how its request-body handling answers hostile and malformed bodies (P206).
 *
 *   deno run --no-lock --allow-read --allow-env redeem-invitation-harness.mjs <functionsDir> <origin> <disallowedOrigin>
 *
 * Nothing is fetched and no database is touched: every probe is refused (413) or rejected on shape
 * (400) before the function builds a Supabase client, and the Supabase environment is a `.invalid`
 * stub in case that ever stopped being true. The handler is captured from `Deno.serve`.
 *
 * Console output of the function is captured so the test can prove that no token or password text
 * from a request ever reaches a log line.
 */
import { pathToFileURL } from 'node:url'

const [functionsDir, origin, disallowedOrigin] = Deno.args
const MAX = 4096

Deno.env.set('ALLOWED_ORIGINS', origin)
Deno.env.set('SUPABASE_URL', 'http://stub.invalid')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'stub-not-a-key')

const logged = []
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    logged.push(args.map(String).join(' '))
  }
}
const realLog = (text) => Deno.stdout.writeSync(new TextEncoder().encode(text))

let handler
Deno.serve = (h) => {
  handler = h
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() }
}
await import(pathToFileURL(`${functionsDir}/redeem-invitation/index.ts`).href)
if (handler === undefined) throw new Error('the function did not register a Deno.serve handler')

const url = 'http://localhost/functions/v1/redeem-invitation'
const encoder = new TextEncoder()

async function answer(response) {
  return {
    status: response.status,
    allowOrigin: response.headers.get('access-control-allow-origin'),
    vary: response.headers.get('vary'),
    body: await response.text(),
  }
}

function post(body, { from = origin, headers = {} } = {}) {
  return handler(
    new Request(url, {
      method: 'POST',
      headers: { origin: from, 'content-type': 'application/json', ...headers },
      body,
    }),
  )
}

/** A JSON object of exactly `bytes` UTF-8 bytes, with a token too short to reach the database. */
function paddedJson(bytes, filler = 'x') {
  const empty = JSON.stringify({ token: 'short', password: 'p', pad: '' })
  const fillerBytes = encoder.encode(filler).byteLength
  const count = Math.floor((bytes - encoder.encode(empty).byteLength) / fillerBytes)
  const text = JSON.stringify({ token: 'short', password: 'p', pad: filler.repeat(count) })
  return encoder.encode(text)
}

const SECRET_TOKEN = 'SECRET-TOKEN-MARKER-9f3a1c77d2'
const SECRET_PASSWORD = 'SECRET-PASSWORD-MARKER-b81e44'

const result = { max: MAX }

result.atLimit = await answer(await post(paddedJson(MAX)))
result.overByOne = await answer(await post(paddedJson(MAX + 1)))
// 2-byte characters: the limit is bytes, not characters.
result.multibyteAtLimit = await answer(await post(paddedJson(MAX, 'é')))
result.multibyteOver = await answer(await post(paddedJson(MAX + 2, 'é')))

// A declared Content-Length alone is enough to refuse; the (tiny) body is never parsed.
result.declaredHuge = await answer(
  await post('{}', { headers: { 'content-length': String(1_000_000_000) } }),
)

// A chunked body with no Content-Length that never ends: the read must stop at the limit and cancel.
{
  let pulledBytes = 0
  let cancelled = false
  const chunk = encoder.encode('x'.repeat(1024))
  const stream = new ReadableStream({
    pull(controller) {
      pulledBytes += chunk.byteLength
      controller.enqueue(chunk)
      // Safety valve so a regression fails the assertion instead of hanging the harness.
      if (pulledBytes > 1_000_000) controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const response = await handler(
    new Request(url, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    }),
  )
  result.endlessStream = { ...(await answer(response)), pulledBytes, cancelled }
}

const shapes = {
  null: 'null',
  number: '7',
  array: '[]',
  nestedArray: '[{"token":"x"}]',
  string: '"x"',
  boolean: 'true',
  malformed: '{nope',
  truncated: `{"token":"${SECRET_TOKEN}","password":"${SECRET_PASSWORD}"`,
  empty: '',
  nullFields: '{"token":null,"password":null}',
  wrongTypes: '{"token":12345678901234567890,"password":{}}',
}
result.shapes = {}
for (const [name, text] of Object.entries(shapes)) {
  result.shapes[name] = await answer(await post(text))
}

// The same refusals must carry CORS headers for the app origin and none for another origin.
result.cors = {
  oversizeAllowed: await answer(await post(paddedJson(MAX + 1), { from: origin })),
  oversizeDisallowed: await answer(await post(paddedJson(MAX + 1), { from: disallowedOrigin })),
  malformedAllowed: await answer(await post('null', { from: origin })),
  malformedDisallowed: await answer(await post('null', { from: disallowedOrigin })),
}

// An oversize body that CONTAINS a token and a password, and a malformed one that does too.
const secretBody = encoder.encode(
  JSON.stringify({
    token: SECRET_TOKEN,
    password: SECRET_PASSWORD,
    pad: 'x'.repeat(MAX),
  }),
)
result.secretsOversize = await answer(await post(secretBody))
result.logged = logged
result.leaks = logged.filter(
  (line) => line.includes(SECRET_TOKEN) || line.includes(SECRET_PASSWORD),
)

realLog(JSON.stringify(result))
