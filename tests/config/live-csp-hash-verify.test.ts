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

describe('extractInlineScripts — HTML comment awareness (P128, false-positive fix)', () => {
  it('ignores an HTML comment containing the literal text "<script>", reproducing the exact deployed shape', () => {
    const deployedShape =
      '<script>REAL_THEME_BOOTSTRAP</script>\n\n' +
      '<!--\n' +
      '  theme-bootstrap <script> is injected here by some build plugin...\n' +
      '-->\n\n' +
      '<script type="module" src="/assets/index-example.js"></script>'

    const scripts = extractInlineScripts(deployedShape)
    expect(scripts).toEqual(['REAL_THEME_BOOTSTRAP'])
  })

  it('the OLD raw regex reproduces the false positive on that same fixture (mutation proof)', () => {
    const deployedShape =
      '<script>REAL_THEME_BOOTSTRAP</script>\n\n' +
      '<!--\n' +
      '  theme-bootstrap <script> is injected here by some build plugin...\n' +
      '-->\n\n' +
      '<script type="module" src="/assets/index-example.js"></script>'

    const oldRegexExtract = (html: string) =>
      [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])

    const oldResult = oldRegexExtract(deployedShape)
    expect(oldResult.length).toBe(2)
    expect(oldResult[1]).not.toBe('REAL_THEME_BOOTSTRAP')
  })

  it('a complete fake script entirely inside an HTML comment is not extracted', () => {
    const html = '<!-- <script>evil-looking-but-not-executable</script> -->'
    expect(extractInlineScripts(html)).toEqual([])
  })

  it('verification fails closed with "no inline script found" when the only script-looking text is inside a comment', () => {
    const html = '<!-- <script>evil-looking-but-not-executable</script> -->'
    const result = verifyLiveCspHash({ html, cspHeader: "script-src 'self'" })
    expect(result.pass).toBe(false)
    expect(result.reason).toMatch(/no inline <script>/)
  })

  it('preserves comment-like bytes INSIDE a genuine inline script verbatim (guards against a naive global comment-strip)', () => {
    const scriptBody = 'const marker = "<!-- not an HTML comment here -->";'
    const html = `<script>${scriptBody}</script>`
    const scripts = extractInlineScripts(html)
    expect(scripts).toEqual([scriptBody])
    const computedHash = hashScriptForCsp(scriptBody)
    const independentHash = `'sha256-${createHash('sha256').update(scriptBody, 'utf8').digest('base64')}'`
    expect(computedHash).toBe(independentHash)
  })

  it('external and module scripts are never treated as inline (no attributes = inline, any attribute = external)', () => {
    const html = '<script src="/foo.js"></script>\n<script type="module" src="/bar.js"></script>'
    expect(extractInlineScripts(html)).toEqual([])
  })

  it('an unterminated HTML comment fails closed: nothing past the ambiguous point is fabricated', () => {
    const malformed = `<script>${SCRIPT_TEXT}</script>\n<!-- unterminated comment with <script>fake</script> inside`
    expect(extractInlineScripts(malformed)).toEqual([SCRIPT_TEXT])
  })

  it('an unterminated script tag fails closed: no phantom content is invented', () => {
    const html = '<!-- comment --><script>never closed'
    expect(extractInlineScripts(html)).toEqual([])
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
