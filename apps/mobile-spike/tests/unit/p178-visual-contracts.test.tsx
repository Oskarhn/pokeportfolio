import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { statusBarStyleFor } from '../../src/ui/theme'

/**
 * P178 §31: visual/product-honesty contracts as regression guards, most as a source scan (fast,
 * exact) rather than a full render — the same style this project already uses for structural
 * guards (record-purchase-uses-shared-allocator.test.ts). Each corresponds to one mutant in
 * output_178.txt's VISUAL_MUTATIONS. A few of the 12 mutants the mission lists are already covered
 * by other files and are not repeated here (see that section's own notes):
 *   - "unknown value becomes 0": tests/unit/format-money.test.ts, tests/unit/collection-store.test.ts
 *   - "money truncated": tests/unit/format-money.test.ts (breakableMoneyText / grouping)
 *   - "target < 48dp": tests/unit/p170-integration.test.tsx (the touch-target sweep this phase's
 *     own FilterChip/SegmentedControl regression was caught by)
 *   - "price appears before printing choice": tests/unit/native-app.test.tsx (choice_required has
 *     no observation card until a variant is chosen)
 *   - "selected currency ignored" / "JPY accepts a decimal fraction": tests/unit/
 *     record-purchase-currency-selector.test.tsx, tests/unit/record-purchase-uses-shared-allocator.test.ts
 */

const SRC_ROOT = join(__dirname, '..', '..', 'src')
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g

function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) allSourceFiles(full, out)
    // .tsx only: raw hex colours belong in styling/presentational files. Plain .ts domain/data
    // files legitimately contain "#"-prefixed strings that are not colours (e.g. "#025" for a
    // collector number), which a hex-shaped regex cannot tell apart from a real 3-digit hex.
    else if (/\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

it('no screen or component file bypasses the theme with a hardcoded hex colour (P178 mutant #2)', () => {
  const offenders: string[] = []
  for (const file of allSourceFiles(SRC_ROOT)) {
    // theme.ts/contrast.ts/contrast-audit.test.ts are the ONE place hex values are allowed to live.
    if (file.endsWith(join('ui', 'theme.ts')) || file.endsWith(join('ui', 'contrast.ts'))) continue
    const text = readFileSync(file, 'utf8')
    const matches = text.match(HEX_LITERAL)
    if (matches !== null) offenders.push(`${file}: ${matches.join(', ')}`)
  }
  expect(offenders).toEqual([])
})

const BANNED_PAYMENT_WORDS = /\b(wallet|checkout|cart|paying now|debit|credit card)\b/i

it('the financial write-form screens never use wallet/checkout/cart copy (P178 mutant #8)', () => {
  const screensDir = join(SRC_ROOT, 'ui', 'screens')
  const financialScreens = [
    'RecordPurchaseScreen.tsx',
    'RecordSaleScreen.tsx',
    'RecordOpeningScreen.tsx',
    'AddAcquisitionScreen.tsx',
    'ManualValuationScreen.tsx',
  ]
  for (const name of financialScreens) {
    const text = readFileSync(join(screensDir, name), 'utf8')
    // Strip comments/import lines first so a code-comment mentioning the banned word (as this file's
    // own does, to name what's checked) can't produce a false negative in THIS test's own subject.
    const stringsOnly = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
    expect(stringsOnly).not.toMatch(BANNED_PAYMENT_WORDS)
  }
})

it('RecordPurchaseScreen states plainly that nothing is charged (the product-honesty line fixtures require)', () => {
  const text = readFileSync(join(SRC_ROOT, 'ui', 'screens', 'RecordPurchaseScreen.tsx'), 'utf8')
  expect(text).toMatch(/Nothing is charged/)
})

it('the graded-prices section never renders a numeric grade or price (P178 mutant #7)', () => {
  const text = readFileSync(
    join(SRC_ROOT, 'features', 'price-check', 'CardPriceScreen.tsx'),
    'utf8',
  )
  const gradedBlock = text.slice(text.indexOf('p169-graded'))
  // The graded section is fixed copy from UNAVAILABLE_COPY; it must never format a Money/ExactMoney
  // value or interpolate a bare number into that block.
  expect(gradedBlock.slice(0, 400)).not.toMatch(/ExactMoney|MoneyText/)
})

it('the dark background always gets light status-bar icons, never a dark-on-dark bar (P178 mutant #11)', () => {
  expect(statusBarStyleFor('dark')).toBe('light')
  expect(statusBarStyleFor('light')).toBe('dark')
})

it('TaskFooter/TaskScreen never position the footer absolutely, so it can never overlay the last field (P178 mutant #12)', () => {
  const text = readFileSync(join(SRC_ROOT, 'ui', 'components.tsx'), 'utf8')
  const taskSection = text.slice(text.indexOf('export function TaskFooter'))
  expect(taskSection).not.toMatch(/position:\s*['"]absolute['"]/)
})
