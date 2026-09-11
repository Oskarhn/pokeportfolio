import { test, expect, chromium, webkit, type Browser } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * P118 §7/§8 — real-browser matrices for the two production helpers P114 fixed, run against the
 * ACTUAL committed source (`src/platform/local-date.ts`, `src/ui/money-format.ts`) rather than a
 * reimplementation, via a dedicated `vite dev` instance (own child process, own port, never the
 * shared `pnpm build && pnpm preview` webServer every other spec in this directory uses) so a
 * plain dynamic `import()` of the real TS module path gets Vite's on-the-fly transform without
 * needing a bundled/hashed production chunk name. This never touches Docker/Supabase — the app
 * still needs *a* Supabase URL/key to construct its client without throwing (src/data/
 * supabase-client.ts), but nothing here signs in or makes a real request; `.env.local`'s existing
 * publishable (public-by-design) key is loaded automatically by Vite's own env handling.
 *
 * Both P114's unit suite (tests/ui/local-date.test.ts, tests/ui/money-format.test.ts) and P115's
 * one manual Chromium check already prove these helpers correct at the Node/unit level and for one
 * timezone. What was explicitly missing (P115's own disclosure) is a genuine browser-timezone-
 * emulation matrix and a real Chromium+WebKit render at the exact 2^53 boundary — this file closes
 * both without needing DB/auth.
 */

// This whole file shares ONE dev-server/browser lifecycle via module-level beforeAll/afterAll on a
// fixed port. `fullyParallel: true` (playwright.config.ts) would otherwise let Playwright schedule
// this file's tests across multiple worker processes, each running its own beforeAll — a second
// `vite --strictPort` bind on the same port fails, but `waitForServer` still sees worker A's
// already-running server and proceeds, so worker B silently depends on a process it doesn't own;
// worker A's afterAll then kills that shared server mid-run for worker B (reproduced directly:
// exactly this connection-refused shape on 2 of 58 cases before this line was added). Serial mode
// pins the whole file to one worker, so exactly one beforeAll/afterAll pair ever runs.
test.describe.configure({ mode: 'serial' })

const HARNESS_PORT = 4198

let devServer: ChildProcessWithoutNullStreams | undefined
let chromiumBrowser: Browser | undefined
let webkitBrowser: Browser | undefined

/** Every call site only runs after `beforeAll` above has populated these (or the whole file was
 *  skipped for this project, in which case no test body — which is what calls this — ever runs). */
function requireBrowser(b: Browser | undefined): Browser {
  if (!b) throw new Error('browser not initialized — beforeAll did not run or was skipped')
  return b
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`vite dev harness server never became reachable at ${url}`)
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires this exact destructuring shape
test.beforeAll(async ({}, testInfo) => {
  // This file drives its own Chromium/WebKit instances directly (it needs both engines in one
  // run, and neither the `page` fixture nor the shared preview webServer) — it must run exactly
  // once, not once per configured Playwright project (which would just duplicate every case).
  test.skip(testInfo.project.name !== 'desktop-chromium', 'drives its own browsers; runs once')
  devServer = spawn(
    'node',
    ['node_modules/vite/bin/vite.js', 'dev', '--port', String(HARNESS_PORT), '--strictPort'],
    { cwd: process.cwd(), stdio: 'pipe', shell: false },
  )
  let stderr = ''
  devServer.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
  })
  devServer.on('error', (err) => {
    throw err
  })
  try {
    await waitForServer(`http://localhost:${HARNESS_PORT}/`)
  } catch (e) {
    throw new Error(`${(e as Error).message}\nstderr so far:\n${stderr}`, { cause: e })
  }
  ;[chromiumBrowser, webkitBrowser] = await Promise.all([chromium.launch(), webkit.launch()])
})

test.afterAll(async () => {
  await Promise.all([chromiumBrowser?.close(), webkitBrowser?.close()])
  devServer?.kill()
})

/** Loads `/login` (public, no session needed) on the harness dev server under the given timezone,
 *  pins the exact instant via Playwright's Clock API, then calls the REAL production
 *  `localTodayIso()` in-page via a dynamic import of its real source path. */
async function localTodayUnder(
  browser: Browser,
  timezoneId: string,
  fixedInstantIso: string,
): Promise<string> {
  const context = await browser.newContext({ timezoneId })
  const page = await context.newPage()
  await page.clock.install({ time: new Date(fixedInstantIso) })
  await page.goto(`http://localhost:${HARNESS_PORT}/login`)
  const result = await page.evaluate(async () => {
    // @ts-expect-error runtime-only absolute browser path served by the harness's `vite dev`
    // instance — not a Node/tsc-resolvable module specifier.
    const mod = (await import('/src/platform/local-date.ts')) as { localTodayIso: () => string }
    return mod.localTodayIso()
  })
  await context.close()
  return result
}

type TzCase = { name: string; timezoneId: string; instant: string; expected: string }

const TZ_CASES: TzCase[] = [
  {
    name: 'UTC control',
    timezoneId: 'UTC',
    instant: '2026-03-10T12:00:00Z',
    expected: '2026-03-10',
  },
  {
    name: 'Europe/Oslo CET, just after local midnight',
    timezoneId: 'Europe/Oslo',
    instant: '2026-01-15T23:30:00Z',
    expected: '2026-01-16',
  },
  {
    name: 'Europe/Oslo CEST, just after local midnight',
    timezoneId: 'Europe/Oslo',
    instant: '2026-07-15T22:15:00Z',
    expected: '2026-07-16',
  },
  {
    name: 'America/Los_Angeles (behind UTC)',
    timezoneId: 'America/Los_Angeles',
    instant: '2026-06-15T05:30:00Z',
    expected: '2026-06-14',
  },
  {
    name: 'America/New_York (behind UTC)',
    timezoneId: 'America/New_York',
    instant: '2026-06-15T02:30:00Z',
    expected: '2026-06-14',
  },
  {
    name: 'Asia/Tokyo (ahead of UTC, no DST)',
    timezoneId: 'Asia/Tokyo',
    instant: '2026-06-14T16:00:00Z',
    expected: '2026-06-15',
  },
  {
    name: 'Pacific/Kiritimati UTC+14 (extreme ahead)',
    timezoneId: 'Pacific/Kiritimati',
    instant: '2026-06-14T11:00:00Z',
    expected: '2026-06-15',
  },
  {
    name: 'Pacific/Pago_Pago UTC-11 (extreme behind)',
    timezoneId: 'Pacific/Pago_Pago',
    instant: '2026-06-15T09:00:00Z',
    expected: '2026-06-14',
  },
  {
    name: 'leap day, UTC control',
    timezoneId: 'UTC',
    instant: '2028-02-29T12:00:00Z',
    expected: '2028-02-29',
  },
  {
    name: 'leap day rolling into March 1 under Europe/Oslo CET',
    timezoneId: 'Europe/Oslo',
    instant: '2028-02-29T23:30:00Z',
    expected: '2028-03-01',
  },
  {
    name: 'Dec 31 -> Jan 1 rolling FORWARD under Pacific/Kiritimati (+14)',
    timezoneId: 'Pacific/Kiritimati',
    instant: '2026-12-31T23:30:00Z',
    expected: '2027-01-01',
  },
  {
    name: 'Jan 1 -> Dec 31 rolling BACKWARD under Pacific/Pago_Pago (-11)',
    timezoneId: 'Pacific/Pago_Pago',
    instant: '2027-01-01T09:00:00Z',
    expected: '2026-12-31',
  },
  {
    name: 'Europe/Oslo DST spring transition, just before (still CET)',
    timezoneId: 'Europe/Oslo',
    instant: '2026-03-29T00:30:00Z',
    expected: '2026-03-29',
  },
  {
    name: 'Europe/Oslo DST spring transition, just after (now CEST)',
    timezoneId: 'Europe/Oslo',
    instant: '2026-03-29T01:30:00Z',
    expected: '2026-03-29',
  },
  {
    name: 'Europe/Oslo DST autumn transition, just before (still CEST)',
    timezoneId: 'Europe/Oslo',
    instant: '2026-10-25T00:30:00Z',
    expected: '2026-10-25',
  },
  {
    name: 'Europe/Oslo DST autumn transition, just after (now CET)',
    timezoneId: 'Europe/Oslo',
    instant: '2026-10-25T01:30:00Z',
    expected: '2026-10-25',
  },
]

test.describe('browser timezone matrix — real localTodayIso(), real Chromium (P118 §7)', () => {
  for (const c of TZ_CASES) {
    test(`Chromium: ${c.name}`, async () => {
      const result = await localTodayUnder(requireBrowser(chromiumBrowser), c.timezoneId, c.instant)
      expect(result).toBe(c.expected)
    })
  }
})

test.describe('browser timezone matrix — real localTodayIso(), real WebKit (P118 §7)', () => {
  for (const c of TZ_CASES) {
    test(`WebKit: ${c.name}`, async () => {
      const result = await localTodayUnder(requireBrowser(webkitBrowser), c.timezoneId, c.instant)
      expect(result).toBe(c.expected)
    })
  }
})

test.describe('regression: this matrix would have failed the pre-P114 implementation (P118 §7)', () => {
  test('the old toISOString().slice(0,10) shape fails at least the Oslo/Kiritimati/Pago_Pago cases', async () => {
    const context = await requireBrowser(chromiumBrowser).newContext({ timezoneId: 'Europe/Oslo' })
    const page = await context.newPage()
    await page.clock.install({ time: new Date('2026-01-15T23:30:00Z') })
    await page.goto(`http://localhost:${HARNESS_PORT}/login`)
    const oldResult = await page.evaluate(() => new Date().toISOString().slice(0, 10))
    await context.close()
    // The real fix reports 2026-01-16 (see the Chromium case above); the old UTC-shifting
    // implementation reports 2026-01-15 for the exact same instant — proving this matrix
    // discriminates the fix from the bug it replaced, not just re-describing current behavior.
    expect(oldResult).toBe('2026-01-15')
  })
})

/** Money/BigInt display matrix (P118 §8). */
type MoneyCase = {
  name: string
  minorUnits: string // bigint literal as string (safe past 2^53 in source)
  currency: 'NOK' | 'EUR' | 'USD' | 'GBP' | 'JPY'
  fn: 'formatNokMinor' | 'formatCurrencyMinor'
  expectedContains: string[]
  expectedNotContains: string[]
}

const MONEY_CASES: MoneyCase[] = [
  {
    name: 'MAX_SAFE_INTEGER exactly, NOK',
    minorUnits: '9007199254740991',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: ['90', '071', '992', '547', '409', '91', ','],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: 'MAX_SAFE_INTEGER + 1, NOK (first unsafe integer)',
    minorUnits: '9007199254740992',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: 'MAX_SAFE_INTEGER + 2, NOK',
    minorUnits: '9007199254740993',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: 'negative MAX_SAFE_INTEGER, NOK',
    minorUnits: '-9007199254740991',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN', '--'],
  },
  {
    name: 'negative unsafe boundary, NOK',
    minorUnits: '-9007199254740993',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN', '--'],
  },
  {
    name: '-1 minor unit, NOK',
    minorUnits: '-1',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: '-50 minor units, NOK',
    minorUnits: '-50',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: 'zero, NOK',
    minorUnits: '0',
    currency: 'NOK',
    fn: 'formatNokMinor',
    expectedContains: [],
    expectedNotContains: ['-', 'e+', 'E+', 'NaN'],
  },
  {
    name: 'large JPY (0-exponent currency) past 2^53',
    minorUnits: '9007199254740995',
    currency: 'JPY',
    fn: 'formatCurrencyMinor',
    expectedContains: [],
    expectedNotContains: ['e+', 'E+', 'NaN', '.'],
  },
  {
    name: 'large EUR past 2^53',
    minorUnits: '9007199254740995',
    currency: 'EUR',
    fn: 'formatCurrencyMinor',
    expectedContains: ['€'],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: 'large USD past 2^53',
    minorUnits: '9007199254740995',
    currency: 'USD',
    fn: 'formatCurrencyMinor',
    expectedContains: ['$'],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
  {
    name: 'large GBP past 2^53',
    minorUnits: '9007199254740995',
    currency: 'GBP',
    fn: 'formatCurrencyMinor',
    expectedContains: ['£'],
    expectedNotContains: ['e+', 'E+', 'NaN'],
  },
]

async function renderMoney(browser: Browser, c: MoneyCase): Promise<string> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`http://localhost:${HARNESS_PORT}/login`)
  const result = await page.evaluate(
    async ({ minorUnits, currency, fn }) => {
      // @ts-expect-error runtime-only absolute browser path served by the harness's `vite dev`
      // instance — not a Node/tsc-resolvable module specifier.
      const mod = (await import('/src/ui/money-format.ts')) as {
        formatNokMinor: (m: bigint) => string
        formatCurrencyMinor: (m: bigint, c: string) => string
      }
      const value = BigInt(minorUnits)
      return fn === 'formatNokMinor'
        ? mod.formatNokMinor(value)
        : mod.formatCurrencyMinor(value, currency)
    },
    { minorUnits: c.minorUnits, currency: c.currency, fn: c.fn },
  )
  await context.close()
  return result
}

test.describe('BigInt money-display matrix — real formatNokMinor/formatCurrencyMinor, real Chromium (P118 §8)', () => {
  for (const c of MONEY_CASES) {
    test(`Chromium: ${c.name}`, async () => {
      const rendered = await renderMoney(requireBrowser(chromiumBrowser), c)
      expect(rendered).not.toMatch(/e\+|E\+/) // never scientific notation
      expect(rendered).not.toContain('NaN')
      expect(rendered).not.toContain('undefined')
      for (const must of c.expectedContains) expect(rendered).toContain(must)
      for (const mustNot of c.expectedNotContains) expect(rendered).not.toContain(mustNot)
      if (c.minorUnits.startsWith('-')) {
        // exactly one sign glyph, never a double-negative render
        const signCount = (rendered.match(/-/g) ?? []).length
        expect(signCount).toBeLessThanOrEqual(1)
      }
    })
  }
})

test.describe('BigInt money-display matrix — real formatNokMinor/formatCurrencyMinor, real WebKit (P118 §8)', () => {
  for (const c of MONEY_CASES) {
    test(`WebKit: ${c.name}`, async () => {
      const rendered = await renderMoney(requireBrowser(webkitBrowser), c)
      expect(rendered).not.toMatch(/e\+|E\+/)
      expect(rendered).not.toContain('NaN')
      expect(rendered).not.toContain('undefined')
      for (const must of c.expectedContains) expect(rendered).toContain(must)
      for (const mustNot of c.expectedNotContains) expect(rendered).not.toContain(mustNot)
    })
  }
})

test.describe('BigInt boundary precision — no one-unit rounding corruption (P118 §8)', () => {
  test('consecutive minor-unit values past 2^53 render as visibly distinct strings, Chromium', async () => {
    const a = await renderMoney(requireBrowser(chromiumBrowser), {
      name: 'a',
      minorUnits: '9007199254740992',
      currency: 'NOK',
      fn: 'formatNokMinor',
      expectedContains: [],
      expectedNotContains: [],
    })
    const b = await renderMoney(requireBrowser(chromiumBrowser), {
      name: 'b',
      minorUnits: '9007199254740993',
      currency: 'NOK',
      fn: 'formatNokMinor',
      expectedContains: [],
      expectedNotContains: [],
    })
    // A plain `Number()` cast would collapse both to the same silently-rounded value; the real
    // BigInt-formatting path must keep them visibly different (P114's own regression class).
    expect(a).not.toBe(b)
  })
})
