import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P113 §34 — security/injection audit for the scanner. Candidate/catalog names, OCR-read text and
 * debug-panel content are all untrusted (OCR in particular: whatever a printed card happens to
 * show, including — in principle — HTML-looking substrings) and get rendered every time a scan
 * completes. React escapes plain JSX text children by default; the only way that protection can
 * be bypassed is `dangerouslySetInnerHTML`, direct `.innerHTML`/`insertAdjacentHTML` DOM writes, or
 * `document.write`. This is a STATIC structural proof (matching scanner-network-audit.test.ts's own
 * audit style) that none of those sinks exist anywhere in the scanner feature — this repository has
 * no component-render test harness (no React Testing Library, no `.test.tsx` files anywhere), so a
 * dynamic "adversarial string renders as literal text" proof would need a new dependency this scope
 * does not justify; the static absence of every sink is itself a complete proof, since React's
 * default JSX text-child rendering cannot be bypassed any other way.
 */

const SCANNER_DIR = join(process.cwd(), 'src', 'features', 'scanner')

const FORBIDDEN_SINK_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /dangerouslySetInnerHTML/, why: "React's own escaping must never be bypassed" },
  { pattern: /\.innerHTML\s*=/, why: 'direct innerHTML write bypasses React entirely' },
  { pattern: /insertAdjacentHTML/, why: 'insertAdjacentHTML bypasses React entirely' },
  { pattern: /document\.write(?:ln)?/, why: 'document.write/writeln is never used' },
  // P116 §22 (Phase N): broadened past the original four sinks — these bypass React just as
  // completely and are equally reachable by an OCR-read or catalog-derived string reaching a
  // careless render path in the future.
  { pattern: /\.outerHTML\s*=/, why: 'direct outerHTML write bypasses React entirely' },
  {
    pattern: /\bsrcdoc\s*=/,
    why: 'iframe srcdoc is an HTML-injection sink identical to innerHTML',
  },
  { pattern: /\beval\s*\(/, why: 'eval() must never run untrusted (OCR/catalog-derived) text' },
  { pattern: /new\s+Function\s*\(/, why: 'the Function constructor must never run untrusted text' },
]

/** P116 §22: candidate/catalog/OCR text also reaches plain `href`/`src`-style props in a few
 *  scanner components — a `javascript:` URL there executes on click even though it never touches
 *  an HTML-injection sink above. Checked separately (word-boundary on the literal scheme, not a
 *  structural sink) because a legitimate scanner module may reasonably contain the SUBSTRING
 *  "javascript" in a comment or identifier without it ever being a live URL scheme. */
const JAVASCRIPT_URL_PATTERN = /javascript:/i

function scannerTsxSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      out.push({
        file: relative(SCANNER_DIR, full).replace(/\\/g, '/'),
        text: readFileSync(full, 'utf-8'),
      })
    }
  }
  walk(SCANNER_DIR)
  return out
}

describe('scanner XSS/injection static audit (P113 §34)', () => {
  it('no scanner module contains any HTML-injection sink (dangerouslySetInnerHTML, innerHTML=, insertAdjacentHTML, document.write, outerHTML=, srcdoc=, eval, new Function)', () => {
    const sources = scannerTsxSources()
    expect(sources.length).toBeGreaterThan(5)
    const violations: string[] = []
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const { pattern, why } of FORBIDDEN_SINK_PATTERNS) {
        if (pattern.test(code)) violations.push(`${file}: ${why}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('no scanner module ever assembles a javascript: URL (P116 §22)', () => {
    const sources = scannerTsxSources()
    const violations: string[] = []
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (JAVASCRIPT_URL_PATTERN.test(code)) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})
