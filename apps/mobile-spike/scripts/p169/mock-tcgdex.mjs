#!/usr/bin/env node
/**
 * A local, SYNTHETIC stand-in for the TCGdex card-detail endpoint, used only by the P169 stack's
 * edge functions (their base URL is redirected here by scripts/p169/local-backend.mjs). It serves
 * the fixture catalog (catalog-fixture.mjs) and nothing else: no real card, no real price.
 *
 *   node scripts/p169/mock-tcgdex.mjs            listens on 0.0.0.0:55699 until stopped
 *
 * Bound to all interfaces because the edge runtime reaches it from a Docker container through
 * host.docker.internal; it answers only GET /v2/<lang>/cards/<id> for fixture ids, plus two
 * local control routes the tests use to count provider calls:
 *   GET  /__log     -> { requests: [{ path, at }] }
 *   POST /__reset   -> clears the log
 */
import { createServer } from 'node:http'
import { CARDS, tcgdexId, tcgdexPayload } from './catalog-fixture.mjs'
import { MOCK_TCGDEX_PORT } from './local-backend.mjs'

const byId = new Map(CARDS.filter((c) => tcgdexId(c) !== null).map((c) => [tcgdexId(c), c]))
let log = []

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function startMock(port = MOCK_TCGDEX_PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    if (url.pathname === '/__log' && req.method === 'GET') return send(res, 200, { requests: log })
    if (url.pathname === '/__reset' && req.method === 'POST') {
      log = []
      return send(res, 200, { ok: true })
    }
    const m = /^\/v2\/(en|ja)\/cards\/([^/]+)$/.exec(url.pathname)
    if (req.method !== 'GET' || m === null) return send(res, 404, { error: 'not found' })
    log.push({ path: url.pathname, at: new Date().toISOString() })
    const card = byId.get(decodeURIComponent(m[2]))
    if (card === undefined) return send(res, 404, { error: 'not found' })
    const status = card.provider.status ?? 200
    const answer = () =>
      status === 200
        ? send(res, 200, tcgdexPayload(card))
        : send(res, status, { error: 'synthetic' })
    if (card.provider.delayMs) setTimeout(answer, card.provider.delayMs)
    else answer()
  })
  return new Promise((resolveStart) => server.listen(port, '0.0.0.0', () => resolveStart(server)))
}

if (process.argv[1] && process.argv[1].endsWith('mock-tcgdex.mjs')) {
  await startMock()
  console.log(`mock TCGdex (synthetic) listening on :${MOCK_TCGDEX_PORT}`)
}
