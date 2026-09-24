import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Structural half of Price Check's read-only contract (P153). Price Check must be able to look a
 * price up without ever being able to create a holding, purchase, sale, manual card, cost
 * adjustment or ledger row. This test reads the actual source of every Price Check module and fails
 * if any of them gains a write-capable call, an acquisition entry point, or an import of a
 * ledger data module.
 *
 * It is one of three independent layers: this static check, the runtime scan-session test
 * (tests/ui/price-check-scan-session.test.ts — a controller whose commitBatch throws is never
 * called), and the browser network-log test (tests/e2e/price-check.spec.ts — no request that could
 * mutate state leaves the page). None of them alone is the proof.
 */

const ROOT = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const files = [
  ...walk(join(ROOT, 'src', 'domain', 'price-check')),
  ...walk(join(ROOT, 'src', 'features', 'price-check')),
  join(ROOT, 'src', 'data', 'price-check.ts'),
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const sources = files.map((file) => ({
  file: relative(ROOT, file).replace(/\\/g, '/'),
  code: stripComments(readFileSync(file, 'utf-8')),
}))

/** One import statement per entry: lazily up to the first `from '…'`, so a multi-line import is a
 *  single statement and never swallows the one after it. */
function importStatements(code: string): string[] {
  return code.match(/^import[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? []
}

describe('Price Check is read-only by construction', () => {
  it('finds the modules under test (guards against a silently empty scan)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(12)
    expect(sources.some((s) => s.file === 'src/data/price-check.ts')).toBe(true)
    expect(sources.some((s) => s.file.endsWith('scan-session.ts'))).toBe(true)
  })

  const FORBIDDEN: [string, RegExp][] = [
    ['an RPC call', /\.rpc\s*\(/],
    ['an insert', /\.insert\s*\(/],
    ['an update', /\.update\s*\(/],
    ['an upsert', /\.upsert\s*\(/],
    ['a delete', /\.delete\s*\(/],
    ['add_card_acquisition', /add_card_acquisition|addCardAcquisition/],
    ['a purchase write', /create_purchase|createPurchase|update_purchase|updatePurchase/],
    ['a sale write', /create_sale|createSale|update_sale|updateSale/],
    ['the scanner commit path', /commitBatch/],
    // P161: the ONLY door into the scanner is the read-only contract (scanner-identification.ts).
    // The full controller factory is what carries commitBatch — Price Check must never name it.
    [
      'the full scanner controller factory',
      /getScannerUiController|createRealScannerController|ScannerUiController\b/,
    ],
    ['a second scanner port narrowing', /narrowScannerPort/],
    ['manual card creation', /createManualCard|manual_card|createCustom/],
    ['a cost adjustment', /cost_adjust|costAdjust/i],
    ['a holding write', /createHolding/],
    ['localStorage/sessionStorage persistence', /localStorage|sessionStorage/],
  ]

  it.each(FORBIDDEN)('no Price Check module contains %s', (_name, pattern) => {
    const offenders = sources.filter((s) => pattern.test(s.code)).map((s) => s.file)
    expect(offenders).toEqual([])
  })

  it('imports no ledger, purchase, sale, opening, export or portfolio data module', () => {
    const LEDGER =
      /['"](?:\.\.?\/)+(?:data\/)?(collection|purchases|sales|opening|reset|customCollections|portfolio|portfolioExport|dashboard|sealedProducts|retailers|profile|export)(?:\/[^'"]*)?['"]$/
    const offenders = sources
      .flatMap((s) => importStatements(s.code).map((statement) => ({ file: s.file, statement })))
      .filter(({ statement }) => LEDGER.test(statement))
      .map(({ file, statement }) => `${file}: ${statement.replace(/\s+/g, ' ')}`)
    expect(offenders).toEqual([])
  })

  it('the only Supabase surface is the search-prices function and a SELECT on fx_rates', () => {
    const data = sources.find((s) => s.file === 'src/data/price-check.ts')?.code ?? ''
    expect(data.match(/supabase\s*\.\s*\w+/g)?.map((m) => m.replace(/\s+/g, ''))).toEqual([
      'supabase.functions',
      'supabase.from',
    ])
    expect(data).toMatch(/\.from\(\s*'fx_rates'\s*\)\s*\.select\(/)
    expect(data).toMatch(/invoke\(name, options\)/)
    for (const s of sources) {
      if (s.file === 'src/data/price-check.ts') continue
      expect(s.code, s.file).not.toMatch(/supabase-client|supabase\s*\./)
    }
  })

  it('the text search never statically imports the scanner (it loads only on the scan page)', () => {
    // Heavy scanner modules (the decoder, and the read-only contract that pulls in the controller)
    // may only be reached through a dynamic import(); only these tiny modules may be static.
    const LIGHT = /scanner\/(errors|camera-acquisition-guard|contract)['"]$/
    for (const s of sources) {
      const offending = importStatements(s.code).filter(
        (statement) =>
          !/^import\s+type\b/.test(statement) &&
          /scanner\/[^'"]+['"]$/.test(statement) &&
          !LIGHT.test(statement),
      )
      expect(offending, s.file).toEqual([])
    }
    const scan = sources.find((s) => s.file.endsWith('PriceCheckScanPage.tsx'))?.code ?? ''
    expect(scan).toMatch(/import\(\s*'\.\.\/scanner\/capture'\s*\)/)
    expect(scan).not.toMatch(/import\(\s*'\.\.\/scanner\/controller'\s*\)/)
    const session = sources.find((s) => s.file.endsWith('scan-session.ts'))?.code ?? ''
    expect(session).toMatch(/import\(\s*'\.\.\/scanner\/scanner-identification'\s*\)/)
    const search = sources.find((s) => s.file.endsWith('PriceCheckPage.tsx'))?.code ?? ''
    expect(search).not.toMatch(/scanner\//)
    const result = sources.find((s) => s.file.endsWith('PriceCheckResultPage.tsx'))?.code ?? ''
    expect(result).not.toMatch(/scanner\//)
  })

  it('"Add to collection" is only a link into the existing add flow, never a call', () => {
    const page = sources.find((s) => s.file.endsWith('PriceCheckResultPage.tsx'))?.code ?? ''
    expect(page).toMatch(/to="\/add"/)
    expect(page).toMatch(/search=\{\{ variantId:/)
    expect(page).not.toMatch(/useMutation/)
  })

  it('no Price Check module uses a mutation hook', () => {
    const offenders = sources
      .filter((s) => /useMutation|mutateAsync/.test(s.code))
      .map((s) => s.file)
    expect(offenders).toEqual([])
  })
})
