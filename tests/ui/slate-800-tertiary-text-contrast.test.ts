import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P111 — regression guard for a real, axe-caught WCAG AA failure found while extending private
 * route smoke coverage to the Catalog page's set-image fallback badge: `bg-slate-800` remaps to
 * `--pp-step-1` (a LIGHT surface in light mode, `#e8e5dd`) and `text-slate-500` remaps to
 * `--pp-text-tertiary` (`#6e6d61`) — 4.14:1, just under AA's 4.5:1 for normal-size text. Neither
 * color is broken on its own (`--pp-text-tertiary` was itself specifically tuned for AA against
 * `--pp-background` by D-101/P101 — see index.css's own comment), but that verification never
 * covered THIS background: `--pp-step-1` is a step darker than `--pp-background` in light mode,
 * not the same surface. Same root-cause SHAPE as `accent-wash-contrast.test.ts`'s P105 finding —
 * a token proven fine against one surface silently reused against a different one it was never
 * measured against — just a different token pair.
 *
 * Two real instances found and fixed (`text-slate-300` → `--pp-text-secondary`, 6.15:1 light /
 * 6.95:1 dark, comfortably AA): `SetGrid.tsx`'s no-image set fallback ("BS"-style initials) and
 * `SealedProductImage.tsx`'s no-image sealed-product fallback (this one is NOT aria-hidden — a
 * real `role="img"` label, the common case since seeded sealed products mostly carry no image).
 * Neither had been reached by an earlier a11y sweep before P111 added fixture-backed E2E coverage
 * for the routes that render them without an image.
 */

const SRC_DIR = join(process.cwd(), 'src')

function tsxSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.tsx')) continue
      out.push({
        file: relative(SRC_DIR, full).replace(/\\/g, '/'),
        text: readFileSync(full, 'utf-8'),
      })
    }
  }
  walk(SRC_DIR)
  return out
}

// Deliberately narrow: only the specific measured-broken pairing (a slate-800 box used as a
// background with slate-500 as its own text), not every independent use of either utility
// elsewhere (e.g. `text-slate-500` directly on the page's own background, never measured broken).
const SLATE_800_BG = /(?<!hover:)bg-slate-800\b/
const TERTIARY_TEXT = /(?<!hover:)text-slate-500\b/

// Extracts each `className="..."` / `className='...'` / `className={`...`}` attribute VALUE
// (including a template literal's static text either side of a `${...}` interpolation) so both
// utilities are only ever checked for co-occurrence WITHIN ONE element's own class list — never
// across two sibling elements. A whole-file character-proximity heuristic (this test's first
// version) produced real false positives here: a loading-skeleton `<div className="... bg-slate-
// 800/60" />` sitting a few dozen characters from a completely unrelated sibling `<p
// className="text-slate-500">` status line is a common idiom in this codebase (ScannerPage.tsx,
// AddSealedProductPage.tsx), well inside any proximity window generous enough to still span the
// two REAL bugs' own multi-class literals (29 and 49 chars between the two classes).
const CLASS_NAME_VALUE = /className=(?:\{?`([^`]*)`\}?|"([^"]*)"|'([^']*)')/g

function classNameValues(text: string): string[] {
  return [...text.matchAll(CLASS_NAME_VALUE)].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const { file, text } of tsxSources()) {
    const paired = classNameValues(text).some(
      (value) => SLATE_800_BG.test(value) && TERTIARY_TEXT.test(value),
    )
    if (paired) offenders.push(file)
  }
  return offenders
}

describe('slate-800/tertiary-text contrast regression guard (P111)', () => {
  it('no .tsx file pairs a non-hover bg-slate-800 with non-hover text-slate-500 in the same element', () => {
    expect(findOffenders()).toEqual([])
  })
})
