/**
 * M15 scanner platform security — configuration-level pins (the built-artifact half lives in
 * scripts/verify-scanner-platform-build.mjs, which inspects dist/_headers and dist/sw.js after a
 * real production build).
 *
 * These tests exist so the CSP loosening required by the on-device OCR engine cannot silently
 * become a general eval allowance, and so the scanner asset caching rules keep their exact
 * scope. The assertions are token-level: CSP source expressions are compared as whole tokens,
 * because `'wasm-unsafe-eval'` contains the substring `unsafe-eval` and any substring check
 * would be meaningless in both directions.
 */
import { describe, expect, it } from 'vitest'
import {
  buildContentSecurityPolicy,
  scannerAssetGlobIgnores,
  scannerAssetRuntimeCache,
} from '../../vite.config.ts'

const DEV_SUPABASE_URL = 'https://exampleprojectref.supabase.co'

/** Parses a serialized CSP into directive-name → source-expression-token arrays. */
function directivesOf(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/)
    const name = tokens[0]
    if (!name) continue
    directives.set(name, tokens.slice(1))
  }
  return directives
}

describe('generated Content-Security-Policy (M15 WASM OCR)', () => {
  const directives = directivesOf(buildContentSecurityPolicy(DEV_SUPABASE_URL))
  const scriptSrc = directives.get('script-src') ?? []

  it("grants 'wasm-unsafe-eval' so WebAssembly can compile", () => {
    expect(scriptSrc).toContain("'wasm-unsafe-eval'")
  })

  it('never grants JavaScript eval — only the distinct wasm-unsafe-eval token', () => {
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it('keeps script-src same-origin with no inline/blob/data allowances', () => {
    expect(scriptSrc).toContain("'self'")
    for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", 'blob:', 'data:']) {
      expect(scriptSrc).not.toContain(forbidden)
    }
  })

  it("keeps worker-src exactly 'self'", () => {
    expect(directives.get('worker-src')).toEqual(["'self'"])
  })

  it('leaves connect-src unchanged: self plus the built-against Supabase project', () => {
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      DEV_SUPABASE_URL,
      'wss://exampleprojectref.supabase.co',
    ])
  })

  it("keeps default-src 'self' as the deny-by-default backstop", () => {
    expect(directives.get('default-src')).toEqual(["'self'"])
  })
})

describe('scanner asset runtime-cache rule', () => {
  const pattern = scannerAssetRuntimeCache.urlPattern

  it('is a CacheFirst rule over a dedicated versioned cache', () => {
    expect(scannerAssetRuntimeCache.handler).toBe('CacheFirst')
    expect(scannerAssetRuntimeCache.options.cacheName).toBe('scanner-assets-v7')
  })

  it('matches the OCR engine file classes under /scanner-assets/v7/', () => {
    expect(pattern.test('/scanner-assets/v7/worker.min.js')).toBe(true)
    expect(pattern.test('/scanner-assets/v7/tesseract-core-simd-lstm.wasm.js')).toBe(true)
    expect(pattern.test('/scanner-assets/v7/tesseract-core-simd-lstm.wasm')).toBe(true)
    expect(pattern.test('/scanner-assets/v7/eng.traineddata.gz')).toBe(true)
    // Same-origin requests reach the router as full hrefs; the path portion still matches.
    expect(
      pattern.test('https://pokeportfolio-dev.pages.dev/scanner-assets/v7/eng.traineddata.gz'),
    ).toBe(true)
    // Query/cache-bust suffixes do not defeat the match.
    expect(pattern.test('/scanner-assets/v7/worker.min.js?v=1234')).toBe(true)
  })

  it('rejects everything outside the exact v7 engine prefix and file classes', () => {
    // Other versions (past or future) are not served by the v7 rule.
    expect(pattern.test('/scanner-assets/v6/worker.min.js')).toBe(false)
    expect(pattern.test('/scanner-assets/v8/worker.min.js')).toBe(false)
    // Not an engine file class.
    expect(pattern.test('/scanner-assets/v7/index.html')).toBe(false)
    expect(pattern.test('/scanner-assets/v7/model.json')).toBe(false)
    // Not the scanner prefix at all.
    expect(pattern.test('/assets/index-BQrbBiYz.js')).toBe(false)
    expect(pattern.test('/rest/v1/cards')).toBe(false)
    // A bare directory listing path is not an engine asset.
    expect(pattern.test('/scanner-assets/v7/')).toBe(false)
  })

  it('cannot serve cross-origin responses under Workbox RegExpRoute semantics', () => {
    // workbox-routing 7.4.1 executes the pattern against the FULL href and handles a
    // cross-origin request only when the match starts at index 0 of that href — impossible for
    // any absolute URL, since every href begins with a scheme, while this pattern begins with
    // `/`. Same-origin requests skip the index check, which is why the positive cases above
    // match. Pinned here so an upgrade that changes those semantics fails loudly instead of
    // quietly turning this into a wildcard model cache.
    const foreignHref = 'https://malicious.example/scanner-assets/v7/core.wasm'
    const match = pattern.exec(foreignHref)
    expect(match === null || match.index !== 0).toBe(true)
  })

  it('bounds cache growth and refuses non-200 responses', () => {
    expect(scannerAssetRuntimeCache.options.expiration.maxEntries).toBeGreaterThan(0)
    expect(scannerAssetRuntimeCache.options.expiration.maxAgeSeconds).toBeGreaterThan(0)
    expect(scannerAssetRuntimeCache.options.expiration.purgeOnQuotaError).toBe(true)
    expect(scannerAssetRuntimeCache.options.cacheableResponse.statuses).toEqual([200])
  })
})

describe('scanner asset precache exclusion', () => {
  it('excludes the whole scanner-assets tree from install-time precache', () => {
    expect(scannerAssetGlobIgnores).toContain('scanner-assets/**')
  })

  it('contains no ignore pattern broader than the scanner tree', () => {
    // The exclusion must never grow into something that would drop ordinary shell assets from
    // the precache manifest — every entry has to name scanner-assets explicitly.
    for (const ignore of scannerAssetGlobIgnores) {
      expect(ignore).toContain('scanner-assets')
    }
  })
})
