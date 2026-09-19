import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  buildFakeSessionObject,
  resolveFakeSessionOptions,
  simulateOtherTabAuthChange,
  FAKE_AUTH_STORAGE_KEY,
} from './support/fake-session'

/**
 * P143 / P130-23 — an authenticated identity change in ANOTHER tab of the same browser profile must
 * not leave the first tab's user-scoped UI state alive under the new identity.
 *
 * WHY THIS IS A BROWSER TEST. The defect is a React lifecycle fact: `RequireSession` renders
 * `<>{children}</>` for any signed-in status, so a direct A -> B `SIGNED_IN` broadcast (supabase-js
 * posts `{ event, session }` on a `BroadcastChannel` named after its storage key to every other tab
 * of the same profile) re-rendered the SAME mounted form instance with A's `useState` values still
 * in it, and the next submit went out under B's bearer. Nothing that can execute here without a
 * real React tree and a real BroadcastChannel proves or disproves that.
 *
 * WHAT IS REAL AND WHAT IS PLAYED. The app under test is the production build against the
 * placeholder backend (every network call fails identically, playwright.config.ts). The "other tab"
 * is played by `simulateOtherTabAuthChange`: it writes the shared storage key and posts the very
 * message supabase-js's own client would. Two-context isolation is deliberately NOT used — the whole
 * point is that the pages share ONE storage/BroadcastChannel partition. The real-GoTrue variant of
 * these scenarios (real sign-in through a second client, real refresh) lives in
 * tests/e2e/authenticated/auth-identity-real.spec.ts.
 *
 * The marker fields are ordinary free-text inputs on `/purchases/new`: it needs no backend data to
 * render, and it is the page P130-23 named HIGH severity.
 */

const USER_A = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'p143-a@example.test' }
const USER_B = { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'p143-b@example.test' }
const MARKER_A = 'A-ONLY-p143-marker'
const MARKER_B = 'B-ONLY-p143-marker'

function sessionFor(user: { userId: string; email: string }, refreshToken = 'refresh-1') {
  return buildFakeSessionObject(resolveFakeSessionOptions({ ...user, refreshToken }))
}

/** Seeds a session ONCE per tab (a plain `addInitScript` would re-seed on every reload and undo
 *  whatever the test did to the stored session). */
async function seedSessionOnce(page: Page, session: object): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window.sessionStorage.getItem('p143-seeded') !== null) return
      window.sessionStorage.setItem('p143-seeded', '1')
      window.localStorage.setItem(key, value)
    },
    [FAKE_AUTH_STORAGE_KEY, JSON.stringify(session)] as [string, string],
  )
}

/** A same-origin page that does NOT run the app — it only stands in for "another tab". */
async function openOtherTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage()
  await other.goto('/robots.txt')
  return other
}

/** Counts BroadcastChannel deliveries in the FIRST tab, so a test knows the message reached it
 *  before it asserts anything (supabase-js's own listener on its own channel object is registered
 *  earlier, so by the time this one fires the auth callback has already run). */
async function armBroadcastCounter(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const w = window as unknown as { __p143Deliveries: number; __p143Channel: BroadcastChannel }
    w.__p143Deliveries = 0
    w.__p143Channel = new BroadcastChannel(key)
    w.__p143Channel.addEventListener('message', () => {
      w.__p143Deliveries += 1
    })
  }, FAKE_AUTH_STORAGE_KEY)
}

async function switchAndSettle(
  first: Page,
  other: Page,
  change: Parameters<typeof simulateOtherTabAuthChange>[1],
): Promise<void> {
  const before = await first.evaluate(
    () => (window as unknown as { __p143Deliveries: number }).__p143Deliveries,
  )
  await simulateOtherTabAuthChange(other, change)
  await first.waitForFunction(
    (n) => (window as unknown as { __p143Deliveries: number }).__p143Deliveries > n,
    before,
  )
  // Two animation frames: React has committed whatever the auth callback scheduled.
  await first.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve()
          })
        })
      }),
  )
}

async function openPurchaseForm(page: Page, user: typeof USER_A): Promise<void> {
  await seedSessionOnce(page, sessionFor(user))
  await page.goto('/purchases/new')
  await expect(page.getByLabel('Shipping')).toBeVisible()
  await armBroadcastCounter(page)
}

/** Every text-entry value currently in the DOM (input values are not part of `innerText`). */
async function allFieldValues(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select')).map(
      (el) => (el as HTMLInputElement).value,
    ),
  )
}

test.describe('P143 — auth identity lifecycle across tabs (placeholder backend)', () => {
  test.skip(({ isMobile }) => isMobile, 'viewport-independent; runs on desktop-chromium only')

  test('same-user TOKEN_REFRESHED and USER_UPDATED keep unsaved input (identity is the user id, not the token)', async ({
    context,
    page,
  }) => {
    await openPurchaseForm(page, USER_A)
    await page.getByLabel('Notes').fill(MARKER_A)
    await page.getByLabel('Shipping').fill('123.45')
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, {
      event: 'TOKEN_REFRESHED',
      session: sessionFor(USER_A, 'refresh-2'),
    })
    await switchAndSettle(page, other, {
      event: 'USER_UPDATED',
      session: sessionFor(USER_A, 'refresh-3'),
    })
    // A repeated SIGNED_IN for the SAME user is what supabase-js emits on tab refocus.
    await switchAndSettle(page, other, {
      event: 'SIGNED_IN',
      session: sessionFor(USER_A, 'refresh-4'),
    })

    await expect(page.getByLabel('Notes')).toHaveValue(MARKER_A)
    await expect(page.getByLabel('Shipping')).toHaveValue('123.45')
  })

  test('direct A -> B (SIGNED_IN for a different user, no SIGNED_OUT between) destroys A-only input', async ({
    context,
    page,
  }) => {
    await openPurchaseForm(page, USER_A)
    await page.getByLabel('Notes').fill(MARKER_A)
    await page.getByLabel('Shipping').fill('999')
    await page.getByLabel('Add a new retailer').fill(`${MARKER_A}-retailer`)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { event: 'SIGNED_IN', session: sessionFor(USER_B) })

    // Positive control FIRST: this tab really is B now. A client-side navigation (never a reload)
    // to Profile renders `useAuth().email`; if it shows B, the auth callback took B and the
    // assertions below are about state that SURVIVED a real identity change, not about a message
    // that never arrived. `expect.soft` so a survival failure is reported next to the control.
    await expect.soft(page.getByLabel('Notes')).toHaveValue('')
    await expect.soft(page.getByLabel('Shipping')).toHaveValue('')
    await expect.soft(page.getByLabel('Add a new retailer')).toHaveValue('')
    expect.soft((await allFieldValues(page)).some((v) => v.includes(MARKER_A))).toBe(false)

    await page.getByRole('link', { name: 'Profile' }).first().click()
    await expect(page.getByText(USER_B.email)).toBeVisible()
    await expect(page.getByText(USER_A.email)).toHaveCount(0)
  })

  test('B -> A afterwards is fresh too (no resurrection of either identity’s input)', async ({
    context,
    page,
  }) => {
    await openPurchaseForm(page, USER_A)
    await page.getByLabel('Notes').fill(MARKER_A)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { event: 'SIGNED_IN', session: sessionFor(USER_B) })
    await expect.soft(page.getByLabel('Notes')).toHaveValue('')
    await page.getByLabel('Notes').fill(MARKER_B)

    await switchAndSettle(page, other, { event: 'SIGNED_IN', session: sessionFor(USER_A) })
    await expect.soft(page.getByLabel('Notes')).toHaveValue('')
    expect.soft((await allFieldValues(page)).some((v) => v.includes('ONLY'))).toBe(false)

    await page.getByRole('link', { name: 'Profile' }).first().click()
    await expect(page.getByText(USER_A.email)).toBeVisible()
  })

  test('SIGNED_OUT from another tab removes the protected page and its state', async ({
    context,
    page,
  }) => {
    await openPurchaseForm(page, USER_A)
    await page.getByLabel('Notes').fill(MARKER_A)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { event: 'SIGNED_OUT', session: null })

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel('Notes')).toHaveCount(0)
    expect((await allFieldValues(page)).some((v) => v.includes(MARKER_A))).toBe(false)

    // ...and the NEXT sign-in (A again, same id) is a fresh tree: back to the form, no marker.
    await switchAndSettle(page, other, { event: 'SIGNED_IN', session: sessionFor(USER_A) })
    await page.goto('/purchases/new')
    await expect(page.getByLabel('Notes')).toHaveValue('')
  })
})
