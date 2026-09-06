import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P105 — `amber` is not part of this app's theme vocabulary at all: index.css's `@theme` block
 * remaps `slate`/`sky`/`rose`/`emerald` to light/dark-aware `--pp-*` custom properties (its own
 * comment: "New code should keep using the same slate/sky/rose/emerald vocabulary for exactly
 * this reason"), but never touches `amber` — every `amber-*` utility therefore renders Tailwind's
 * literal, non-theme-aware default palette (computed here directly from the installed
 * tailwindcss@4.3.3 package's own OKLCH definitions, not assumed from memory), regardless of
 * light/dark mode.
 *
 * P104 found and fixed one instance (ProfilePage's export-reminder banner, composited to 1.68:1)
 * and flagged 9 more files as "not confirmed broken, not confirmed fine." This session computed
 * every one by hand (WCAG relative-luminance formula, OKLCH->linear-sRGB per the CSS Color 4
 * spec) and found the amber palette's "vivid" stops (300/400/500, meant as light accents on DARK
 * backgrounds) measure 1.4-2.1:1 against this app's LIGHT-mode surfaces — real failures, not
 * theoretical, present in: MoneyDisplay's "stale price" badge, OpeningsWizardPage's gate-error
 * banner, the Portfolio/Catalog favourites toggle, three OpeningDetailPage markers, two
 * HoldingDetailPage/ListAndTableViews/GridTile favourite-star glyphs, and GridTile's stale-price
 * dot (non-text, 3:1 threshold, still failed at 2.13:1). All fixed by moving to whichever existing
 * themed token actually fits the semantic (slate for neutral captions, rose/`--pp-negative-*` for
 * the one genuine `role="alert"` error, sky for a "selected" toggle) — never a new amber remap,
 * since amber-950 is used both as a subtle BADGE WASH (wanting a light tint) and as
 * StaleDeploymentBanner's bold, deliberately dark, nearly-opaque banner background in the SAME
 * app, and those two intents cannot share one theme-aware token without breaking one of them.
 *
 * Two amber usages remain, both individually verified safe rather than swept up mechanically:
 *   - StaleDeploymentBanner.tsx: bg-amber-950/95 (nearly opaque) + text-amber-100 computes to
 *     11.8-13.6:1 in both themes — genuinely fine, the dark literal amber-950 IS the intended look.
 *   - ScannerPage.tsx's debug overlay: gated behind `?scannerDebug=1`, "never shown by default"
 *     (its own doc comment) — a developer diagnostic, not a route this release's private-app a11y
 *     bar was ever meant to cover; left as a disclosed, deliberate gap, not silently ignored.
 *
 * This guard is an ALLOWLIST, not a contrast check (recomputing OKLCH->WCAG on every test run is
 * unnecessary; the specific pairings were already verified once, by hand, above) — it exists so a
 * NEW amber-* usage introduced later fails loudly and forces the same "compute it, don't guess"
 * discipline, rather than silently reintroducing an invisible-text defect.
 */

const SRC_DIR = join(process.cwd(), 'src')
const ALLOWED_FILES = new Set(['ui/StaleDeploymentBanner.tsx', 'features/scanner/ScannerPage.tsx'])

function tsxFilesWithAmber(): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.tsx')) continue
      const rel = relative(SRC_DIR, full).replace(/\\/g, '/')
      if (ALLOWED_FILES.has(rel)) continue
      const text = readFileSync(full, 'utf-8')
      if (/\bamber-\d{2,3}\b/.test(text)) out.push(rel)
    }
  }
  walk(SRC_DIR)
  return out
}

describe('amber vocabulary guard (P105)', () => {
  it('no .tsx file outside the allowlist uses an amber-* utility class', () => {
    expect(tsxFilesWithAmber()).toEqual([])
  })
})
