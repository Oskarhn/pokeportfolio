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
    const darkMediaBlock = /prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?\n  \}\n\}/.exec(source)?.[0]
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
    const darkMediaBlock = /prefers-color-scheme:\s*dark\)\s*\{[\s\S]*?\n  \}\n\}/.exec(source)?.[0]
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
