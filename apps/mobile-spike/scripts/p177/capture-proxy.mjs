#!/usr/bin/env node
/**
 * A LOCAL test tool for the P177 device driver: a recording, holdable HTTP proxy between the app
 * and the P177 stack's API gateway (Kong). Identical mechanism to scripts/p173/capture-proxy.mjs,
 * on this phase's own ports so it never touches another session's proxy or stack.
 *
 *   node scripts/p177/capture-proxy.mjs            listens on 127.0.0.1:55501, forwards to 127.0.0.1:55521
 *
 * Control (loopback only): GET /__proxy/log, GET /__proxy/held, POST /__proxy/reset,
 * POST /__proxy/hold?match=<text>, POST /__proxy/release — see scripts/p173/capture-proxy.mjs for
 * the full contract; this file only changes the port constants and env var names.
 */
import { createServer, request as httpRequest } from 'node:http'

const LISTEN_PORT = Number(process.env.P177_PROXY_PORT ?? 55501)
const UPSTREAM_PORT = Number(process.env.P177_API_PORT ?? 55521)
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
