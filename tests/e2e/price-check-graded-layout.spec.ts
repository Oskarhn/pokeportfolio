import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AxeBuilder from '@axe-core/playwright'
import react from '@vitejs/plugin-react'
import { createServer, type ViteDevServer } from 'vite'
import { test, expect, type Page } from '@playwright/test'
import { gradedSection, parseGradedObservations } from '../../src/domain/price-check/graded'
import { parseFxRate } from '../../src/domain/price-check/fx'
import { resolveVariant } from '../../src/domain/price-check/identity'

/**
 * P153: real-browser layout and accessibility proof for the parts of the result page the running
 * app can show only when a graded price SOURCE exists — which none does yet (docs/API_SOURCES.md).
 * The production page renders the honest "not available" state; the graded TABLE cannot be reached
 * through the app today, so this renders the real `ResultView` component (SSR, with synthetic graded
 * fixtures, every row labelled synthetic) into a page that carries the app's own built stylesheet,
 * and inspects it in real Chromium/WebKit: scroll behaviour at phone widths, keyboard reachability of
 * the scroll regions, focus indication, and an axe sweep in light and dark themes.
 *
 * This proves the presentation of graded data. It does NOT prove that graded prices are available —
 * they are not.
 */

// ResultView reaches the Supabase client through CardImage, which reads `import.meta.env` — so it is
// loaded through Vite (the same transform the app build uses) rather than through Node directly.
// A placeholder URL is enough: nothing here ever makes a request.
// One Vite server for the whole file: a serial file runs in a single worker.
test.describe.configure({ mode: 'serial' })
let vite: ViteDevServer
let ResultView: (props: never) => unknown

test.beforeAll(async () => {
  process.env.VITE_SUPABASE_URL ??= 'http://127.0.0.1:54321'
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'e2e-placeholder-not-a-key'
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    plugins: [react()],
    // A private cache dir and no websocket: a parallel run must not collide on `node_modules/.vite`
    // or the HMR port.
    cacheDir: join(tmpdir(), `p153-vite-${String(process.pid)}`),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const loaded = await vite.ssrLoadModule('/src/features/price-check/ResultView.tsx')
  ResultView = loaded.ResultView as typeof ResultView
})

test.afterAll(async () => {
  await vite.close()
})

const distAssets = fileURLToPath(new URL('../../dist/assets/', import.meta.url))
const appCss = readdirSync(distAssets)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(`${distAssets}${name}`, 'utf-8'))
  .join('\n')

const row = (o: Record<string, unknown>) => ({
  kind: 'sold',
  currency: 'USD',
  valueMinor: '10000',
  observedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  ...o,
})

const graded = gradedSection({
  sources: [{ id: 'fixture', label: 'Synthetic fixture', state: 'ok' }],
  ...parseGradedObservations(
    [
      row({ company: 'PSA', grade: '10', valueMinor: '1234500' }),
      row({ company: 'PSA', grade: '9', valueMinor: '345600', kind: 'listing' }),
      row({ company: 'PSA', grade: '8', valueMinor: '98700', observedAt: '2026-01-01T00:00:00Z' }),
      row({ company: 'BGS', grade: '10', qualifier: 'Pristine', valueMinor: '5000000' }),
      row({ company: 'BGS', grade: '9.5', valueMinor: '765400' }),
      row({ company: 'CGC', grade: '10', valueMinor: '400000', currency: 'JPY' }),
    ],
    {
      source: { id: 'fixture', label: 'Synthetic fixture' },
      fetchedAt: new Date().toISOString(),
      synthetic: true,
    },
  ),
})

const VARIANT = {
  variantId: 'v1',
  finish: 'holo' as const,
  stamp: '',
  subtype: '',
  size: 'standard' as const,
  isActive: true,
}

function pageHtml(theme: 'light' | 'dark'): string {
  const variants = [VARIANT]
  const body = renderToStaticMarkup(
    createElement(ResultView as never, {
      card: {
        cardId: 'c1',
        name: 'Pikachu with Grey Felt Hat and an Extremely Long Promotional Card Name',
        setId: 's',
        setName: 'Scarlet & Violet Black Star Promos',
        collectorNumber: 'SVP 085',
        language: 'en',
        imageBaseUrl: null,
        rarity: 'Promo',
        illustrator: 'Some Very Long Illustrator Name',
      },
      variants,
      resolution: resolveVariant(variants, undefined),
      raw: {
        state: 'ready',
        origin: 'network',
        response: {
          fetchedAt: new Date().toISOString(),
          providerErrorCount: 0,
          rows: [
            {
              cardVariantId: 'v1',
              observations: [
                {
                  provider: 'tcgdex_cardmarket',
                  priceKind: 'cm_trend',
                  sourceCurrency: 'EUR',
                  valueMinor: '9007199254740993',
                  providerUpdatedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
                },
              ],
            },
          ],
        },
      },
      graded,
      fxByCurrency: {
        EUR: parseFxRate(11.54, new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10)),
        USD: parseFxRate(10.5, new Date().toISOString().slice(0, 10)),
      },
      nowMs: Date.now(),
      onSelectVariant: () => undefined,
      onRetry: () => undefined,
      slots: {
        addToCollection: createElement('a', { href: '#' }, 'Add to collection…'),
        searchAgain: createElement('a', { href: '#' }, '← Search again'),
        scanAgain: createElement('a', { href: '#' }, 'Scan a card'),
        setLink: createElement('a', { href: '#' }, 'Scarlet & Violet Black Star Promos'),
      },
    }),
  )
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Price check layout</title>
<style>${appCss}</style></head><body><main class="flex flex-1 flex-col px-4 py-6">${body}</main></body></html>`
}

async function load(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme })
  await page.setContent(pageHtml(theme))
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const width of [360, 390, 430, 768, 1280]) {
  test.describe(`${String(width)}px`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('the page never scrolls sideways; only the graded tables do, and they are focusable', async ({
      page,
    }) => {
      await load(page, 'dark')
      expect(await overflow(page)).toBeLessThanOrEqual(0)

      const regions = page.getByRole('region', { name: /graded prices$/ })
      await expect(regions).toHaveCount(3)
      const scrolls = await regions.evaluateAll((els) =>
        els.map((el) => ({
          scrollable: el.scrollWidth > el.clientWidth,
          tabIndex: (el as HTMLElement).tabIndex,
          overflowX: getComputedStyle(el).overflowX,
        })),
      )
      for (const region of scrolls) {
        expect(region.tabIndex).toBe(0)
        expect(region.overflowX).toBe('auto')
      }
      // On a phone the 5-column table is wider than the viewport and scrolls inside its region.
      if (width <= 430) expect(scrolls.some((r) => r.scrollable)).toBe(true)

      // Keyboard: Tab can reach each region, and focus is visibly indicated.
      const first = regions.first()
      await first.focus()
      await expect(first).toBeFocused()
      const outline = await first.evaluate((el) => getComputedStyle(el).outlineStyle)
      expect(outline).not.toBe('none')
    })

    test('a long name, an oversized amount and a very old exchange rate stay contained', async ({
      page,
    }) => {
      await load(page, 'light')
      expect(await overflow(page)).toBeLessThanOrEqual(0)
      await expect(page.getByTestId('observation')).toContainText('€90,071,992,547,409.93')
      await expect(page.getByTestId('fx-stale')).toContainText('12 days old')
      const heading = page.getByRole('heading', { level: 1 })
      const box = await heading.boundingBox()
      expect(box && box.x + box.width).toBeLessThanOrEqual(width + 0.5)
    })
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`axe: no WCAG 2.2 AA violations in the ${theme} theme (raw + graded, stale, synthetic)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 })
    await load(page, theme)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })
}

test('graded rows: PSA 10, BGS 10 Pristine and CGC 10 are separate, JPY has no decimals', async ({
  page,
}) => {
  await load(page, 'dark')
  const rows = page.getByTestId('graded-row')
  await expect(rows).toHaveCount(6)
  await expect(rows.filter({ hasText: 'PSA 10' })).toContainText('$12,345.00')
  await expect(rows.filter({ hasText: 'BGS 10 Pristine' })).toContainText('$50,000.00')
  await expect(rows.filter({ hasText: 'CGC 10' })).toContainText('400,000 JPY')
  await expect(page.getByTestId('synthetic-badge')).toHaveCount(6)
  // A 2026-01-01 observation is far older than 30 days.
  await expect(rows.filter({ hasText: 'PSA 8' }).getByTestId('freshness')).toHaveAttribute(
    'data-freshness',
    'outdated',
  )
})
