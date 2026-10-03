import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DARK_TOKENS, MIN_TOUCH } from '../../src/ui/theme'

/**
 * P181 §2/§6/§10/§14: device-matrix/accessibility/performance regression guards, source-scan style
 * (same convention as tests/unit/p178-visual-contracts.test.tsx and
 * tests/unit/record-purchase-uses-shared-allocator.test.ts — fast, exact, no native layout engine
 * required) for properties that are otherwise only verifiable on a real device. Each corresponds to
 * one new mutant in scripts/mutation-proofs.mjs (P37-P44). A few of the mission's requested
 * properties are ALREADY covered by pre-existing tests and are re-verified there, not duplicated
 * here (see output_181.txt's MUTATIONS section):
 *   - "target < 48dp" (including the tab bar): tests/unit/p170-integration.test.tsx
 *   - "footer overlay": tests/unit/p178-visual-contracts.test.tsx (TaskFooter never `position:
 *     absolute`)
 *   - "theme token bypass" (hardcoded hex colour): tests/unit/p178-visual-contracts.test.tsx
 *   - "selected radio missing selected state" / "disabled control focusable incorrectly": extended
 *     directly into tests/unit/p170-integration.test.tsx's existing full-app touch-target sweep
 *     (P181 also closes a real pre-existing gap there: that sweep only queried role="button", never
 *     role="radio" — SegmentedControl's printing/currency choices were never swept at all).
 */

const appRoot = join(__dirname, '..', '..')
const src = (path: string): string => readFileSync(join(appRoot, 'src', path), 'utf8')

it('MoneyText always exposes the FULL, untruncated amount to screen readers, even in shrink-to-fit rows (P181 mutant #37)', () => {
  const text = src('ui/components.tsx')
  // The accessibility label is built from the same `text` the visual Text renders, regardless of
  // `fit` — so a screen reader always gets the real amount even if `adjustsFontSizeToFit` could not
  // shrink a pathologically long amount (e.g. a 15+ digit NOK total) enough to avoid a *visual*
  // ellipsis at 200% font scale. This is the accessibility safety net for MONEY STRESS (P181 §3),
  // which itself must still be confirmed with real font metrics on a real device.
  expect(text).toMatch(/accessibilityLabel=\{value === null \? 'No value' : text\}/)
})

it('the touch-target floor stays 48dp (P181 mutant #38, re-verified by the existing device-matrix sweep in p170-integration.test.tsx)', () => {
  expect(MIN_TOUCH).toBe(48)
})

it('Collection and Search FlatLists key by a real stable id, never by array index (P181 mutant #39: index keys cause key collisions/remounts -> scroll jank on reorder or filter)', () => {
  const collection = src('ui/screens/CollectionScreen.tsx')
  expect(collection).toMatch(/keyExtractor=\{\(row\) => row\.holdingId\}/)
  const search = src('features/catalog-search/CatalogSearchScreen.tsx')
  expect(search).toMatch(/keyExtractor=\{\(hit\) => hit\.cardId\}/)
})

it('the Collection list keeps its getItemLayout (avoids FlatList measurement passes that cause scroll jank) (P181 mutant #40)', () => {
  const collection = src('ui/screens/CollectionScreen.tsx')
  expect(collection).toMatch(/getItemLayout=\{getItemLayout\}/)
})

it('App.tsx never creates a second app runtime in the same JS process (Activity recreation on a font/density/locale change must reuse it, not duplicate stores/subscriptions) (P181 mutant #41)', () => {
  const app = readFileSync(join(appRoot, 'App.tsx'), 'utf8')
  expect(app).toMatch(/let appRuntime: Runtime \| null = null/)
  expect(app).toMatch(/if \(appRuntime !== null\) return appRuntime/)
})

it('TaskScreen (the write-form layout every financial screen shares) keeps its KeyboardAvoidingView, so the focused field and the footer both stay reachable above the keyboard (P181 mutant #42)', () => {
  const text = src('ui/components.tsx')
  const taskScreen = text.slice(
    text.indexOf('export function TaskScreen'),
    text.indexOf('// ---', text.indexOf('export function TaskScreen')),
  )
  expect(taskScreen).toMatch(/KeyboardAvoidingView/)
})

it('none of the five financial write-form screens hand-roll their own absolutely-positioned footer (the shared TaskScreen/TaskFooter composition is the only place a footer may overlay content) (P181 mutant #43)', () => {
  const screens = [
    'RecordPurchaseScreen.tsx',
    'RecordSaleScreen.tsx',
    'RecordOpeningScreen.tsx',
    'AddAcquisitionScreen.tsx',
    'ManualValuationScreen.tsx',
  ]
  for (const name of screens) {
    const text = src(`ui/screens/${name}`)
    expect(text).toMatch(/TaskScreen/)
    expect(text).not.toMatch(/position:\s*['"]absolute['"]/)
  }
})

it("the native splash background and the dark theme's own background token never drift apart (a white/default splash would flash before the themed UI mounts) (P181 mutant #44)", () => {
  const appJson = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')) as {
    expo: { backgroundColor?: string }
  }
  expect(appJson.expo.backgroundColor?.toUpperCase()).toBe(DARK_TOKENS.background.toUpperCase())
})
