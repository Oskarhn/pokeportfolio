import { test, expect, type Page } from '@playwright/test'
import { installFakeSession } from './support/fake-session'
import {
  CARDS,
  cardmarket,
  daysAgoIso,
  installBackend,
  mutatingRequests,
  tcgplayer,
  type Backend,
} from './support/price-check-backend'

/**
 * P153 Price Check, driven in a real browser (desktop Chromium and the iPhone 14 profile) against
 * the production build. The network boundary is controlled (tests/e2e/support/price-check-backend.ts
 * — synthetic data only); the app code is untouched. Every test ends by asserting that the page
 * never made a request that could change state.
 */

const CHAR_EVO = CARDS[1]!
const CHAR_SV3 = CARDS[2]!
const PIKACHU = CARDS[3]!
const LONG_NAME = CARDS[4]!

// The app registers a service worker. With it active, WebKit sometimes lets a request skip
// `page.route` and hit the (absent) placeholder backend, which made these tests flaky for reasons
// unrelated to Price Check. Nothing here depends on the worker, so it is blocked.
test.use({ serviceWorkers: 'block' })

let backend: Backend

test.beforeEach(async ({ page }) => {
  await installFakeSession(page)
  backend = await installBackend(page)
})

test.afterEach(() => {
  expect(mutatingRequests(backend.requests), 'Price Check must never mutate backend state').toEqual(
    [],
  )
})

async function search(page: Page, text: string) {
  await page.goto('/price-check')
  await page.getByLabel('Card name, set or number').fill(text)
}

test('the entry page is a lookup tool: search, scan, and an explicit "nothing is added" promise', async ({
  page,
}) => {
  await page.goto('/price-check')
  await expect(page.getByRole('heading', { name: 'Price check', level: 1 })).toBeVisible()
  await expect(page.getByText('Nothing you do here is added to your collection.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Scan a card/ })).toBeVisible()
  await expect(page.getByText('Type a card name to begin.')).toBeVisible()
})

test('manual search → single-variant card → raw prices with source, dates, currency and NOK reference', async ({
  page,
}) => {
  backend.state.observations[CHAR_EVO.variants[0]!.id] = [
    cardmarket('1234', 1),
    tcgplayer('1500', 2),
  ]
  await search(page, 'Charizard')
  await page.getByRole('link', { name: /Charizard.*Evolutions/ }).click()

  await expect(page).toHaveURL(new RegExp(`/price-check/${CHAR_EVO.id}`))
  await expect(page.getByRole('heading', { name: 'Charizard', level: 1 })).toBeVisible()
  await expect(page.getByTestId('only-variant')).toBeVisible()

  const observations = page.getByTestId('observation')
  await expect(observations).toHaveCount(2)
  const cm = observations.filter({ hasText: 'Cardmarket via TCGdex' })
  await expect(cm).toContainText('€12.34')
  await expect(cm).toContainText('Trend price')
  await expect(cm).toContainText('Index price')
  await expect(cm).toContainText('Condition not specified by source')
  await expect(cm.getByTestId('freshness')).toHaveAttribute('data-freshness', 'fresh')
  await expect(cm.getByTestId('nok-reference')).toContainText('≈ kr 142,40 at 11.54 NOK per EUR')
  const tp = observations.filter({ hasText: 'TCGplayer via TCGdex' })
  await expect(tp).toContainText('$15.00')
  await expect(tp.getByTestId('nok-reference')).toContainText('at 10.5 NOK per USD')

  // The graded section is honest about having no source.
  await expect(
    page.getByTestId('unavailable').filter({ hasText: 'graded prices are not available' }),
  ).toBeVisible()
  await expect(page.getByTestId('graded-row')).toHaveCount(0)
  await expect(page.getByText(/never estimated from raw prices/)).toBeVisible()
})

test('ambiguous name: every result is disambiguated by set, number and language', async ({
  page,
}) => {
  await search(page, 'Charizard')
  const rows = page.getByTestId('price-check-result')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Base Set · #4')
  await expect(rows.nth(1)).toContainText('Evolutions · #11')
  await expect(rows.nth(2)).toContainText('Obsidian Flames · #125')
  await expect(page.getByTestId('shares-name')).toHaveCount(3)
  await expect(page.getByTestId('shares-name').first()).toContainText('check the set and number')
  // A unique name carries no such warning.
  await page.getByLabel('Card name, set or number').fill('Pikachu')
  await expect(page.getByTestId('shares-name')).toHaveCount(0)
})

test('a multi-variant card never picks a variant: no price until the exact one is chosen', async ({
  page,
}) => {
  backend.state.observations[CHAR_SV3.variants[0]!.id] = [cardmarket('50', 1)]
  backend.state.observations[CHAR_SV3.variants[1]!.id] = [cardmarket('99900', 1)]
  await page.goto(`/price-check/${CHAR_SV3.id}`)

  await expect(page.getByTestId('choose-variant')).toContainText('nothing is picked for you')
  const options = page.getByTestId('variant-option')
  await expect(options).toHaveCount(2)
  for (const option of await options.all())
    await expect(option).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('observation')).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Add to collection/ })).toHaveCount(0)
  // Availability is shown per variant, but never a price.
  await expect(options.nth(0)).toContainText('1 price')
  await expect(page.locator('main')).not.toContainText('€999')

  await options.nth(1).click()
  await expect(page).toHaveURL(/variantId=/)
  await expect(options.nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('observation')).toHaveCount(1)
  await expect(page.getByTestId('observation')).toContainText('€999.00')
  await expect(page.locator('main')).not.toContainText('€0.50')

  // Switching variant switches the price — nothing from the old one lingers.
  await options.nth(0).click()
  await expect(page.getByTestId('observation')).toContainText('€0.50')
  await expect(page.locator('main')).not.toContainText('€999.00')
})

test('a variant id from another card is rejected, not silently replaced', async ({ page }) => {
  await page.goto(`/price-check/${CHAR_SV3.id}?variantId=${CHAR_EVO.variants[0]!.id}`)
  await expect(page.getByRole('alert')).toContainText('does not belong to this card')
  await expect(page.getByTestId('observation')).toHaveCount(0)
})

test('no price for the variant: "Not available", never a zero; graded stays unavailable too', async ({
  page,
}) => {
  await page.goto(`/price-check/${PIKACHU.id}`)
  const raw = page.getByTestId('unavailable').first()
  await expect(raw).toHaveAttribute('data-reason', 'no_variant_price')
  await expect(raw).toContainText('Not available')
  await expect(page.getByTestId('observation')).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('€0.00')
  await expect(page.locator('main')).not.toContainText('kr 0')
})

test('a provider-reported zero is shown as a zero observation (not as unavailable)', async ({
  page,
}) => {
  backend.state.observations[PIKACHU.variants[0]!.id] = [cardmarket('0', 1)]
  await page.goto(`/price-check/${PIKACHU.id}`)
  await expect(page.getByTestId('observation')).toContainText('€0.00')
  await expect(page.getByTestId('nok-reference')).toContainText('≈ kr 0,00')
})

for (const [mode, reason, text] of [
  ['http500', 'provider_error', 'lookup failure, not a zero price'],
  ['http429', 'rate_limited', 'rate limiting'],
  ['network', 'network', 'connection failed'],
  ['malformed', 'malformed_response', 'could not be trusted'],
  ['provider-error', 'provider_error', 'lookup failure, not a zero price'],
  ['http404', 'not_found', 'may not be deployed'],
] as const) {
  test(`provider failure (${mode}) is a named failure, never a price or a zero`, async ({
    page,
  }) => {
    backend.state.observations[PIKACHU.variants[0]!.id] = [cardmarket('500', 1)]
    backend.state.pricesMode = mode
    await page.goto(`/price-check/${PIKACHU.id}`)
    const notice = page.getByTestId('unavailable').first()
    await expect(notice).toHaveAttribute('data-reason', reason)
    await expect(notice).toContainText(text)
    await expect(page.getByTestId('observation')).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText('€5.00')
  })
}

test('retry after a failure fetches again and shows the real price; it is not cached as a failure', async ({
  page,
}) => {
  backend.state.observations[PIKACHU.variants[0]!.id] = [cardmarket('500', 1)]
  backend.state.pricesMode = 'http500'
  await page.goto(`/price-check/${PIKACHU.id}`)
  await expect(page.getByTestId('unavailable').first()).toHaveAttribute(
    'data-reason',
    'provider_error',
  )
  expect(backend.priceRequests()).toHaveLength(1)

  backend.state.pricesMode = 'ok'
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('observation')).toContainText('€5.00')
  expect(backend.priceRequests()).toHaveLength(2)
})

test('provider lookups are deduplicated: one price request per card visit, none per re-render', async ({
  page,
}) => {
  backend.state.observations[CHAR_SV3.variants[0]!.id] = [cardmarket('50', 1)]
  backend.state.observations[CHAR_SV3.variants[1]!.id] = [cardmarket('60', 1)]
  await page.goto(`/price-check/${CHAR_SV3.id}`)
  await page.getByTestId('variant-option').nth(0).click()
  await page.getByTestId('variant-option').nth(1).click()
  await page.getByTestId('variant-option').nth(0).click()
  await expect(page.getByTestId('observation')).toContainText('€0.50')
  expect(backend.priceRequests()).toHaveLength(1)
})

test('freshness: stale and outdated observations are labelled as such, unknown dates are unknown', async ({
  page,
}) => {
  backend.state.observations[CHAR_SV3.variants[0]!.id] = [
    cardmarket('1000', 10),
    tcgplayer('1000', 60),
  ]
  backend.state.observations[CHAR_SV3.variants[1]!.id] = [cardmarket('1000', null)]
  await page.goto(`/price-check/${CHAR_SV3.id}?variantId=${CHAR_SV3.variants[0]!.id}`)
  const cm = page.getByTestId('observation').filter({ hasText: 'Cardmarket' })
  const tp = page.getByTestId('observation').filter({ hasText: 'TCGplayer' })
  await expect(cm.getByTestId('freshness')).toHaveAttribute('data-freshness', 'stale')
  await expect(cm.getByTestId('freshness')).toContainText('10 days old')
  await expect(tp.getByTestId('freshness')).toHaveAttribute('data-freshness', 'outdated')

  await page.goto(`/price-check/${CHAR_SV3.id}?variantId=${CHAR_SV3.variants[1]!.id}`)
  const unknown = page.getByTestId('observation')
  await expect(unknown.getByTestId('freshness')).toHaveAttribute('data-freshness', 'unknown')
  await expect(unknown).toContainText('Source gave no observation date')
})

test('FX: a stale rate is flagged; a missing rate leaves the source currency alone', async ({
  page,
}) => {
  backend.state.observations[PIKACHU.variants[0]!.id] = [
    cardmarket('1234', 1),
    tcgplayer('1000', 1),
  ]
  backend.state.fx = {
    EUR: { rate: 11.54, rateDate: daysAgoIso(12).slice(0, 10) },
    USD: null,
  }
  await page.goto(`/price-check/${PIKACHU.id}`)
  const cm = page.getByTestId('observation').filter({ hasText: 'Cardmarket' })
  await expect(cm.getByTestId('nok-reference')).toContainText('≈ kr 142,40')
  await expect(cm.getByTestId('fx-stale')).toContainText('12 days old')
  const tp = page.getByTestId('observation').filter({ hasText: 'TCGplayer' })
  await expect(tp).toContainText('$10.00')
  await expect(tp.getByTestId('nok-unavailable')).toContainText(
    'no USD/NOK exchange rate is cached',
  )
  await expect(tp).not.toContainText('≈ kr')
})

test('FX: a malformed cached rate is refused, not used', async ({ page }) => {
  backend.state.observations[PIKACHU.variants[0]!.id] = [cardmarket('1234', 1)]
  backend.state.fx = { EUR: { rate: 'abc', rateDate: daysAgoIso(1).slice(0, 10) }, USD: null }
  await page.goto(`/price-check/${PIKACHU.id}`)
  await expect(page.getByTestId('observation')).toContainText('€12.34')
  await expect(page.getByTestId('nok-unavailable')).toContainText(
    'the cached exchange rate is invalid',
  )
})

test('search: a slow response for an old query can never overwrite the results of the newer one', async ({
  page,
}) => {
  backend.state.searchDelayMs['Pika'] = 1500
  await page.goto('/price-check')
  const box = page.getByLabel('Card name, set or number')
  await box.fill('Pika')
  // Wait until the (slow) request for "Pika" is actually in flight, then type over it.
  await expect.poll(() => backend.searchQueries.includes('Pika')).toBe(true)
  await box.fill('Charizard')
  await expect(page.getByTestId('price-check-result')).toHaveCount(3)
  // Let the stale "Pika" response land, then confirm it changed nothing.
  await page.waitForTimeout(1800)
  await expect(page.getByTestId('price-check-result')).toHaveCount(3)
  await expect(page.getByTestId('price-check-result').first()).toContainText('Charizard')
  await expect(page.getByTestId('price-check-result').filter({ hasText: 'Pikachu' })).toHaveCount(0)
})

test('search: empty result, and a backend failure with retry', async ({ page }) => {
  await search(page, 'zzzzzz')
  await expect(page.getByTestId('search-empty')).toContainText('No cards match “zzzzzz”')

  backend.state.searchMode = 'http500'
  await page.getByLabel('Card name, set or number').fill('Charizard')
  await expect(page.getByRole('alert')).toContainText('Search failed')

  backend.state.searchMode = 'ok'
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('price-check-result')).toHaveCount(3)
})

test('search: query and language survive Back from a result', async ({ page }) => {
  backend.state.observations[CHAR_EVO.variants[0]!.id] = [cardmarket('100', 1)]
  await search(page, 'Charizard')
  await expect(page.getByTestId('price-check-result')).toHaveCount(3)
  await page.getByRole('link', { name: /Charizard.*Evolutions/ }).click()
  await expect(page.getByTestId('observation')).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('Card name, set or number')).toHaveValue('Charizard')
  await expect(page.getByTestId('price-check-result')).toHaveCount(3)
})

test('signed out: Price Check is session-guarded like every private page', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/price-check')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.goto(`/price-check/${PIKACHU.id}`)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await context.close()
})

test('explicit "Add to collection…" only navigates to the existing add page with the exact variant', async ({
  page,
}) => {
  backend.state.observations[PIKACHU.variants[0]!.id] = [cardmarket('500', 1)]
  await page.goto(`/price-check/${PIKACHU.id}`)
  const before = backend.requests.length
  const add = page.getByRole('link', { name: /Add to collection/ })
  await expect(add).toHaveAttribute(
    'href',
    new RegExp(`/add\\?variantId=${PIKACHU.variants[0]!.id}`),
  )
  await add.click()
  await expect(page).toHaveURL(/\/add\?variantId=/)
  // Navigating there wrote nothing (the Add page itself only reads until the person submits).
  expect(mutatingRequests(backend.requests.slice(before))).toEqual([])
})

test('the entry page carries no scanner download; the scanner loads only on the scan page', async ({
  page,
}) => {
  const scripts: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'script' || request.url().includes('scanner-assets')) {
      scripts.push(request.url())
    }
  })
  await search(page, 'Pikachu')
  await expect(page.getByTestId('price-check-result')).toHaveCount(2)
  const heavy = scripts.filter((u) =>
    /visual-worker|ocr|tesseract|scanner-assets|onnx|controller-/.test(u),
  )
  expect(heavy).toEqual([])
})

test('long names and large values do not break the layout or overflow the page', async ({
  page,
}) => {
  backend.state.observations[LONG_NAME.variants[0]!.id] = [cardmarket('9007199254740993', 1)]
  await page.goto(`/price-check/${LONG_NAME.id}`)
  await expect(page.getByTestId('observation')).toContainText('€90,071,992,547,409.93')
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('keyboard: the search field, results and variant choices are reachable and show focus', async ({
  page,
}) => {
  backend.state.observations[CHAR_SV3.variants[0]!.id] = [cardmarket('50', 1)]
  await search(page, 'Charizard')
  await expect(page.getByTestId('price-check-result')).toHaveCount(3)
  const first = page.getByTestId('price-check-result').first()
  await first.focus()
  await expect(first).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Charizard', level: 1 })).toBeVisible()
})

// One test (and so one fresh page) per width: re-navigating a single WebKit page repeatedly is a
// harness flake unrelated to the feature.
for (const width of [360, 390, 430]) {
  test.describe(`${String(width)}px wide`, () => {
    test.use({ viewport: { width, height: 800 } })

    test('no horizontal overflow and 44px touch targets on the price page', async ({ page }) => {
      backend.state.observations[CHAR_SV3.variants[0]!.id] = [
        cardmarket('50', 1),
        tcgplayer('60', 2),
      ]
      await page.goto(`/price-check/${CHAR_SV3.id}`)
      await expect(page.getByTestId('variant-option').first()).toBeVisible()
      await page.getByTestId('variant-option').first().click()
      await expect(page.getByTestId('observation').first()).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      for (const locator of [
        page.getByTestId('variant-option'),
        page.getByRole('link', { name: /Add to collection/ }),
        page.getByRole('link', { name: /Search again/ }),
        page.getByRole('link', { name: /Scan a card/ }),
      ]) {
        for (const element of await locator.all()) {
          const box = await element.boundingBox()
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5)
        }
      }
    })

    test('no horizontal overflow on the search page with long names', async ({ page }) => {
      await search(page, 'Pikachu')
      await expect(page.getByTestId('price-check-result')).toHaveCount(2)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
      for (const element of await page.getByTestId('price-check-result').all()) {
        const box = await element.boundingBox()
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5)
      }
    })
  })
}

test('screen reader semantics: named sections, polite loading status, alert for a failed lookup', async ({
  page,
}) => {
  backend.state.observations[PIKACHU.variants[0]!.id] = [cardmarket('500', 1)]
  backend.state.pricesDelayMs = 800
  await page.goto(`/price-check/${PIKACHU.id}`)
  const loading = page.getByRole('status').filter({ hasText: 'Loading prices' })
  await expect(loading).toBeVisible()
  await expect(loading).toHaveAttribute('aria-live', 'polite')
  await expect(page.getByRole('region', { name: 'Raw (ungraded) prices' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Graded prices' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Variant' })).toBeVisible()
  // "No price exists" is information, not an alert.
  await expect(page.getByRole('alert')).toHaveCount(0)

  backend.state.pricesDelayMs = 0
  backend.state.pricesMode = 'http500'
  await page.goto(`/price-check/${CHAR_EVO.id}`)
  await expect(page.getByRole('alert')).toContainText('lookup failure, not a zero price')
})
