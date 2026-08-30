/**
 * Cloudflare Pages nested-404 generation (P83, D-100) — configuration-level pin.
 *
 * The real platform behaviour (whether a missing asset genuinely gets a 404, and whether it
 * leaves the rest of the site's SPA fallback untouched) can only be proven against a real
 * Cloudflare Pages deployment — nested 404 handling doesn't exist under `vite dev`/`vite preview`
 * at all (same limitation `_headers` already has, documented in vite.config.ts) — so that proof
 * lives in output_83.txt's live-preview `curl` evidence, not here.
 *
 * TWO earlier approaches were deployed, curled, and found broken before this one: a top-level
 * `public/404.html` (disabled the SPA fallback for every route, not just asset ones) and a
 * `_redirects` rule targeting status 404 (Cloudflare Pages' `_redirects` does not support
 * arbitrary rewrite status codes at all — only 200 and the 30x redirect codes). See
 * `cloudflareAssetNotFoundPages`'s comment in vite.config.ts for the full account. This test
 * exists so neither regression can silently ship again.
 */
import { describe, expect, it } from 'vitest'
import { ASSET_FALLBACK_DIRECTORIES, buildAssetNotFoundPage } from '../../vite.config.ts'

describe('nested asset-directory 404 pages (P83, D-100)', () => {
  it('covers both directories a lazy chunk/scanner build artifact can live under', () => {
    expect(ASSET_FALLBACK_DIRECTORIES).toEqual(['assets', 'scanner-assets'])
  })

  it('none of the directory names is the project root — a NESTED 404 only, never top-level', () => {
    // A top-level dist/404.html disables Cloudflare's automatic SPA rewrite for EVERY route, not
    // just asset ones — reproduced directly against the live preview (deployment-check.mjs's
    // /login|/invite|/admin checks all failed). Every entry here must be a real subdirectory.
    for (const dir of ASSET_FALLBACK_DIRECTORIES) {
      expect(dir.length).toBeGreaterThan(0)
      expect(dir).not.toMatch(/^\/?$/)
      expect(dir.startsWith('/')).toBe(false)
    }
  })

  it('the generated page is real content, never the SPA index.html shell', () => {
    const page = buildAssetNotFoundPage()
    expect(page.length).toBeGreaterThan(0)
    expect(page).not.toContain('id="root"')
    expect(page).toContain('<!doctype html>')
  })

  it('is deterministic and never references a secret or environment-specific value', () => {
    expect(buildAssetNotFoundPage()).toBe(buildAssetNotFoundPage())
    expect(buildAssetNotFoundPage().toLowerCase()).not.toMatch(/supabase|token|key|secret/)
  })
})
