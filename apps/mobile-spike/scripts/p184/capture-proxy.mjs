#!/usr/bin/env node
/**
 * P184 LOCAL test tool: a recording, auditing, holdable/droppable HTTP proxy between the release
 * APK and the P184 stack's API gateway. Not shipped. It proves things a screen cannot show:
 *
 *   - IMAGE EGRESS: every request is scanned (URL, header values, body) for image bytes, base64
 *     image prefixes, file/content URIs, picker cache names and EXIF markers. `/__proxy/audit`
 *     reports the counts; the gate is `imageMarkers === 0`.
 *   - LOST RESPONSE: `/__proxy/drop?match=<text>` forwards the next matching request upstream (the
 *     server COMMITS), then destroys the client socket without answering — the response is lost.
 *   - HOLD: `/__proxy/hold?match=<text>` forwards at once but withholds the response until released.
 *   - WHO/HOW MANY: each request records method, path, JWT `sub`/`role` (never the token) and status.
 *
 *   node scripts/p184/capture-proxy.mjs     listens on 127.0.0.1:55781 -> upstream 127.0.0.1:55771
 *
 * Control (loopback only): GET /__proxy/log | /__proxy/audit | /__proxy/held; POST /__proxy/reset |
 * /__proxy/hold?match= | /__proxy/drop?match= | /__proxy/release.
 */
import { createServer, request as httpRequest } from 'node:http'

const LISTEN_PORT = Number(process.env.P184_PROXY_PORT ?? 55781)
const UPSTREAM_PORT = Number(process.env.P184_API_PORT ?? 55771)
const HOST = '127.0.0.1'

// Byte signatures of image containers, and text markers of an image or a local file leaking out.
const IMAGE_MAGIC = [
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff])],
  ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ['webp', Buffer.from('WEBP', 'ascii')],
  ['exif', Buffer.from('Exif\0\0', 'latin1')],
  ['gif', Buffer.from('GIF8', 'ascii')],
]
const TEXT_MARKERS = [
  ['base64-jpeg', /\/9j\/[A-Za-z0-9+/]{16}/],
  ['base64-png', /iVBORw0KGgo/],
  ['base64-webp', /UklGR[A-Za-z0-9+/]{6}/],
  ['data-uri', /data:image\//i],
  ['file-uri', /file:\/\//i],
  ['content-uri', /content:\/\//i],
  ['picker-cache', /ImagePicker|photo-picker|\/cache\/|\.(jpe?g|png|webp|heic)\b|p184-/i],
]

let log = []
let counter = 0
let holdMatch = null
let dropMatch = null
let releasers = []
let audit = { requests: 0, bytesOut: 0, imageMarkers: 0, markers: {}, largestBody: 0 }

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

function scanRequest(req, url, body) {
  const found = []
  const haystacks = [
    ['url', url.pathname + url.search],
    ...Object.entries(req.headers)
      .filter(([name]) => !['authorization', 'apikey'].includes(name))
      .map(([name, value]) => [`header:${name}`, String(value)]),
    ['body', body.toString('latin1')],
  ]
  for (const [where, text] of haystacks) {
    for (const [name, re] of TEXT_MARKERS) {
      if (name === 'picker-cache' && where === 'body') continue // card names/ids in JSON bodies are legitimate
      if (re.test(text)) found.push(`${where}:${name}`)
    }
  }
  for (const [name, magic] of IMAGE_MAGIC) {
    if (body.includes(magic)) found.push(`body:${name}-bytes`)
  }
  return found
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://proxy')
  if (url.pathname.startsWith('/__proxy/')) {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1')
      return send(res, 403, { error: 'loopback only' })
    if (url.pathname === '/__proxy/log' && req.method === 'GET')
      return send(res, 200, { requests: log })
    if (url.pathname === '/__proxy/audit' && req.method === 'GET') return send(res, 200, audit)
    if (url.pathname === '/__proxy/held' && req.method === 'GET')
      return send(res, 200, { held: releasers.length })
    if (url.pathname === '/__proxy/reset' && req.method === 'POST') {
      log = []
      audit = { requests: 0, bytesOut: 0, imageMarkers: 0, markers: {}, largestBody: 0 }
      return send(res, 200, { ok: true })
    }
    if (url.pathname === '/__proxy/hold' && req.method === 'POST') {
      holdMatch = url.searchParams.get('match')
      return send(res, 200, { holding: holdMatch })
    }
    if (url.pathname === '/__proxy/drop' && req.method === 'POST') {
      dropMatch = url.searchParams.get('match')
      return send(res, 200, { dropping: dropMatch })
    }
    if (url.pathname === '/__proxy/release' && req.method === 'POST') {
      holdMatch = null
      dropMatch = null
      const n = releasers.length
      for (const release of releasers.splice(0)) release()
      return send(res, 200, { released: n })
    }
    return send(res, 404, { error: 'unknown control route' })
  }

  const reqChunks = []
  req.on('data', (c) => reqChunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(reqChunks)
    const found = scanRequest(req, url, body)
    audit.requests += 1
    audit.bytesOut += body.length
    audit.largestBody = Math.max(audit.largestBody, body.length)
    if (found.length > 0) {
      audit.imageMarkers += found.length
      for (const f of found) audit.markers[f] = (audit.markers[f] ?? 0) + 1
    }
    const entry = {
      n: (counter += 1),
      at: new Date().toISOString(),
      method: req.method ?? 'GET',
      path: url.pathname + url.search.replace(/(apikey|token)=[^&]*/gi, '$1=…'),
      ...claims(req.headers.authorization),
      bodyBytes: body.length,
      markers: found,
      status: null,
      heldMs: 0,
      dropped: false,
    }
    log.push(entry)
    const shouldHold = holdMatch !== null && url.pathname.includes(holdMatch)
    const shouldDrop = dropMatch !== null && url.pathname.includes(dropMatch)
    if (shouldDrop) dropMatch = null // one lost response per arming
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
          if (shouldDrop) {
            entry.dropped = true
            req.socket.destroy()
            return
          }
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
      res.writeHead(502)
      res.end()
    })
    upstream.end(body)
  })
})

server.listen(LISTEN_PORT, HOST, () => {
  console.log(
    `P184 capture proxy on ${HOST}:${String(LISTEN_PORT)} -> ${HOST}:${String(UPSTREAM_PORT)}`,
  )
})
