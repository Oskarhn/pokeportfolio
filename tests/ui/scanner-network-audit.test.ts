import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * I8 — network privacy audit for the scanner (prompt §34): captured image bytes must NEVER
 * become arguments to Supabase queries, fetch, TCGdex calls or logging. Two complementary
 * proofs:
 *
 *   1. STATIC: every module under the scanner feature (RECURSIVELY, including the P76 visual/
 *      subdirectory) is enumerated and asserted to contain no direct network/storage surface at
 *      all — no supabase client import, no WebSocket/XMLHttpRequest/TCGdex reference, no console
 *      logging of any kind. The ONLY way scanner code reaches the network is through src/data
 *      adapters (catalog search + variants) and the acquisition RPC wrapper, whose textual-only
 *      inputs are pinned by the controller's runtime tests — PLUS the visual worker's same-origin
 *      `/scanner-assets/visual-v1/` model/index asset fetches (D-097), which get their own
 *      narrower same-origin-literal check below rather than a blanket ban.
 *   2. The OCR engine module is additionally asserted to perform no fetch itself (assets are
 *      loaded by the BROWSER via same-origin worker/core URLs, not by application code).
 */

const SCANNER_DIR = join(process.cwd(), 'src', 'features', 'scanner')
/** The one module family allowed to call fetch() — and only for same-origin scanner assets. */
const VISUAL_ASSET_FETCHERS = ['visual/visual-worker.ts']

function scannerSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      out.push({
        file: relative(SCANNER_DIR, full).replace(/\\/g, '/'),
        text: readFileSync(full, 'utf-8'),
      })
    }
  }
  walk(SCANNER_DIR)
  return out
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
      if (!VISUAL_ASSET_FETCHERS.includes(file) && /\bfetch\s*\(/.test(code)) {
        violations.push(`${file}: no direct fetch outside the visual asset fetcher`)
      }
    }
    expect(violations).toEqual([])
  })

  it('the visual worker only fetches same-origin literal scanner-asset paths, never a variable URL or external host', () => {
    for (const relativeFile of VISUAL_ASSET_FETCHERS) {
      const text = readFileSync(join(SCANNER_DIR, relativeFile), 'utf-8')
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const fetchCalls = [...code.matchAll(/fetch\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)]
      expect(fetchCalls.length).toBeGreaterThan(0)
      for (const match of fetchCalls) {
        const argument = match[1] ?? ''
        // P87 F-01: `INDEX_BASE` and `generationBase` are both derived FROM `ASSET_BASE`
        // (`${ASSET_BASE}/index` and `${INDEX_BASE}/generations/${contentId}` respectively,
        // confirmed by the literal-derivation assertions below) — same-origin by construction,
        // never independently sourced.
        expect(
          argument.includes('/scanner-assets/visual-v1/') ||
            argument.includes('${ASSET_BASE}') ||
            argument.includes('${INDEX_BASE}') ||
            argument.includes('${generationBase}'),
        ).toBe(true)
        expect(argument).not.toMatch(/https?:\/\/|jsdelivr|unpkg|huggingface|supabase/i)
      }
      // The two new base constants used above must themselves be literal derivations of
      // ASSET_BASE — never independently constructed from anything network-supplied.
      expect(code).toMatch(/const INDEX_BASE = `\$\{ASSET_BASE\}\/index`/)
      expect(code).toMatch(
        /const generationBase = `\$\{INDEX_BASE\}\/generations\/\$\{contentId\}`/,
      )
    }
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

  it('the visual worker disables remote model loading and its asset base is SAME-ORIGIN — no CDN anywhere (D-097)', () => {
    const worker = readFileSync(join(SCANNER_DIR, 'visual', 'visual-worker.ts'), 'utf-8')
    expect(worker).toContain("ASSET_BASE = '/scanner-assets/visual-v1'")
    expect(worker).toContain('env.allowRemoteModels = false')
    // Strip comments first: the file's OWN doc comments explain (and thus mention) the CDN
    // hosts this code deliberately avoids — only executable code may never reference them.
    const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/jsdelivr|unpkg|cdn\.|huggingface\.co/i)
  })
})
