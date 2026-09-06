/**
 * Verifies that a served page's actual inline bootstrap `<script>` is covered by the CSP header
 * actually served alongside it (P110, prompt §18 — P107's CSP_HASH_VERDICT §10 gap).
 *
 * WHY THIS EXISTS. `scripts/verify-scanner-platform-build.mjs` already proves the LOCAL build
 * artifact is internally consistent: it re-hashes `dist/index.html`'s actual inline script and
 * confirms that hash appears in the actual built `dist/_headers`. That is a real proof, but only
 * about files sitting on this machine's disk — it says nothing about what Cloudflare Pages (or any
 * other host) actually SERVES to a browser, which can differ from the local build artifact for
 * reasons entirely outside this repository's control (a CDN edge rewrite, a stale cache, a hosting
 * platform's own HTML minifier). `scripts/deployment-check.mjs` verifies CSP header TOKENS against
 * the live site, but never re-fetched live `index.html` and re-hashed ITS inline script against the
 * live CSP — the one link in the chain that was still an assumption, not a proof.
 *
 * This module closes that gap with pure functions over strings (testable against a local HTTP
 * fixture with no real deployment — see tests/config/live-csp-hash-verify.test.ts) plus one thin
 * fetch-based wrapper for real use.
 *
 * FAILS CLOSED: any ambiguity — no CSP header, no inline script found, `'unsafe-inline'` present —
 * is reported as a failure, never silently passed.
 */
import { createHash } from 'node:crypto'

/**
 * Matches this app's inline bootstrap `<script>` (`THEME_BOOTSTRAP_SCRIPT`, vite.config.ts) — a
 * bare `<script>` tag with no attributes, exactly as `transformIndexHtml` injects it. A `<script
 * src="...">` tag is governed by a HOST source expression in script-src, not a hash, and is
 * deliberately not matched here — mirrors the exact pattern `verify-scanner-platform-build.mjs`
 * already uses for the local build artifact, so both checks can never disagree on what counts as
 * "the inline script."
 */
export function extractInlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
}

/** The exact `'sha256-…'` CSP source-expression token a browser computes for `scriptText`. */
export function hashScriptForCsp(scriptText) {
  return `'sha256-${createHash('sha256').update(scriptText, 'utf8').digest('base64')}'`
}

/** Parses a serialized CSP into directive-name -> source-expression-token arrays (token-level,
 *  matching deployment-check.mjs's own parser — substring checks are meaningless here). */
export function parseCspDirectives(csp) {
  const directives = new Map()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    directives.set(tokens[0], tokens.slice(1))
  }
  return directives
}

/**
 * @param {{ html: string, cspHeader: string | null | undefined }} input
 * @returns {{ pass: boolean, reason: string, hashes: string[] }}
 */
export function verifyLiveCspHash({ html, cspHeader }) {
  if (cspHeader === null || cspHeader === undefined || cspHeader === '') {
    return { pass: false, reason: 'no Content-Security-Policy header was served', hashes: [] }
  }
  const directives = parseCspDirectives(cspHeader)
  const scriptSrc = directives.get('script-src') ?? []

  if (scriptSrc.includes("'unsafe-inline'")) {
    return {
      pass: false,
      reason:
        "the served script-src grants 'unsafe-inline', which defeats hash pinning entirely — " +
        'any inline script would run regardless of its hash',
      hashes: [],
    }
  }

  const inlineScripts = extractInlineScripts(html)
  if (inlineScripts.length === 0) {
    return {
      pass: false,
      reason: 'no inline <script> was found in the served HTML to verify against the served CSP',
      hashes: [],
    }
  }

  const actualHashes = inlineScripts.map(hashScriptForCsp)
  const missing = actualHashes.filter((hash) => !scriptSrc.includes(hash))
  if (missing.length > 0) {
    return {
      pass: false,
      reason:
        `${String(missing.length)} of ${String(actualHashes.length)} inline script(s) on the ` +
        'served page have no matching sha256 source in the served CSP script-src — the live HTML ' +
        `and the live CSP disagree (served script-src: ${scriptSrc.join(' ') || '(none)'})`,
      hashes: actualHashes,
    }
  }

  // Two hashes, one matching (an extra/stale sha256 token the served CSP also happens to carry) is
  // a deliberate PASS: the actual script's hash IS present among the allowed sources, and an extra
  // unused hash does not widen what a browser will execute — it is still exact-hash-pinned, never
  // a wildcard. Reported informationally, not as a failure.
  const extraHashes = scriptSrc.filter(
    (token) => token.startsWith("'sha256-") && !actualHashes.includes(token),
  )
  return {
    pass: true,
    reason:
      extraHashes.length > 0
        ? `every inline script's hash is present in the served CSP script-src (plus ` +
          `${String(extraHashes.length)} extra unused sha256 source(s), harmless — still exact-hash-pinned)`
        : "every inline script's hash is present in the served CSP script-src",
    hashes: actualHashes,
  }
}

/** Real fetch-based convenience wrapper — what `deployment-check.mjs` would call if it did not
 *  already have `html`/`cspHeader` in hand from its own earlier fetch (it reuses those directly to
 *  avoid a duplicate network round trip; this wrapper exists for standalone use and for the local
 *  HTTP-fixture test to exercise the real fetch path end to end). */
export async function fetchAndVerifyLiveCspHash(url, { timeoutMs = 15000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const html = await response.text()
  const cspHeader = response.headers.get('content-security-policy')
  return verifyLiveCspHash({ html, cspHeader })
}
