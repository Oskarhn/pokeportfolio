import { test, expect } from '@playwright/test'
import { build } from 'vite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromMinorUnits, toDecimalString } from '../../src/domain/money'
import type { CurrencyCode } from '../../src/domain/currency'

/**
 * P117 §1 — vitest/jsdom only ever exercises Node's own V8. The money-format BigInt/Intl fix and
 * the local-date UTC-vs-local-calendar-day fix (both P114) are display/date-boundary logic that
 * could plausibly diverge on a different ICU/engine (WebKit/Safari is the one real user-facing
 * engine this app ships to that vitest never touches — see playwright.config.ts's `mobile-iphone`
 * project). This spec bundles the actual shipped `src/ui/money-format.ts` and
 * `src/platform/local-date.ts` with Vite (not a reimplementation) and runs the real output on
 * whatever engine each Playwright project uses: `desktop-chromium` (Chromium/V8) and
 * `mobile-iphone` (WebKit/JavaScriptCore, Playwright's `devices['iPhone 14']`), the project matrix
 * already defined in playwright.config.ts.
 */

/** Same normalization tests/ui/money-format.test.ts uses: compares digit content only, since the
 *  grouping-separator glyph (non-breaking space vs. thin space vs. narrow-no-break space) is a
 *  legitimate ICU implementation detail that can differ between Chromium's and WebKit's bundled
 *  ICU without either being wrong -- hardcoding one engine's glyph here would fail the other
 *  engine's project for a non-bug. */
function digitsOnly(value: string): string {
  const negative = /-|−/.test(value)
  const digits = value.replace(/[^\d]/g, '').replace(/^0+/, '') || '0'
  return (negative && digits !== '0' ? '-' : '') + digits
}

let bundlePath: string
let outDir: string

test.beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'p117-real-browser-'))
  await build({
    // Deliberately does NOT load this repo's own vite.config.ts (which wires the Cloudflare
    // headers plugin, PWA plugin, etc. and requires VITE_SUPABASE_URL at build time) -- this is a
    // throwaway bundle of two dependency-free domain/UI modules, not the app itself.
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      lib: {
        entry: fileURLToPath(new URL('./fixtures/p117-real-browser-entry.ts', import.meta.url)),
        name: 'p117',
        formats: ['iife'],
        fileName: () => 'bundle.js',
      },
      minify: false,
    },
  })
  bundlePath = join(outDir, 'bundle.js')
})

test.afterAll(() => {
  rmSync(outDir, { recursive: true, force: true })
})

test.describe('money formatting on the real engine', () => {
  test('BigInt magnitudes beyond Number.MAX_SAFE_INTEGER format exactly', async ({ page }) => {
    await page.goto('about:blank')
    await page.addScriptTag({ path: bundlePath })

    const cases: bigint[] = [
      9007199254740993n, // P114's own regression case -- previously rendered one ore high
      9007199254740991n, // MAX_SAFE_INTEGER exactly
      9007199254740992n, // MAX_SAFE_INTEGER + 1
      123456789012345678901234567890n,
      -50n, // sign must survive a zero whole part (BigInt has no negative zero)
      0n,
    ]

    for (const minorUnits of cases) {
      const exact = digitsOnly(toDecimalString(fromMinorUnits(minorUnits, 'NOK')))
      const actual = await page.evaluate(
        (m) => window.__p117.formatNokMinor(BigInt(m)),
        minorUnits.toString(),
      )
      expect(digitsOnly(actual), `formatNokMinor(${minorUnits}n) on real engine`).toBe(exact)
    }

    // P114's literal regression rendered ",94" instead of ",93" -- pin the exact last digit too.
    const regression = await page.evaluate(() => window.__p117.formatNokMinor(9007199254740993n))
    expect(regression.endsWith(',93')).toBe(true)
    expect(regression).not.toContain(',94')
  })

  test('formatCurrencyMinor across all supported currencies, extreme magnitude', async ({
    page,
  }) => {
    await page.goto('about:blank')
    await page.addScriptTag({ path: bundlePath })

    const currencies: CurrencyCode[] = ['NOK', 'EUR', 'USD', 'GBP', 'JPY']
    for (const currency of currencies) {
      const minorUnits = 9007199254740993n
      const exact = digitsOnly(toDecimalString(fromMinorUnits(minorUnits, currency)))
      const actual = await page.evaluate(
        ({ m, c }) => window.__p117.formatCurrencyMinor(BigInt(m), c),
        { m: minorUnits.toString(), c: currency },
      )
      expect(digitsOnly(actual), `formatCurrencyMinor(${minorUnits}n, ${currency})`).toBe(exact)
    }

    const [eur, usd, gbp, jpy, jpyOne] = await page.evaluate(() => [
      window.__p117.formatCurrencyMinor(9007199254740993n, 'EUR'),
      window.__p117.formatCurrencyMinor(9007199254740993n, 'USD'),
      window.__p117.formatCurrencyMinor(9007199254740993n, 'GBP'),
      window.__p117.formatCurrencyMinor(9007199254740993n, 'JPY'),
      window.__p117.formatCurrencyMinor(1n, 'JPY'),
    ])
    expect(eur).toContain('€')
    expect(usd.startsWith('$')).toBe(true)
    expect(gbp.startsWith('£')).toBe(true)
    expect(jpy).not.toContain('.') // JPY is a zero-exponent currency -- no fractional digits ever
    expect(jpy.endsWith('JPY')).toBe(true) // no symbol mapped for JPY -- falls back to "N JPY"
    expect(jpyOne).toBe('1 JPY')
  })

  test('round-trip: parseNokInput -> formatNokMinor loses no precision at extreme magnitude', async ({
    page,
  }) => {
    await page.goto('about:blank')
    await page.addScriptTag({ path: bundlePath })

    const formatted = await page.evaluate(() => {
      const parsed = window.__p117.parseNokInput('90071992547409,93')
      return window.__p117.formatNokMinor(parsed)
    })
    expect(digitsOnly(formatted)).toBe('9007199254740993')
    expect(formatted.endsWith(',93')).toBe(true)
  })
})

test.describe('local calendar-day default on the real engine, across real timezones', () => {
  // Each case: [IANA timezone, fixed UTC instant, expected local YYYY-MM-DD]. Chosen to force the
  // UTC-vs-local-calendar-day divergence the P114 bug depended on: an instant late in the UTC day
  // (positive-offset zones roll to tomorrow) and early in the UTC day (negative-offset zones stay
  // on yesterday), plus a DST-transition day and the widest real offsets (Kiritimati +14,
  // Honolulu -10).
  const cases: Array<[string, string, string]> = [
    ['Europe/Oslo', '2026-01-15T23:30:00.000Z', '2026-01-16'], // CET UTC+1, no DST in January
    ['Europe/Oslo', '2026-07-15T22:30:00.000Z', '2026-07-16'], // CEST UTC+2 in summer
    ['UTC', '2026-01-15T23:30:00.000Z', '2026-01-15'],
    ['America/Los_Angeles', '2026-01-16T05:30:00.000Z', '2026-01-15'], // UTC-8, stays on "yesterday"
    ['America/New_York', '2026-03-08T06:30:00.000Z', '2026-03-08'], // US DST spring-forward day
    ['Asia/Tokyo', '2026-01-15T15:30:00.000Z', '2026-01-16'], // UTC+9
    ['Pacific/Kiritimati', '2026-01-15T10:30:00.000Z', '2026-01-16'], // UTC+14, furthest ahead
    ['Pacific/Honolulu', '2026-01-16T09:30:00.000Z', '2026-01-15'], // UTC-10, no DST
    ['Asia/Kathmandu', '2026-01-15T18:30:00.000Z', '2026-01-16'], // UTC+5:45, quarter-hour offset
    ['Europe/Oslo', '2028-02-29T23:30:00.000Z', '2028-03-01'], // leap-day boundary
  ]

  for (const [timezoneId, fixedIso, expectedLocalDate] of cases) {
    test(`${timezoneId} @ ${fixedIso} -> ${expectedLocalDate}`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({
        ...testInfo.project.use,
        timezoneId,
      })
      const page = await context.newPage()
      await page.clock.install({ time: new Date(fixedIso) })
      await page.goto('about:blank')
      await page.addScriptTag({ path: bundlePath })

      const actual = await page.evaluate(() => window.__p117.localTodayIso())
      expect(actual, `localTodayIso() in ${timezoneId} at ${fixedIso}`).toBe(expectedLocalDate)

      await context.close()
    })
  }
})
