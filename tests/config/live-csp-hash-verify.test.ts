/**
 * Live CSP-vs-served-HTML hash verification (P110, prompt §18-19 — P107's CSP_HASH_VERDICT §10
 * gap: deployment-check.mjs proved the LOCAL build artifact was internally consistent but never
 * proved the LIVE served HTML and LIVE served CSP header actually agree with each other).
 *
 * Exercised against a REAL local `node:http` server so the fetch-based wrapper is proven end to
 * end, not just the pure string-parsing logic — a deterministic fixture, no real deployment
 * needed, matching the prompt's own explicit request.
 */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractInlineScripts,
  fetchAndVerifyLiveCspHash,
  hashScriptForCsp,
  verifyLiveCspHash,
} from '../../scripts/lib/live-csp-hash-verify.mjs'

const SCRIPT_TEXT = 'document.documentElement.dataset.theme="dark"'
const SCRIPT_HASH = hashScriptForCsp(SCRIPT_TEXT)
const html = (scriptText: string) =>
  `<!doctype html><html><head><script>${scriptText}</script></head><body></body></html>`

let server: Server | undefined
let baseUrl = ''

async function serve(
  responder: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Promise<void> {
  server = createServer(responder)
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port')
  baseUrl = `http://127.0.0.1:${String(address.port)}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve()
      })
    })
  }
  server = undefined
})

describe('extractInlineScripts / hashScriptForCsp', () => {
  it('extracts exactly one attribute-free inline script and hashes it to a valid CSP3 sha256 expression', () => {
    const scripts = extractInlineScripts(html(SCRIPT_TEXT))
    expect(scripts).toEqual([SCRIPT_TEXT])
    expect(hashScriptForCsp(SCRIPT_TEXT)).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/)
  })
})

describe('verifyLiveCspHash (pure)', () => {
  it('matching CSP: passes', () => {
    const result = verifyLiveCspHash({
      html: html(SCRIPT_TEXT),
      cspHeader: `script-src 'self' ${SCRIPT_HASH}`,
    })
    expect(result.pass).toBe(true)
  })

  it('wrong hash: fails', () => {
    const result = verifyLiveCspHash({
      html: html(SCRIPT_TEXT),
      cspHeader: "script-src 'self' 'sha256-wrongwrongwrongwrongwrongwrongwrongwrongwro='",
    })
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/no matching sha256 source/)
  })

  it('missing CSP: fails', () => {
    expect(verifyLiveCspHash({ html: html(SCRIPT_TEXT), cspHeader: null }).pass).toBe(false)
    expect(verifyLiveCspHash({ html: html(SCRIPT_TEXT), cspHeader: '' }).pass).toBe(false)
    expect(verifyLiveCspHash({ html: html(SCRIPT_TEXT), cspHeader: undefined }).pass).toBe(false)
  })

  it('two hashes, one matching: defined deliberate PASS (an extra unused hash is harmless, still exact-pinned)', () => {
    const result = verifyLiveCspHash({
      html: html(SCRIPT_TEXT),
      cspHeader: `script-src 'self' 'sha256-anUnusedButWellFormedHashValueXXXXXXXXXXX=' ${SCRIPT_HASH}`,
    })
    expect(result.pass).toBe(true)
    expect(result.reason).toMatch(/extra unused sha256/)
  })

  it('unsafe-inline: fails even though a matching hash is ALSO present', () => {
    const result = verifyLiveCspHash({
      html: html(SCRIPT_TEXT),
      cspHeader: `script-src 'self' 'unsafe-inline' ${SCRIPT_HASH}`,
    })
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/unsafe-inline/)
  })

  it('HTML script changed after the CSP was computed: fails (same mechanism as "wrong hash")', () => {
    // The CSP header still names the ORIGINAL script's hash, but the served HTML now has
    // different inline script content — simulating a CDN rewrite or a stale/mismatched deploy.
    const result = verifyLiveCspHash({
      html: html(`${SCRIPT_TEXT};console.log("tampered")`),
      cspHeader: `script-src 'self' ${SCRIPT_HASH}`,
    })
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/no matching sha256 source/)
  })

  it('no inline script at all: fails (nothing to verify)', () => {
    const result = verifyLiveCspHash({
      html: '<!doctype html><html><head></head><body></body></html>',
      cspHeader: `script-src 'self' ${SCRIPT_HASH}`,
    })
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/no inline <script>/)
  })
})

describe('fetchAndVerifyLiveCspHash — real local HTTP fixture (P110 prompt §19)', () => {
  it('matching CSP served by a real HTTP server: passes', async () => {
    await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': `script-src 'self' ${SCRIPT_HASH}`,
      })
      res.end(html(SCRIPT_TEXT))
    })
    const result = await fetchAndVerifyLiveCspHash(baseUrl)
    expect(result.pass).toBe(true)
  })

  it('server serves a CSP computed for a DIFFERENT script than what it actually returns: fails', async () => {
    await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': `script-src 'self' ${SCRIPT_HASH}`,
      })
      res.end(html('window.somethingElseEntirely = true'))
    })
    const result = await fetchAndVerifyLiveCspHash(baseUrl)
    expect(result.pass).toBe(false)
  })

  it('server serves no CSP header at all: fails', async () => {
    await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(html(SCRIPT_TEXT))
    })
    const result = await fetchAndVerifyLiveCspHash(baseUrl)
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/no Content-Security-Policy header/)
  })

  it("a genuinely correct sha256 computed independently over the real served bytes matches this module's own computation", async () => {
    await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': `script-src 'self' ${SCRIPT_HASH}`,
      })
      res.end(html(SCRIPT_TEXT))
    })
    const response = await fetch(baseUrl)
    const body = await response.text()
    const independentHash = `'sha256-${createHash('sha256').update(SCRIPT_TEXT, 'utf8').digest('base64')}'`
    expect(independentHash).toBe(SCRIPT_HASH)
    expect(body).toContain(SCRIPT_TEXT)
  })
})
