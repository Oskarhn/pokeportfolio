import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P103 — WCAG 2.2 AA contrast for the primary-button accent surface (`--pp-accent` /
 * `--pp-accent-foreground` in src/styles/index.css). P101 measured white-on-`--pp-accent` at
 * 2.53:1 in dark mode — a real AA failure (normal-size text needs >=4.5:1) on every primary
 * button app-wide. The fix changes the FOREGROUND token, not the accent color itself
 * (DESIGN_SYSTEM.md's bronze/copper direction is unchanged).
 *
 * No component-rendering infrastructure exists in this project (see D-109/D-110's own notes), so
 * this reads the actual literal hex values straight out of index.css — the same real numbers a
 * browser paints — and computes the standard WCAG relative-luminance/contrast-ratio formulas
 * directly, rather than asserting against a hand-copied "should be" ratio.
 */

const CSS_PATH = join(process.cwd(), 'src', 'styles', 'index.css')

function cssSource(): string {
  return readFileSync(CSS_PATH, 'utf-8')
}

/** Extracts `--name: #rrggbb;` from one already-isolated block of CSS text. */
function tokenHex(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block)
  if (!match?.[1]) throw new Error(`token --${name} not found`)
  return match[1]
}

function srgbToLinear(c: number): number {
  const normalized = c / 255
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2.x contrast ratio, always expressed as (lighter + 0.05) / (darker + 0.05) >= 1. */
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA)
  const lumB = relativeLuminance(hexB)
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

const AA_NORMAL_TEXT_MINIMUM = 4.5

describe('contrastRatio helper self-check', () => {
  it('black on white is the maximum possible ratio, 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('a color against itself is exactly 1:1', () => {
    expect(contrastRatio('#8f5f35', '#8f5f35')).toBeCloseTo(1, 5)
  })

  it('reproduces the exact 2.53:1 regression P101 measured (white on the OLD dark accent alone, not the shipped foreground)', () => {
    // Historical record only — #c99a66 (--pp-accent, dark) is still the accent color today
    // (unchanged, by design); this pins that the failure was real and exactly this ratio, so a
    // future reader can trust the "AFTER" numbers below were measured the same way.
    expect(contrastRatio('#ffffff', '#c99a66')).toBeCloseTo(2.53, 1)
  })
})

describe('primary-button accent/foreground pair meets WCAG AA (4.5:1) in every theme', () => {
  const source = cssSource()

  it('light mode (:root)', () => {
    const lightBlock = /:root\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
    const accent = tokenHex(lightBlock, 'pp-accent')
    const foreground = tokenHex(lightBlock, 'pp-accent-foreground')
    expect(contrastRatio(accent, foreground)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MINIMUM)
  })

  it('system dark (@media prefers-color-scheme: dark)', () => {
    const darkMediaBlock = /prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?\n {2}\}\n\}/.exec(
      source,
    )?.[0]
    if (!darkMediaBlock) throw new Error('system-dark media block not found')
    const accent = tokenHex(darkMediaBlock, 'pp-accent')
    const foreground = tokenHex(darkMediaBlock, 'pp-accent-foreground')
    const ratio = contrastRatio(accent, foreground)
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MINIMUM)
    // Regression pin: this used to be 2.53:1 with white. The fixed pairing must be comfortably
    // clear of the 4.5:1 floor, not just barely over it.
    expect(ratio).toBeGreaterThan(7)
  })

  it("explicit dark override (:root[data-theme='dark'])", () => {
    const explicitDarkBlock = /:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/.exec(source)?.[0]
    if (!explicitDarkBlock) throw new Error('explicit dark block not found')
    const accent = tokenHex(explicitDarkBlock, 'pp-accent')
    const foreground = tokenHex(explicitDarkBlock, 'pp-accent-foreground')
    expect(contrastRatio(accent, foreground)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MINIMUM)
  })

  it('the two dark blocks (system + explicit override) agree exactly — no drift between them', () => {
    const darkMediaBlock = /prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?\n {2}\}\n\}/.exec(
      source,
    )?.[0]
    const explicitDarkBlock = /:root\[data-theme='dark'\]\s*\{[\s\S]*?\n\}/.exec(source)?.[0]
    if (!darkMediaBlock || !explicitDarkBlock) throw new Error('dark blocks not found')
    expect(tokenHex(explicitDarkBlock, 'pp-accent-foreground')).toBe(
      tokenHex(darkMediaBlock, 'pp-accent-foreground'),
    )
  })
})

describe('no component hardcodes text-white on an accent surface any more', () => {
  it("src/ui/form.tsx's primary Button variant uses the accent-foreground token", () => {
    const button = readFileSync(join(process.cwd(), 'src', 'ui', 'form.tsx'), 'utf-8')
    expect(button).toMatch(/primary:\s*'bg-sky-600 text-accent-foreground/)
    expect(button).not.toMatch(/primary:\s*'bg-sky-600 text-white/)
  })

  it('no source file pairs a bg-sky-500/600/700 utility with text-white in the same class string', () => {
    // Grep-equivalent static audit — cheap, and directly prevents the exact class of drift this
    // fix closes (a NEW hardcoded button reintroducing the 2.53:1 failure one file at a time).
    const violations: string[] = []
    function walk(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!name.endsWith('.tsx')) continue
        const text = readFileSync(full, 'utf-8')
        for (const match of text.matchAll(/className=(\{?[`"'][^`"']*[`"']\}?)/g)) {
          const value = match[1] ?? ''
          if (/bg-sky-[567]00/.test(value) && /\btext-white\b/.test(value)) {
            violations.push(`${full.replace(process.cwd(), '')}: ${value}`)
          }
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(violations).toEqual([])
  })
})

/**
 * P110 (prompt §20 — P107's A11Y_TOKEN_FINDINGS: a second, independent contrast bug in
 * ScannerPage.tsx beyond the nine P105 audited): the `?scannerDebug=1` overlay used `bg-slate-950`
 * — themed (`--color-slate-950: var(--pp-background)` in index.css's @theme block) — as what its
 * author clearly intended to be a permanently-dark debug console background, paired with literal
 * (unthemed) `text-amber-100/200/300`. In light mode, `--pp-background` is `#faf9f6` (near-white),
 * making the amber text nearly invisible. The fix switches the panel to `bg-neutral-950`, which is
 * NOT part of this app's theme remap (only slate/sky/rose/emerald are — src/styles/index.css's
 * @theme block) and therefore stays a real near-black in every theme.
 *
 * Tailwind v4 defines its palette in OKLCH, not hex (`node_modules/tailwindcss/theme.css`), so the
 * hex constants below are not hand-converted (real OKLCH-to-sRGB conversion is easy to get subtly
 * wrong) — they were measured directly from a real browser's `canvas.fillStyle` + `getImageData`
 * round trip over Tailwind's own declared OKLCH values for `neutral-950`/`amber-100/200/300`,
 * the same "measure the real value, never guess" bar this project applies everywhere else.
 */
describe('scanner debug overlay (?scannerDebug=1) contrast (P110)', () => {
  // Real Tailwind v4 default-palette values, browser-measured (see this block's own header).
  const NEUTRAL_950 = '#0a0a0a'
  const AMBER_100 = '#fef3c6'
  const AMBER_200 = '#fee685'
  const AMBER_300 = '#ffd230'
  // This app's own light-mode `--pp-background` (src/styles/index.css) — what `bg-slate-950`
  // resolved to in light mode before the fix, i.e. the actual broken pairing.
  const PP_BACKGROUND_LIGHT = '#faf9f6'

  it('REGRESSION DOCUMENTED: the OLD themed pairing (amber text on light-mode --pp-background) failed WCAG AA badly', () => {
    expect(contrastRatio(AMBER_100, PP_BACKGROUND_LIGHT)).toBeLessThan(AA_NORMAL_TEXT_MINIMUM)
  })

  it('the FIXED pairing (amber text on the literal, unthemed neutral-950) passes WCAG AA comfortably for every amber shade the panel uses', () => {
    for (const amber of [AMBER_100, AMBER_200, AMBER_300]) {
      expect(contrastRatio(amber, NEUTRAL_950)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MINIMUM)
    }
  })

  it("the fixed background is theme-INDEPENDENT by construction: neutral-950 is not part of this app's @theme remap", () => {
    const themeBlock = /@theme\s*\{[\s\S]*?\n\}/.exec(cssSource())?.[0] ?? ''
    expect(themeBlock).not.toMatch(/--color-neutral-950:/)
  })

  it("ScannerPage.tsx no longer pairs a themed slate-9xx/950 background with the debug panel's literal amber foreground", () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'features', 'scanner', 'ScannerPage.tsx'),
      'utf-8',
    )
    // The debug-overlay-specific occurrences (container, the rank-lookup search input, and the
    // debug image preview tiles) must all use the unthemed neutral-9xx family now.
    expect(source).toContain('bg-neutral-950/95')
    expect(source).toContain('bg-neutral-900')
    // No remaining amber-foreground element is still paired with a themed slate-900/950
    // background anywhere in this file (a plain string scan is sufficient here: this file's only
    // amber-text usages ARE the debug overlay, confirmed by the surrounding describe blocks in
    // this project's own broader amber-token audit).
    expect(source).not.toMatch(/bg-slate-9(00|50)[^"]*text-amber/)
  })

  it('reports the measured contrast ratios so a future reader can see the actual before/after numbers, not just pass/fail', () => {
    // Light-mode LIGHT_CONTRAST and dark-mode DARK_CONTRAST are now IDENTICAL by construction —
    // the panel's background no longer depends on the app's theme at all (see the "theme
    // INDEPENDENT" test above). amber-300 is the lowest-contrast of the three panel text shades
    // against neutral-950 (measured ~13.68:1); amber-100 is the highest (~17.77:1) — both are
    // reported here, and both are nowhere near the ~1.06:1 the old light-mode pairing produced.
    const worstCase = contrastRatio(AMBER_300, NEUTRAL_950)
    const bestCase = contrastRatio(AMBER_100, NEUTRAL_950)
    expect(worstCase).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MINIMUM)
    expect(worstCase).toBeGreaterThan(10)
    expect(bestCase).toBeGreaterThan(worstCase)
  })
})
