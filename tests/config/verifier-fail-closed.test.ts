/**
 * Mutation-proof regression tests for the P130-27 release-verifier false-pass classes, closed by
 * P139. Each `describe` block: (1) proves the NEW implementation rejects the exact fixture that
 * fooled the OLD one, and (2) reproduces the OLD implementation against the same fixture to prove
 * the false pass was real, not a hypothetical — the same "OLD reproduces the false positive"
 * pattern already established in tests/config/live-csp-hash-verify.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { parseCspDirectives } from '../../scripts/lib/live-csp-hash-verify.mjs'
import { cacheControlForBlock } from '../../scripts/lib/cache-control-block.mjs'
import { bundleDeclaresExactSha } from '../../scripts/lib/build-identity.mjs'
import { summarizeResults, reportAndExit } from '../../scripts/lib/verifier-summary.mjs'

// The OLD implementation, exactly as it shipped in every verifier script before P139 (Map.set on
// a duplicate key keeps the LAST occurrence).
function oldCspDirectivesLastWins(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    directives.set(tokens[0]!, tokens.slice(1))
  }
  return directives
}

describe('parseCspDirectives — duplicate directive first-occurrence-wins (P130-27)', () => {
  // A safe first script-src, and a broken/permissive second one — the shape P130 found real
  // browsers actually resolve by enforcing ONLY the first and ignoring the rest.
  const csp =
    "script-src 'self' 'sha256-realHashRealHashRealHashRealHashRealHashA='; " +
    "script-src 'self' 'unsafe-inline'"

  it('NEW: keeps the FIRST script-src (what a browser actually enforces) — the unsafe second one never wins', () => {
    const directives = parseCspDirectives(csp)
    const scriptSrc = directives.get('script-src') ?? []
    expect(scriptSrc).toContain("'sha256-realHashRealHashRealHashRealHashRealHashA='")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it('OLD (mutation proof): last-wins parsing reports the SAFE hash as absent and would have failed a legitimate policy, or symmetrically reported the UNSAFE second directive as if it were live', () => {
    const directives = oldCspDirectivesLastWins(csp)
    const scriptSrc = directives.get('script-src') ?? []
    // This is the exact false-pass direction P130-27 named: a verifier that checks
    // "unsafe-inline is not granted" against the LAST directive would pass a policy whose FIRST
    // (browser-enforced) directive is actually unsafe, once the fixture is inverted. Demonstrated
    // here as the mirror-image failure: it disagrees with the NEW, browser-accurate parse.
    expect(scriptSrc).toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'sha256-realHashRealHashRealHashRealHashRealHashA='")
  })

  it('a single (non-duplicated) directive is unaffected', () => {
    const directives = parseCspDirectives("script-src 'self'; worker-src 'self'")
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(directives.get('worker-src')).toEqual(["'self'"])
  })
})

describe('cacheControlForBlock — block-scoped lookup (P130-27)', () => {
  // A block with NO Cache-Control rule of its own, followed by an unrelated block that has one —
  // reproduces the exact P130 fixture shape ("Cache-Control removed -> 27/27" false pass).
  const headersFile = `/*
  Content-Security-Policy: script-src 'self'

/scanner-assets/v7/*
  X-Some-Other-Header: value

/scanner-assets/visual-v1/model/*
  Cache-Control: public, max-age=31536000, immutable
`

  it("NEW: a block with no Cache-Control rule of its own reports null, never a later block's value", () => {
    expect(cacheControlForBlock(headersFile, '/scanner-assets/v7/*')).toBeNull()
  })

  it('NEW: the block that genuinely has the rule still reports it correctly', () => {
    expect(cacheControlForBlock(headersFile, '/scanner-assets/visual-v1/model/*')).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it("OLD (mutation proof): the unbounded search leaks the NEXT block's Cache-Control into a block that has none — this is the exact false pass", () => {
    function oldCacheControlFor(headersText: string, blockPath: string): string | null | undefined {
      const blockIndex = headersText.indexOf(blockPath)
      return blockIndex === -1
        ? null
        : /Cache-Control:\s*(.+)/.exec(headersText.slice(blockIndex))?.[1]?.trim()
    }
    const leaked = oldCacheControlFor(headersFile, '/scanner-assets/v7/*')
    expect(leaked).toBe('public, max-age=31536000, immutable')
    // Proves the false pass concretely: a build-artifact gate asserting
    // "/scanner-assets/v7/* sets a long-lived immutable Cache-Control" would PASS on this
    // fixture under the OLD lookup even though that block declares no such header at all.
    expect(/max-age=31536000/.test(leaked ?? '') && /immutable/.test(leaked ?? '')).toBe(true)
  })

  it('the last block in the file (no following block) is still found correctly', () => {
    expect(cacheControlForBlock(headersFile, '/scanner-assets/visual-v1/model/*')).not.toBeNull()
  })

  it('a path that does not appear in the file reports null', () => {
    expect(cacheControlForBlock(headersFile, '/nonexistent/*')).toBeNull()
  })
})

describe('bundleDeclaresExactSha — exact quoted-string match, not substring (P130-27)', () => {
  const cleanSha = 'aaaa111122223333444455556666777788889999'
  const dirtyBundle = `const __APP_BUILD_SHA__="${cleanSha}+dirty";`
  const cleanBundle = `const __APP_BUILD_SHA__="${cleanSha}";`

  it('NEW: a clean build matches the expected clean SHA', () => {
    expect(bundleDeclaresExactSha(cleanBundle, cleanSha)).toBe(true)
  })

  it('NEW: a DIRTY build (the exact case this check exists to catch) does NOT match the clean expected SHA', () => {
    expect(bundleDeclaresExactSha(dirtyBundle, cleanSha)).toBe(false)
  })

  it('NEW: a dirty build correctly matches when the expected value itself carries +dirty', () => {
    expect(bundleDeclaresExactSha(dirtyBundle, `${cleanSha}+dirty`)).toBe(true)
  })

  it('NEW: rejects a SHA that is merely a substring of some unrelated longer hex token', () => {
    const bundleWithLongerHex = `const chunkHash="${cleanSha}extracontamination0000";`
    expect(bundleDeclaresExactSha(bundleWithLongerHex, cleanSha)).toBe(false)
  })

  it('NEW: rejects prefix contamination (expected value appears only as a suffix of a longer quoted string)', () => {
    const bundleWithPrefixed = `const x="0000prefix${cleanSha}";`
    expect(bundleDeclaresExactSha(bundleWithPrefixed, cleanSha)).toBe(false)
  })

  it('NEW: an empty/missing expected SHA never matches (missing-SHA must fail closed, never vacuously pass)', () => {
    expect(bundleDeclaresExactSha(cleanBundle, '')).toBe(false)
  })

  it('OLD (mutation proof): plain substring search reports the DIRTY build as matching the CLEAN expected SHA — the exact P130-27 false pass', () => {
    const oldFound = dirtyBundle.includes(cleanSha)
    expect(oldFound).toBe(true) // the bug: a dirty build satisfied the old check
    expect(bundleDeclaresExactSha(dirtyBundle, cleanSha)).toBe(false) // the fix disagrees, correctly
  })
})

describe('summarizeResults / reportAndExit — zero-checks-recorded is FAILURE, never a vacuous pass (P130-27)', () => {
  it('NEW: every group skipped (results all skipped:true) is NOT ok, even though "failed" is empty', () => {
    const results = [
      { name: 'a', pass: true, skipped: true },
      { name: 'b', pass: true, skipped: true },
    ]
    const summary = summarizeResults(results)
    expect(summary.meaningfulCount).toBe(0)
    expect(summary.failed).toEqual([])
    expect(summary.ranNothing).toBe(true)
    expect(summary.ok).toBe(false)
  })

  it('NEW: an entirely empty results array is also NOT ok', () => {
    const summary = summarizeResults([])
    expect(summary.ranNothing).toBe(true)
    expect(summary.ok).toBe(false)
  })

  it('NEW: at least one real check, all passing, IS ok', () => {
    const summary = summarizeResults([{ name: 'a', pass: true }])
    expect(summary.ranNothing).toBe(false)
    expect(summary.ok).toBe(true)
  })

  it('NEW: a real failing check is NOT ok', () => {
    const summary = summarizeResults([
      { name: 'a', pass: true },
      { name: 'b', pass: false },
    ])
    expect(summary.ok).toBe(false)
    expect(summary.failed).toHaveLength(1)
  })

  it('reportAndExit calls the injected exit callback with the correct code and never throws on the all-skipped case', () => {
    let exitCode: number | undefined
    const logs: string[] = []
    reportAndExit(
      [
        { name: 'a', pass: true, skipped: true },
        { name: 'b', pass: true, skipped: true },
      ],
      {
        log: (msg: string) => logs.push(msg),
        exit: (code: number) => {
          exitCode = code
        },
      },
    )
    expect(exitCode).toBe(1)
    expect(logs.join('\n')).toMatch(/every check was skipped/)
  })

  it("OLD (mutation proof): `failed.length ? 1 : 0` against an all-skipped result set exits 0 — the exact 'all-skipped exits 0' false pass every verifier shipped before P139", () => {
    const results = [
      { name: 'a', pass: true, skipped: true },
      { name: 'b', pass: true, skipped: true },
    ]
    const meaningful = results.filter((r) => !r.skipped)
    const failed = meaningful.filter((r) => !r.pass)
    const oldExitCode = failed.length ? 1 : 0
    expect(oldExitCode).toBe(0) // the bug: skipping every check still exited success
    expect(summarizeResults(results).ok).toBe(false) // the fix disagrees, correctly
  })
})
