import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P105 — regression guard for two real, computed WCAG AA/near-invisible-text failures, both from
 * the same root cause: index.css's `@theme` remap collapses Tailwind's whole sky-50..950 scale
 * onto just THREE actual colors (`--pp-accent`, `--pp-accent-soft`, `--pp-accent-wash`), and two
 * of those three are unsuited as general foreground TEXT once they land on an accent-tinted WASH
 * background of their own family:
 *
 * 1. `--pp-accent-soft` (sky-200/300/400) is IDENTICAL to `--pp-accent` in light mode (`#8f5f35`
 *    both — dark mode correctly differentiates them). Axe caught this for real on Home's chart
 *    range-selector pills (3.78-3.95:1, needs 4.5:1); a byte-identical "selected chip" pattern
 *    (`border-sky-500 bg-sky-600/20 text-sky-200`, plus a border-less `bg-sky-600/20 text-sky-200`
 *    variant) was copy-pasted across ~20 more files with the same failure, only reachable there
 *    because axe's page-load-only scan happened to hit Home's instance.
 * 2. `--pp-accent-wash` (sky-100, and sky-200 at reduced opacity) as TEXT on a `bg-sky-9xx/NN`
 *    wash background — computed by hand (WCAG relative-luminance formula) at ~1.2-1.3:1 in BOTH
 *    themes (LineEditor.tsx's "card/sealed product selected" chip, ExportPage.tsx's "backup
 *    ready" panel) — near-invisible text, worse than (1), and never axe-caught at all because it
 *    only renders after a user interaction (a card actually selected, an export actually
 *    prepared), not on initial page load.
 *
 * Fixed by swapping the TEXT color to `text-slate-200`/`text-slate-300` (→ `--pp-text-primary`/
 * `--pp-text-secondary`, this app's own already-AA-proven neutral tokens, correctly high-contrast
 * in both themes) while leaving the accent-colored border/background as the visual cue — the same
 * "abandon the broken token pairing for the neutral vocabulary" fix already applied for the amber
 * banner (P104, ProfilePage). This is a LOCAL class-usage fix, not a change to
 * `--pp-accent`/`--pp-accent-soft`/`--pp-accent-wash` themselves (out of scope — P103 owns global
 * accent-token work), so it makes no claim about every possible `text-sky-*` usage — only the
 * specific wash-background pairings that were actually measured broken. A `hover:` prefixed
 * pairing (only visible mid-interaction, not what a page-load OR the interaction states above
 * render at rest) is deliberately not flagged here.
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

// Deliberately narrow (not "any sky text near any sky bg") to avoid flagging legitimate uses —
// e.g. plain `text-sky-400` links on the ordinary page background (never on a wash, never
// measured broken), solid `bg-sky-600 text-white` primary buttons (already audited elsewhere,
// P101/P103), or a `hover:` prefixed pairing (only visible mid-interaction).
const WASH_BG = /(?<!hover:)bg-sky-[5-9]\d\d\/\d\d/g
const SOFT_TEXT = /(?<!hover:)text-sky-[123]00\b/g
// Generous enough to span one multi-class Tailwind literal (border + bg + text on one className
// string, or a short ternary building one up) without reaching into an unrelated sibling element.
const PROXIMITY_CHARS = 120

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const { file, text } of tsxSources()) {
    const bgPositions = [...text.matchAll(WASH_BG)].map((m) => m.index)
    const textPositions = [...text.matchAll(SOFT_TEXT)].map((m) => m.index)
    const paired = bgPositions.some((bgAt) =>
      textPositions.some((textAt) => Math.abs(textAt - bgAt) <= PROXIMITY_CHARS),
    )
    if (paired) offenders.push(file)
  }
  return offenders
}

describe('accent-wash contrast regression guard (P105)', () => {
  it('no .tsx file pairs a non-hover bg-sky-[5-9]xx/NN wash with non-hover text-sky-100/200/300', () => {
    expect(findOffenders()).toEqual([])
  })
})
