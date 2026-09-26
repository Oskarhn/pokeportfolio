#!/usr/bin/env node
/**
 * A LOCAL test tool for the P173 device drivers: a recording, holdable HTTP proxy between the app and
 * the P173 stack's API gateway (Kong). Not shipped, not part of the app; it exists so the device suite
 * can prove things the screen alone cannot show:
 *
 *   - WHO a request was made as: each request is logged with the `sub` and `role` claims read from its
 *     Authorization JWT (never the token itself), so "B's first request after A -> B is B's" is a fact
 *     read from the wire, not an inference from the screen;
 *   - HOW MANY requests a journey made (a repeated Price Check lookup after an Activity recreation, a
 *     provider request after a printing switch);
 *   - a late answer: a matching request is forwarded at once, but its RESPONSE is held until released,
 *     so the driver can switch account while a lookup is genuinely in flight and then deliver the
 *     answer afterwards;
 *   - that a photo never leaves the device: nothing is sent while a photo is picked or shown.
 *
 *   node scripts/p173/capture-proxy.mjs            listens on 127.0.0.1:55401, forwards to 127.0.0.1:55421
 *
 * Control (loopback only):
 *   GET  /__proxy/log                 -> { requests: [{ n, at, method, path, sub, role, status, heldMs }] }
 *   POST /__proxy/reset               -> clears the log (held responses stay held)
 *   POST /__proxy/hold?match=<text>   -> hold the response of every LATER request whose path contains text
 *   POST /__proxy/release             -> deliver every held response and stop holding
 *   GET  /__proxy/held                -> { held: <number> }
 */
import { createServer, request as httpRequest } from 'node:http'

const LISTEN_PORT = Number(process.env.P173_PROXY_PORT ?? 55401)
const UPSTREAM_PORT = Number(process.env.P173_API_PORT ?? 55421)
const HOST = '127.0.0.1'

/** @type {{ n: number, at: string, method: string, path: string, sub: string | null, role: string | null, status: number | null, heldMs: number }[]} */
let log = []
let counter = 0
let holdMatch = null
/** @type {(() => void)[]} */
let releasers = []

function claims(authorization) {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]
  const payload = token?.split('.')[1]
  if (payload === undefined) return { sub: null, role: null }
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return {
      sub: typeof json.sub === 'string' ? json.sub : null,
      role: typeof json.role === 'string' ? json.role : null,
    }
  } catch {
    return { sub: null, role: null }
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://proxy')
  if (url.pathname.startsWith('/__proxy/')) {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1')
      return send(res, 403, { error: 'loopback only' })
    if (url.pathname === '/__proxy/log' && req.method === 'GET')
      return send(res, 200, { requests: log })
    if (url.pathname === '/__proxy/held' && req.method === 'GET')
      return send(res, 200, { held: releasers.length })
    if (url.pathname === '/__proxy/reset' && req.method === 'POST') {
      log = []
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/__proxy/hold' && req.method === 'POST') {
      holdMatch = url.searchParams.get('match')
      return send(res, 200, { holding: holdMatch })
    }
    if (url.pathname === '/__proxy/release' && req.method === 'POST') {
      holdMatch = null
      const n = releasers.length
      for (const release of releasers.splice(0)) release()
      return send(res, 200, { released: n })
    }
    return send(res, 404, { error: 'unknown control route' })
  }

  const entry = {
    n: (counter += 1),
    at: new Date().toISOString(),
    method: req.method ?? 'GET',
    path: url.pathname + url.search.replace(/(apikey|token)=[^&]*/gi, '$1=…'),
    ...claims(req.headers.authorization),
    status: null,
    heldMs: 0,
  }
  log.push(entry)
  const shouldHold = holdMatch !== null && url.pathname.includes(holdMatch)
  const upstream = httpRequest(
    {
      host: HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${HOST}:${String(UPSTREAM_PORT)}` },
    },
    (upstreamRes) => {
      const chunks = []
      upstreamRes.on('data', (c) => chunks.push(c))
      upstreamRes.on('end', () => {
        entry.status = upstreamRes.statusCode ?? null
        const deliver = () => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          res.end(Buffer.concat(chunks))
        }
        if (!shouldHold) return deliver()
        const heldAt = Date.now()
        releasers.push(() => {
          entry.heldMs = Date.now() - heldAt
          deliver()
        })
      })
    },
  )
  upstream.on('error', () => {
    entry.status = 502
    send(res, 502, { error: 'upstream unreachable' })
  })
  req.pipe(upstream)
})

server.listen(LISTEN_PORT, HOST, () =>
  console.log(
    `capture proxy on ${HOST}:${String(LISTEN_PORT)} -> ${HOST}:${String(UPSTREAM_PORT)} (control: /__proxy/*)`,
  ),
)
