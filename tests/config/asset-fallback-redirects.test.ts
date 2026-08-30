/**
 * Cloudflare Pages `_redirects` generation (P83, D-100) — configuration-level pin. The real
 * platform behaviour (whether a missing asset genuinely gets a 404 rather than the `index.html`
 * SPA fallback) can only be proven against a real Cloudflare Pages deployment — `_redirects` is
 * ignored by `vite dev`/`vite preview` (same limitation `_headers` already has, documented in
 * vite.config.ts) — so that proof lives in output_83.txt's live-preview `curl` evidence, not here.
 * This test pins the generated RULE SHAPE so a future edit cannot silently reorder the catch-all
 * ahead of the asset rules, drop a directory the real failure needs covered, or reintroduce a
 * mid-pattern splat (`/*.js`) — deployed and curled directly, that shape never actually matched
 * anything on Cloudflare (splats are documented as end-of-path only), leaving the original bug
 * silently in place despite every local/unit check passing throughout.
 */
import { describe, expect, it } from 'vitest'
import { ASSET_FALLBACK_DIRECTORIES, buildAssetFallbackRedirects } from '../../vite.config.ts'

describe('buildAssetFallbackRedirects (P83, D-100)', () => {
  const redirects = buildAssetFallbackRedirects()
  const lines = redirects.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'))

  it('covers every directory a lazy chunk/scanner build artifact can live under', () => {
    expect(ASSET_FALLBACK_DIRECTORIES).toEqual(['/assets/*', '/scanner-assets/*'])
  })

  it('every directory rule uses a TRAILING splat, never a mid-pattern one', () => {
    // Cloudflare Pages only documents/supports a splat at the end of a source path (its own
    // example: "/blog/*"). A rule like "/*.js" (splat before a literal suffix) is accepted by
    // the file-format parser but never matches anything real — verified directly against the
    // live preview.
    for (const dir of ASSET_FALLBACK_DIRECTORIES) {
      expect(dir.endsWith('/*')).toBe(true)
      expect(dir.indexOf('*')).toBe(dir.length - 1)
    }
  })

  it('routes every asset-directory rule to a real 404, never to index.html', () => {
    const assetRuleLines = lines.filter((line) =>
      ASSET_FALLBACK_DIRECTORIES.some((dir) => line.startsWith(`${dir}  `)),
    )
    expect(assetRuleLines.length).toBe(ASSET_FALLBACK_DIRECTORIES.length)
    for (const line of assetRuleLines) {
      expect(line).toMatch(/\/missing-asset\.html\s+404\s*$/)
      expect(line).not.toContain('index.html')
    }
  })

  it('no active rule targets a file literally named 404.html', () => {
    // A real dist/404.html regressed EVERY navigation route to a bare 404 on the live preview:
    // Cloudflare's own top-level-404.html detection disables the automatic SPA rewrite
    // project-wide, ahead of and independent of whatever _redirects says (caught by
    // deployment-check.mjs's /login|/invite|/admin checks, see vite.config.ts's own comment).
    // Checked against the RULE lines only (comments explaining this are fine to mention it).
    for (const line of lines) {
      expect(line).not.toMatch(/\b404\.html\b/)
    }
  })

  it('places every asset-directory rule BEFORE the SPA catch-all (first-match-wins ordering)', () => {
    const catchAllIndex = lines.findIndex((line) => line.startsWith('/*  '))
    expect(catchAllIndex).toBeGreaterThan(-1)
    const assetIndexes = lines
      .map((line, i) =>
        ASSET_FALLBACK_DIRECTORIES.some((dir) => line.startsWith(`${dir}  `)) ? i : -1,
      )
      .filter((i) => i !== -1)
    expect(assetIndexes.length).toBe(ASSET_FALLBACK_DIRECTORIES.length)
    for (const i of assetIndexes) {
      expect(i).toBeLessThan(catchAllIndex)
    }
  })

  it('the trailing catch-all rewrites everything else to index.html at 200 (real SPA routes)', () => {
    const catchAll = lines.find((line) => line.startsWith('/*  '))
    expect(catchAll).toMatch(/\/index\.html\s+200\s*$/)
  })

  it('is deterministic and never references a secret or environment-specific value', () => {
    expect(buildAssetFallbackRedirects()).toBe(redirects)
    expect(redirects.toLowerCase()).not.toMatch(/supabase|token|key|secret/)
  })
})
