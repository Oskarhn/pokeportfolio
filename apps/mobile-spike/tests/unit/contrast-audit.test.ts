import { contrastRatio } from '../../src/ui/contrast'
import { DARK_TOKENS, LIGHT_TOKENS, type Tokens } from '../../src/ui/theme'

/**
 * P178 §27: a programmatic contrast audit of the dark-first token pairs the app actually renders
 * text or a primary control on. This is a static-design-review number, not a certification (real
 * font scale, anti-aliasing and OLED sub-pixel rendering are not modelled) — see WARNINGS in
 * output_178.txt. WCAG 2.x normal-text AA is 4.5:1; UI components / large text is 3:1.
 */

const WCAG_AA_TEXT = 4.5
const WCAG_AA_LARGE_OR_UI = 3.0

function pairs(t: Tokens) {
  return {
    'primary text on background': [t.textPrimary, t.background],
    'secondary text on background': [t.textSecondary, t.background],
    'muted text on background': [t.textMuted, t.background],
    'accent text on background': [t.accent, t.background],
    'button text on accent (primary button fill)': [t.onAccent, t.accent],
    'destructive text on background': [t.negative, t.background],
    'placeholder on the sunken input surface': [t.textMuted, t.surfaceSunken],
    'warning text on background': [t.warning, t.background],
  } as const
}

describe('dark tokens (primary theme) meet WCAG AA for every text/control pair this app renders', () => {
  const p = pairs(DARK_TOKENS)
  for (const [name, [fg, bg]] of Object.entries(p)) {
    it(`${name}: >= 4.5:1`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT)
    })
  }
})

it('dark disabled text stays legible (>= 3:1) even though WCAG exempts disabled controls', () => {
  expect(contrastRatio(DARK_TOKENS.textDisabled, DARK_TOKENS.background)).toBeGreaterThanOrEqual(
    WCAG_AA_LARGE_OR_UI,
  )
})

describe('light tokens (kept functional, not the visual priority) still meet WCAG AA text contrast', () => {
  const p = pairs(LIGHT_TOKENS)
  for (const [name, [fg, bg]] of Object.entries(p)) {
    it(`${name}: >= 4.5:1`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT)
    })
  }
})

/** Visual-contract mutation #11 (output_178.txt VISUAL_MUTATIONS): a white status bar/background
 *  bleeding into the dark theme would collapse this exact contrast pair toward 1:1. */
it('mutation guard: background must not become light — primary-on-background stays >= 10:1', () => {
  expect(contrastRatio(DARK_TOKENS.textPrimary, DARK_TOKENS.background)).toBeGreaterThanOrEqual(10)
})
