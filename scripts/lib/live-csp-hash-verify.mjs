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
 * reuses from this same function, so both checks can never disagree on what counts as "the inline
 * script."
 *
 * This is a small lexical scan, not a general HTML parser: it only needs to tell an HTML comment
 * apart from a real `<script>` element, because `index.html` deliberately documents the bootstrap
 * script in a comment that itself contains the literal text `<script>` (see index.html's own
 * comment above the theme-bootstrap injection point). A regex applied to the raw HTML cannot make
 * that distinction — it greedily matches from that literal text through to the next real
 * `</script>` closing tag, fabricating a phantom second "inline script" whose content is actually
 * HTML markup, which of course never hashes to anything in the CSP (the false positive this
 * function exists to avoid).
 *
 * Rules, applied outside-in:
 *  - `<!-- ... -->` is skipped whole; nothing inside a comment is ever treated as a tag, so a
 *    literal "<script>" in comment prose can never masquerade as script content.
 *  - A `<script ...>` tag with any attributes (`src`, `type="module"`, etc.) is skipped: it is
 *    governed by a host/type source expression in script-src, not a hash.
 *  - A bare `<script>` tag (no attributes) is inline-executed content: everything up to the next
 *    literal `</script>` closing tag is returned VERBATIM (no trimming, no normalization) because
 *    the CSP hash is computed over the exact bytes a browser executes.
 *  - An unterminated comment or an unterminated script tag makes everything after that point
 *    ambiguous; scanning stops there rather than guessing, so this never fabricates content that
 *    was never actually delimited (fail closed — a real script hidden past that point simply is
 *    not found, which surfaces as "no inline script found" rather than a false PASS).
 */
export function extractInlineScripts(html) {
  const scripts = []
  const length = html.length
  let index = 0
  while (index < length) {
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4)
      if (commentEnd === -1) break
      index = commentEnd + 3
      continue
    }

    const openTag = /^<script(\s[^>]*)?>/i.exec(html.slice(index))
    if (openTag) {
      const attrs = (openTag[1] ?? '').trim()
      const contentStart = index + openTag[0].length
      const closeTag = /<\/script\s*>/i.exec(html.slice(contentStart))
      if (!closeTag) break
      const content = html.slice(contentStart, contentStart + closeTag.index)
      if (attrs === '') scripts.push(content)
      index = contentStart + closeTag.index + closeTag[0].length
      continue
    }

    const nextLt = html.indexOf('<', index + 1)
    index = nextLt === -1 ? length : nextLt
  }
  return scripts
}

/** The exact `'sha256-…'` CSP source-expression token a browser computes for `scriptText`. */
export function hashScriptForCsp(scriptText) {
  return `'sha256-${createHash('sha256').update(scriptText, 'utf8').digest('base64')}'`
}

/**
 * Parses a serialized CSP into directive-name -> source-expression-token arrays (token-level:
 * substring checks are meaningless here, e.g. `'wasm-unsafe-eval'` contains the substring
 * `unsafe-eval`).
 *
 * FIRST occurrence of a duplicated directive name wins (P130-27, P139 fail-closed contract).
 * Per the CSP3 spec, when a directive is serialized more than once in a single policy, a
 * browser enforces only the FIRST instance and silently ignores every later one — this is
 * CSP's actual security-relevant behaviour, not an edge case. A naive `Map.set()` per token
 * group keeps whichever occurrence is LAST in the string, which is backwards: a policy with a
 * safe first `script-src` and a broken/permissive second one (attacker-injected duplicate,
 * build-tool bug, or a header-merge artifact — Cloudflare Pages merges header rules from every
 * matching path pattern, vite.config.ts's own _headers comment) is enforced SAFELY by every
 * real browser but would be verified against the unsafe SECOND directive by a last-wins parser,
 * reporting a false PASS for a live vulnerability. Keeping the first occurrence and ignoring
 * later ones makes this verifier agree with what a browser actually does.
 */
export function parseCspDirectives(csp) {
  const directives = new Map()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const name = tokens[0]
    if (directives.has(name)) continue // first occurrence wins — see doc comment above
    directives.set(name, tokens.slice(1))
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
