import { expect, test, type Page, type Route } from '@playwright/test'
import { createServiceClient } from '../../db/setup'
import {
  AUTH_STORAGE_KEY,
  armBroadcastCounter,
  createPair,
  deletePair,
  openOtherTab,
  signInThroughForm,
  switchAndSettle,
  type Pair,
} from './support/two-tab'

/**
 * P149 (closes P148-M2) - a transient failure of the CREDENTIAL LOOKUP must not be reported as an
 * identity change, in the real browser, against the real local GoTrue / PostgREST / PostgreSQL.
 *
 * The lookup is made to fail the way it fails in production: the access token in the browser's
 * storage has expired, so `supabase.auth.getSession()` (which the identity lease's token provider
 * calls for every write) has to refresh it, and the refresh endpoint - only that endpoint, never
 * the financial RPC - is unreachable. auth-js then backs off for about 25 s and answers
 * `{ session: null, error }`. The tests below type a purchase of 2^53+1 minor units, so the
 * exact-money transport (P146/P147) is exercised on the same path.
 *
 * Witnesses: the service role reading `col::text` for what was stored, the browser's own request
 * log for what was sent, and the page for what the person sees. The idempotency key is read from
 * the form's own React state (the key is not rendered anywhere), so "the key did not change" is a
 * fact about the running form.
 *
 * Time: the failing lookup takes ~25 s of library backoff, and the library then caches the failure
 * for one minute (auth-js REFRESH_FAILURE_COOLDOWN_MS), so the retry test has to wait that out.
 */

test.use({ storageState: { cookies: [], origins: [] } })

const TYPED = '90071992547409,93' // 2^53 + 1 minor units of NOK
const EXACT_MINOR = '9007199254740993'
const EXACT_DISPLAY = /90\s071\s992\s547\s409,93/
const MARKER = 'p149-refresh-marker'
const SESSION_MESSAGE = /Could not verify your session\. Check your connection and try again\./
const REFRESH_ENDPOINT = /\/auth\/v1\/token\?grant_type=refresh_token/
const CREATE_PURCHASE = /\/rest\/v1\/rpc\/create_purchase/
const COOLDOWN_MS = 62_000 // auth-js keeps a refresh failure for 60 s

const service = () => createServiceClient()

interface StoredPurchase {
  id: string
  user_id: string
  total_minor: string
  idempotency_key: string
}

async function purchasesWithNote(note: string): Promise<StoredPurchase[]> {
  const { data, error } = await service()
    .from('purchases')
    .select('id, user_id, total_minor::text, idempotency_key')
    .eq('notes', note)
  expect(error).toBeNull()
  return data ?? []
}

async function linesOfPurchase(purchaseId: string): Promise<number> {
  const { count, error } = await service()
    .from('purchase_lines')
    .select('id', { count: 'exact', head: true })
    .eq('purchase_id', purchaseId)
  expect(error).toBeNull()
  return count ?? 0
}

async function fillLargePurchase(page: Page, note: string): Promise<void> {
  await page.goto('/purchases/new')
  await expect(page.getByLabel('Shipping')).toBeVisible()
  await page.getByLabel('Type').first().selectOption('accessory')
  await page.getByLabel('Description').fill('p149 large')
  await page.getByLabel('Unit price').fill(TYPED)
  await page.getByLabel('Notes').fill(note)
}

/** The refresh endpoint, and only it, cannot be reached; every attempt is counted. */
async function breakRefreshEndpoint(page: Page): Promise<{ attempts: () => number }> {
  let attempts = 0
  await page.route(REFRESH_ENDPOINT, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fallback()
      return
    }
    attempts += 1
    await route.abort('connectionrefused')
  })
  return { attempts: () => attempts }
}

async function restoreRefreshEndpoint(page: Page): Promise<void> {
  await page.unroute(REFRESH_ENDPOINT)
}

/** The service says the refresh token is not valid (a definitive answer, unlike an outage). */
async function rejectRefreshTokens(page: Page): Promise<{ attempts: () => number }> {
  let attempts = 0
  await page.route(REFRESH_ENDPOINT, async (route: Route) => {
    const request = route.request()
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': '*',
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors })
      return
    }
    attempts += 1
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify({
        code: 400,
        error_code: 'refresh_token_not_found',
        msg: 'Invalid Refresh Token: Refresh Token Not Found',
      }),
    })
  })
  return { attempts: () => attempts }
}

/** The stored session's access token has expired; its refresh token is untouched. */
async function expireAccessToken(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (raw === null) throw new Error('no stored session to expire')
    const session = JSON.parse(raw) as { expires_at: number }
    session.expires_at = Math.floor(Date.now() / 1000) - 120
    window.localStorage.setItem(key, JSON.stringify(session))
  }, AUTH_STORAGE_KEY)
}

/** create_purchase requests as the browser sent them, with the key each carried. */
function captureCreatePurchase(page: Page): { keys: (string | null)[]; bodies: string[] } {
  const seen: { keys: (string | null)[]; bodies: string[] } = { keys: [], bodies: [] }
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !CREATE_PURCHASE.test(request.url())) return
    const body = request.postData()
    const parsed = body === null ? null : (JSON.parse(body) as { p_idempotency_key?: string })
    seen.keys.push(parsed?.p_idempotency_key ?? null)
    seen.bodies.push(body ?? '')
  })
  return seen
}

/** Counts how many credential lookups (`supabase.auth.getSession()`) started and how many answered. */
async function installLookupTracker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __p149Lookups?: { started: number; settled: number } }
    if (w.__p149Lookups) return
    const modulePath = '/src/data/supabase-client.ts'
    const { supabase } = (await import(/* @vite-ignore */ modulePath)) as {
      supabase: { auth: { getSession: () => Promise<unknown> } }
    }
    const counters = { started: 0, settled: 0 }
    w.__p149Lookups = counters
    const original = supabase.auth.getSession.bind(supabase.auth)
    supabase.auth.getSession = async () => {
      counters.started += 1
      try {
        return await original()
      } finally {
        counters.settled += 1
      }
    }
  })
}

async function lookupCounters(page: Page): Promise<{ started: number; settled: number }> {
  return page.evaluate(
    () =>
      (window as unknown as { __p149Lookups: { started: number; settled: number } }).__p149Lookups,
  )
}

/** The purchase form's idempotency key, read from the running form's own state. */
async function readIdempotencyKey(page: Page): Promise<string> {
  const key = await page.evaluate(() => {
    const element = document.querySelector('main input, form input, input')
    if (element === null) return null
    const fiberKey = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
    if (fiberKey === undefined) return null
    interface Hook {
      memoizedState?: unknown
      next?: Hook | null
    }
    interface Fiber {
      memoizedState?: Hook | null
      return?: Fiber | null
    }
    let fiber: Fiber | null | undefined = (element as unknown as Record<string, Fiber>)[fiberKey]
    while (fiber) {
      let hook: Hook | null | undefined = fiber.memoizedState
      while (hook && typeof hook === 'object') {
        const value = hook.memoizedState as { idempotencyKey?: unknown } | null | undefined
        if (value && typeof value === 'object' && typeof value.idempotencyKey === 'string') {
          return value.idempotencyKey
        }
        hook = hook.next
      }
      fiber = fiber.return
    }
    return null
  })
  expect(key, 'the purchase form exposes its idempotency key in its React state').not.toBeNull()
  return key as string
}

async function expectFormIntact(page: Page, note: string): Promise<void> {
  await expect(page.getByLabel('Notes')).toHaveValue(note)
  await expect(page.getByLabel('Unit price')).toHaveValue(TYPED)
  await expect(page.getByLabel('Description')).toHaveValue('p149 large')
  await expect(page.getByRole('button', { name: 'Save purchase' })).toBeEnabled()
}

test.describe('a failed credential refresh is not an identity change (P148-M2), real browser', () => {
  let pair: Pair | null = null
  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test('refresh endpoint unreachable: nothing sent or written, the error is shown to A, form and key survive, the retry saves exactly once with the exact amount', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    pair = await createPair('p149-outage')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-outage-${Date.now()}`
    await fillLargePurchase(page, note)
    const keyBefore = await readIdempotencyKey(page)
    const sent = captureCreatePurchase(page)
    const refresh = await breakRefreshEndpoint(page)
    await expireAccessToken(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    // the refresh is attempted (and fails) before anything else can happen
    await expect(page.getByRole('alert').filter({ hasText: SESSION_MESSAGE })).toBeVisible({
      timeout: 90_000,
    })
    expect(refresh.attempts()).toBeGreaterThanOrEqual(1)
    // no financial request left the browser, no row exists
    expect(sent.keys).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])
    // the person is still on their own form with their own input, and may press Save again
    await expectFormIntact(page, note)
    expect(page.url()).toContain('/purchases/new')
    expect(await readIdempotencyKey(page)).toBe(keyBefore)
    // no raw internals in what is shown
    const shown = await page.getByRole('alert').allInnerTexts()
    expect(shown.join('\n')).not.toMatch(
      /AuthRetryableFetchError|AuthCredentialsUnavailable|AuthIdentityChanged|Failed to fetch|127.0.0.1|eyJ/,
    )
    expect(shown.join('\n')).not.toMatch(/sign-in changed/i)

    // the service comes back; the library's own one-minute failure cache has to run out first
    await restoreRefreshEndpoint(page)
    await page.waitForTimeout(COOLDOWN_MS)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 60_000 })

    const rows = await purchasesWithNote(note)
    expect(rows.map((r) => [r.user_id, r.total_minor])).toEqual([[pair.a.id, EXACT_MINOR]])
    expect(await linesOfPurchase(rows[0]?.id ?? '')).toBe(1)
    expect(sent.keys).toEqual([keyBefore]) // one request, carrying the key the form held from the start
    // the amount left the browser as decimal TEXT (the exact-money transport), never as a JSON number
    expect(sent.bodies[0]).toContain('"unit_price_minor":"' + EXACT_MINOR + '"')
    expect(sent.bodies[0]).not.toMatch(/"unit_price_minor":\d/)
    expect(rows[0]?.idempotency_key).toBe(keyBefore)
    await expect(page.getByText(EXACT_DISPLAY).first()).toBeVisible()
  })

  test("A -> B while the failing lookup is still backing off: nothing dispatched, A's error never appears on B's screen, B gets its own key and completes its own purchase", async ({
    context,
    page,
  }) => {
    test.setTimeout(240_000)
    pair = await createPair('p149-a2b')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-a2b-${Date.now()}`
    await fillLargePurchase(page, note)
    const keyA = await readIdempotencyKey(page)
    await armBroadcastCounter(page)
    await installLookupTracker(page)
    const other = await openOtherTab(context)
    const sent = captureCreatePurchase(page)
    const refresh = await breakRefreshEndpoint(page)
    await expireAccessToken(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect.poll(() => refresh.attempts(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
    const lookups = await lookupCounters(page)
    expect(lookups.started).toBeGreaterThan(lookups.settled) // the lookup is genuinely still pending

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    // let the pending lookup run to its (failed) end
    await expect
      .poll(
        async () => {
          const c = await lookupCounters(page)
          return c.settled >= c.started
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    await page.waitForTimeout(1_500)

    // B's screen: a fresh form, no trace of A, and none of A's failure
    await expect(page.getByLabel('Notes')).not.toHaveValue(note)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText(SESSION_MESSAGE)).toHaveCount(0)
    await expect(page.getByText(/sign-in changed/i)).toHaveCount(0)
    expect(sent.keys).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])

    // B acts: a new lease and a new request key, authenticated as B (B's own token is fresh)
    const keyB = await readIdempotencyKey(page)
    expect(keyB).not.toBe(keyA)
    await page.getByLabel('Type').first().selectOption('accessory')
    await page.getByLabel('Description').fill('p149 B own')
    await page.getByLabel('Unit price').fill('12')
    const noteB = `${MARKER}-b-own-${Date.now()}`
    await page.getByLabel('Notes').fill(noteB)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 30_000 })
    const rowsB = await purchasesWithNote(noteB)
    expect(rowsB.map((r) => [r.user_id, r.idempotency_key])).toEqual([[pair.b.id, keyB]])
    expect(sent.keys).toEqual([keyB])
    expect(await purchasesWithNote(note)).toEqual([])
  })

  test("A -> B -> A while the failing lookup is still backing off: the old operation stays dead, A's new screen shows no error and A can save with a new key", async ({
    context,
    page,
  }) => {
    test.setTimeout(240_000)
    pair = await createPair('p149-aba')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-aba-${Date.now()}`
    await fillLargePurchase(page, note)
    const keyFirstA = await readIdempotencyKey(page)
    await armBroadcastCounter(page)
    await installLookupTracker(page)
    const other = await openOtherTab(context)
    const sent = captureCreatePurchase(page)
    const refresh = await breakRefreshEndpoint(page)
    await expireAccessToken(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect.poll(() => refresh.attempts(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.a })
    await expect
      .poll(
        async () => {
          const c = await lookupCounters(page)
          return c.settled >= c.started
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    await page.waitForTimeout(1_500)

    await expect(page.getByLabel('Notes')).not.toHaveValue(note)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(sent.keys).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])

    // the same person is back, but it is a new identity generation: a new key, a new lease
    const keySecondA = await readIdempotencyKey(page)
    expect(keySecondA).not.toBe(keyFirstA)
    await page.getByLabel('Type').first().selectOption('accessory')
    await page.getByLabel('Description').fill('p149 A again')
    await page.getByLabel('Unit price').fill('7')
    const noteAgain = `${MARKER}-aba-again-${Date.now()}`
    await page.getByLabel('Notes').fill(noteAgain)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 30_000 })
    const rows = await purchasesWithNote(noteAgain)
    expect(rows.map((r) => [r.user_id, r.idempotency_key])).toEqual([[pair.a.id, keySecondA]])
    expect(await purchasesWithNote(note)).toEqual([])
  })

  test('the refresh token is definitively rejected: the app signs the person out through its normal path, nothing is sent, no write', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    pair = await createPair('p149-invalid')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-invalid-${Date.now()}`
    await fillLargePurchase(page, note)
    const sent = captureCreatePurchase(page)
    const refresh = await rejectRefreshTokens(page)
    await expireAccessToken(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/login/, { timeout: 30_000 })
    expect(refresh.attempts()).toBeGreaterThanOrEqual(1)
    expect(sent.keys).toEqual([])
    expect(await purchasesWithNote(note)).toEqual([])
    // and the stored session is gone: this is a sign-out, not a wedged form
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), AUTH_STORAGE_KEY),
    ).toBeNull()
    await expect(page.getByText(SESSION_MESSAGE)).toHaveCount(0)
  })

  test('control: an expired access token with a WORKING refresh endpoint is refreshed as A and the purchase is saved once', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    pair = await createPair('p149-refresh-ok')
    await signInThroughForm(page, pair.a)
    const note = `${MARKER}-refresh-ok-${Date.now()}`
    await fillLargePurchase(page, note)
    const key = await readIdempotencyKey(page)
    const sent = captureCreatePurchase(page)
    let refreshed = 0
    page.on('request', (request) => {
      if (REFRESH_ENDPOINT.test(request.url()) && request.method() === 'POST') refreshed += 1
    })
    await expireAccessToken(page)

    await page.getByRole('button', { name: 'Save purchase' }).click()
    await page.waitForURL(/\/purchases\/[0-9a-f-]{36}/, { timeout: 30_000 })
    expect(refreshed).toBeGreaterThanOrEqual(1)
    const rows = await purchasesWithNote(note)
    expect(rows.map((r) => [r.user_id, r.total_minor, r.idempotency_key])).toEqual([
      [pair.a.id, EXACT_MINOR, key],
    ])
    expect(sent.keys).toEqual([key])
  })
})
