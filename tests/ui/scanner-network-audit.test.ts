import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * I8 — network privacy audit for the scanner (prompt §34): captured image bytes must NEVER
 * become arguments to Supabase queries, fetch, TCGdex calls or logging. Two complementary
 * proofs:
 *
 *   1. STATIC: every module under the scanner feature is enumerated and asserted to contain no
 *      direct network/storage surface at all — no supabase client import, no fetch/WebSocket/
 *      XMLHttpRequest/TCGdex reference, no console logging of any kind. The ONLY way scanner
 *      code reaches the network is through src/data adapters (catalog search + variants) and
 *      the acquisition RPC wrapper, whose textual-only inputs are pinned by the controller's
 *      runtime tests.
 *   2. The engine module is additionally asserted to perform no fetch itself (assets are loaded
 *      by the BROWSER via same-origin worker/core URLs, not by application code).
 */

const SCANNER_DIR = join(process.cwd(), 'src', 'features', 'scanner')

function scannerSources(): { file: string; text: string }[] {
  const files = readdirSync(SCANNER_DIR).filter(
    (name) => name.endsWith('.ts') || name.endsWith('.tsx'),
  )
  return files.map((file) => ({
    file,
    text: readFileSync(join(SCANNER_DIR, file), 'utf-8'),
  }))
}

const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /from\s+['"].*supabase-client['"]/,
    why: 'scanner UI/engine must not import the Supabase client',
  },
  {
    pattern: /\bsupabase\b\s*\.\s*(from|rpc|channel|functions)\s*\(/,
    why: 'no direct Supabase queries from scanner code',
  },
  { pattern: /tcgdex/i, why: 'TCGdex is never called by scanner code' },
  { pattern: /\bfetch\s*\(/, why: 'no direct fetch in scanner code' },
  { pattern: /XMLHttpRequest|WebSocket/, why: 'no raw transport use in scanner code' },
  { pattern: /localStorage|sessionStorage|indexedDB/i, why: 'batch/photos never persist anywhere' },
  { pattern: /console\./, why: 'no logging (OCR strings are private)' },
]

describe('I8 static network-privacy audit', () => {
  it('every scanner module is free of direct network, storage and logging surfaces', () => {
    const sources = scannerSources()
    expect(sources.length).toBeGreaterThan(5)
    const violations: string[] = []
    for (const { file, text } of sources) {
      // Strip block comments so documentation mentioning e.g. "fetch" cannot false-positive.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const { pattern, why } of FORBIDDEN_PATTERNS) {
        if (pattern.test(code)) violations.push(`${file}: ${why}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('tesseract.js is imported dynamically in exactly one engine module', () => {
    const sources = scannerSources()
    const importers = sources.filter(({ text }) =>
      /import\(\s*['"]tesseract\.js['"]\s*\)/.test(text),
    )
    expect(importers.map((entry) => entry.file)).toEqual(['ocr-engine.ts'])
    // And no static import anywhere.
    for (const { file, text } of sources) {
      expect(
        /from\s+['"]tesseract\.js['"]/.test(text),
        `${file} statically imports tesseract`,
      ).toBe(false)
    }
  })

  it('the OCR asset base is SAME-ORIGIN (/scanner-assets/v7) — no CDN anywhere', () => {
    const engine = readFileSync(join(SCANNER_DIR, 'ocr-engine.ts'), 'utf-8')
    expect(engine).toContain("SCANNER_ASSET_BASE = '/scanner-assets/v7'")
    expect(engine).not.toMatch(/jsdelivr|unpkg|cdn\./i)
  })
})
