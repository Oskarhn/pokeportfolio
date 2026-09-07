// Test-only harness for tests/e2e/p117-money-date-real-browser.spec.ts. Never imported by app
// code — bundled standalone (see that spec's beforeAll) and injected into a real Chromium/WebKit
// page so the exact shipped money-format / local-date modules run on real browser JS engines
// instead of only Node's V8 (which is all vitest/jsdom ever exercises).
import { formatNokMinor, formatCurrencyMinor, parseNokInput } from '../../../src/ui/money-format'
import { localTodayIso } from '../../../src/platform/local-date'

declare global {
  interface Window {
    __p117: {
      formatNokMinor: typeof formatNokMinor
      formatCurrencyMinor: typeof formatCurrencyMinor
      parseNokInput: typeof parseNokInput
      localTodayIso: typeof localTodayIso
    }
  }
}

window.__p117 = { formatNokMinor, formatCurrencyMinor, parseNokInput, localTodayIso }
