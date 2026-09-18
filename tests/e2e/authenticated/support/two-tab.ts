import { type BrowserContext, type Page, expect } from '@playwright/test'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type SyntheticUser,
} from '../../../db/setup'

/**
 * Two pages of ONE Playwright browser context share localStorage and the BroadcastChannel that
 * supabase-js uses for cross-tab auth events, exactly like two tabs of one browser profile. This
 * module is the shared vocabulary for the specs that need that (P145 in-flight mutations). The
 * P143 spec keeps its own copies on purpose: it is not touched here.
 *
 * "Page 2" is the other tab. It imports the app's own Supabase client from Vite's dev server (the
 * same singleton the running app uses) and performs a REAL signInWithPassword / signOut /
 * refreshSession / updateUser; supabase-js rewrites the shared storage entry and broadcasts, and
 * page 1 — which never reloads — receives it through its own onAuthStateChange.
 */

const supabaseUrl = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
export const AUTH_STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`

export interface Pair {
  a: SyntheticUser
  b: SyntheticUser
}

export async function createPair(label: string): Promise<Pair> {
  const service = createServiceClient()
  return {
    a: await createSyntheticUser(service, `${label}-a`),
    b: await createSyntheticUser(service, `${label}-b`),
  }
}

export async function deletePair(pair: Pair | null): Promise<void> {
  if (pair === null) return
  const service = createServiceClient()
  await deleteSyntheticUser(service, pair.a.id)
  await deleteSyntheticUser(service, pair.b.id)
}

export async function signInThroughForm(page: Page, user: SyntheticUser): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
}

/** The other tab: same origin, runs the app's own client singleton. */
export async function openOtherTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage()
  await other.goto('/privacy')
  return other
}

export type OtherTabAction =
  | { kind: 'sign-in'; user: SyntheticUser }
  | { kind: 'sign-out' }
  | { kind: 'refresh' }
  | { kind: 'update-user' }

export async function actInOtherTab(other: Page, action: OtherTabAction): Promise<void> {
  await other.evaluate(
    async ([kind, email, password]) => {
      const modulePath = '/src/data/supabase-client.ts'
      const { supabase } = (await import(/* @vite-ignore */ modulePath)) as {
        supabase: {
          auth: {
            signInWithPassword: (c: {
              email: string
              password: string
            }) => Promise<{ error: { message: string } | null }>
            signOut: () => Promise<{ error: { message: string } | null }>
            refreshSession: () => Promise<{ error: { message: string } | null }>
            updateUser: (a: {
              data: Record<string, string>
            }) => Promise<{ error: { message: string } | null }>
          }
        }
      }
      const result =
        kind === 'sign-in'
          ? await supabase.auth.signInWithPassword({ email, password })
          : kind === 'sign-out'
            ? await supabase.auth.signOut()
            : kind === 'refresh'
              ? await supabase.auth.refreshSession()
              : await supabase.auth.updateUser({ data: { p145: String(Date.now()) } })
      if (result.error) throw new Error(`other-tab ${kind} failed: ${result.error.message}`)
    },
    [
      action.kind,
      action.kind === 'sign-in' ? action.user.email : '',
      action.kind === 'sign-in' ? action.user.password : '',
    ] as [string, string, string],
  )
}

/** Counts BroadcastChannel deliveries in `page`, so a test can wait until the switch reached it. */
export async function armBroadcastCounter(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const w = window as unknown as { __p145Deliveries: number; __p145Channel: BroadcastChannel }
    w.__p145Deliveries = 0
    w.__p145Channel = new BroadcastChannel(key)
    w.__p145Channel.addEventListener('message', () => {
      w.__p145Deliveries += 1
    })
  }, AUTH_STORAGE_KEY)
}

/** Performs `action` in the other tab and waits until `first` has received it and re-rendered. */
export async function switchAndSettle(
  first: Page,
  other: Page,
  action: OtherTabAction,
): Promise<void> {
  const before = await first.evaluate(
    () => (window as unknown as { __p145Deliveries: number }).__p145Deliveries,
  )
  await actInOtherTab(other, action)
  await first.waitForFunction(
    (n) => (window as unknown as { __p145Deliveries: number }).__p145Deliveries > n,
    before,
    { timeout: 15_000 },
  )
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

/**
 * Widens the window between "the mutation starts" and "Supabase obtains the bearer token" on
 * `page`: while ARMED, every `supabase.auth.getSession()` call parks until released. This is the
 * public method supabase-js itself calls (`this.auth.getSession()`) to pick the token for every
 * request, and in production the same window is a token refresh round trip. Installing it changes
 * no application code; disarmed, the wrapper is a pass-through.
 */
export async function installSessionLookupGate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as {
      __p145Gate?: { armed: boolean; parked: number; waiters: (() => void)[] }
    }
    if (w.__p145Gate) return
    const modulePath = '/src/data/supabase-client.ts'
    const { supabase } = (await import(/* @vite-ignore */ modulePath)) as {
      supabase: { auth: { getSession: () => Promise<unknown> } }
    }
    const gate = { armed: false, parked: 0, waiters: [] as (() => void)[] }
    w.__p145Gate = gate
    const original = supabase.auth.getSession.bind(supabase.auth)
    supabase.auth.getSession = async () => {
      if (gate.armed) {
        gate.parked += 1
        await new Promise<void>((resolve) => gate.waiters.push(resolve))
      }
      return original()
    }
  })
}

export async function armSessionLookupGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (window as unknown as { __p145Gate: { armed: boolean; parked: number } })
      .__p145Gate
    gate.parked = 0
    gate.armed = true
  })
}

export async function waitForSessionLookupParked(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __p145Gate: { parked: number } }).__p145Gate.parked > 0,
    undefined,
    { timeout: 15_000 },
  )
}

export async function releaseSessionLookupGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (window as unknown as { __p145Gate: { armed: boolean; waiters: (() => void)[] } })
      .__p145Gate
    gate.armed = false
    for (const resolve of gate.waiters.splice(0)) resolve()
  })
}

/**
 * Holds ONE matching request of `page` at the network layer until `release()` is called, then lets
 * it through unchanged (or answers it with `mock`). The request already carries the bearer token it
 * was dispatched with, so releasing it models "an already-dispatched request completes as its
 * caller".
 */
export interface RequestHold {
  reached: Promise<void>
  release: () => void
}

export async function holdRequest(
  page: Page,
  urlPattern: string | RegExp,
  method: string,
  mock?: { status: number; body: unknown },
): Promise<RequestHold> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let markReached!: () => void
  const reached = new Promise<void>((resolve) => {
    markReached = resolve
  })
  let taken = false
  await page.route(urlPattern, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS' && mock) {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      })
      return
    }
    if (taken || request.method() !== method) {
      await route.fallback()
      return
    }
    taken = true
    markReached()
    await gate
    if (mock) {
      await route.fulfill({
        status: mock.status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(mock.body),
      })
    } else {
      await route.continue()
    }
  })
  return { reached, release }
}

/** Records every request whose URL matches, so a test can assert one was (never) issued. */
export function recordRequests(page: Page, urlPattern: RegExp): { urls: string[] } {
  const seen: { urls: string[] } = { urls: [] }
  page.on('request', (request) => {
    if (urlPattern.test(request.url()) && request.method() !== 'OPTIONS') {
      seen.urls.push(`${request.method()} ${request.url()}`)
    }
  })
  return seen
}

export async function expectNoFieldContains(page: Page, needle: string): Promise<void> {
  const values = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select')).map(
      (el) => (el as HTMLInputElement).value,
    ),
  )
  expect(values.some((v) => v.includes(needle))).toBe(false)
}
