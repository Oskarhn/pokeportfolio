import { readFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { test, expect, type BrowserContext, type Download, type Page } from '@playwright/test'
import { EXPORT_CSV_FILENAMES } from '../../../src/domain/export/csv-projections'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
  type TestClient,
} from '../../db/setup'

/**
 * P162 — exports under the identity lease, in a real browser against the local stack.
 *
 * Two pages of ONE browser context are two tabs of one profile (same localStorage, same
 * BroadcastChannel). "Page 2" performs a REAL sign-in / sign-out through the app's own Supabase
 * client singleton, so page 1 — which never reloads — hears exactly what a real second tab
 * announces. Page 1's export is HELD at a chosen data request (a Playwright route that waits for
 * the test), the identity is changed while it is held, and then it is released: what happens next
 * is the behaviour under test. Downloads are read back from disk.
 *
 * LOCAL ONLY. Every account is synthetic and disposable.
 */

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const B_MARKER = 'B-PRIVATE-MARKER-e2e-p162-4d2e'

let service: TestClient
let userA: SyntheticUser
let userB: SyntheticUser

const supabaseUrl = process.env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321'

function subOf(authorization: string | undefined): string | null {
  const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1]
  const payload = token?.split('.')[1]
  if (payload === undefined) return null
  try {
    return (
      (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string }).sub ??
      null
    )
  } catch {
    return null
  }
}

test.beforeAll(async () => {
  service = createServiceClient()
  userA = await createSyntheticUser(service, 'p162-e2e-a')
  userB = await createSyntheticUser(service, 'p162-e2e-b')
  const anonKey = process.env['SUPABASE_ANON_KEY'] as string
  const today = new Date().toISOString().slice(0, 10)
  for (const [user, note, unit] of [
    [userA, 'A-note', 10000],
    [userB, B_MARKER, 777],
  ] as const) {
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error: signInError } = await client.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    })
    if (signInError) throw new Error(`sign-in failed: ${signInError.message}`)
    const { error } = await client.rpc('create_purchase', {
      p_purchased_on: today,
      p_currency: 'NOK',
      p_notes: note,
      p_lines: [
        {
          line_type: 'card',
          card_variant_id: seedCatalog.charizardVariantId,
          condition: 'NM',
          quantity: 2,
          unit_price_minor: unit,
        },
      ],
    })
    if (error) throw new Error(`create_purchase failed: ${error.message}`)
  }
  await service.from('retailers').insert({ user_id: userB.id, name: B_MARKER })
})

test.afterAll(async () => {
  await deleteSyntheticUser(service, userB.id)
  await deleteSyntheticUser(service, userA.id)
})

async function signInThroughForm(page: Page, user: SyntheticUser): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
}

async function openOtherTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage()
  await other.goto('/privacy')
  return other
}

type OtherTabAction = { kind: 'sign-in'; user: SyntheticUser } | { kind: 'sign-out' }

async function actInOtherTab(other: Page, action: OtherTabAction): Promise<void> {
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
          }
        }
      }
      const result =
        kind === 'sign-in'
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signOut()
      if (result.error) throw new Error(`other-tab ${kind} failed: ${result.error.message}`)
    },
    [
      action.kind,
      action.kind === 'sign-in' ? action.user.email : '',
      action.kind === 'sign-in' ? action.user.password : '',
    ] as [string, string, string],
  )
}

/** Holds the export at its `holdAt`-th data request until `release()` is called. */
function holdDataRequests(page: Page, holdAt: number) {
  let count = 0
  let armed = false
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached: () => void = () => undefined
  const holding = new Promise<void>((resolve) => {
    reached = resolve
  })
  const subs: (string | null)[] = []
  const tokens = new Set<string>()
  void page.route('**/rest/v1/**', async (route) => {
    if (!armed) {
      await route.continue()
      return
    }
    count += 1
    const authorization = route.request().headers()['authorization']
    subs.push(subOf(authorization))
    if (authorization) tokens.add(authorization)
    if (count === holdAt) {
      reached()
      await gate
    }
    await route.continue()
  })
  return {
    /** Counting (and holding) starts now: call it right before pressing the export button. */
    arm: () => {
      armed = true
    },
    holding,
    release: () => {
      release()
    },
    requests: () => count,
    subs,
    tokens,
  }
}

function collectDownloads(page: Page): Download[] {
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  return downloads
}

test('A → B → A in another tab while the export is held: nothing is delivered and nothing is sent afterwards', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  const held = holdDataRequests(page, 6)
  const downloads = collectDownloads(page)
  await page.goto('/profile/export')
  await expect(page.getByRole('button', { name: 'Prepare CSV export' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  held.arm()
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await held.holding

  await actInOtherTab(other, { kind: 'sign-in', user: userB })
  await page.waitForTimeout(1500) // page 1 hears B
  await actInOtherTab(other, { kind: 'sign-in', user: userA })
  await page.waitForTimeout(1500) // and A again: the same user id as when the export began

  const before = held.requests()
  held.release()
  await page.waitForTimeout(3000)

  // At most the held request itself completed; the export sent nothing more.
  expect(held.requests() - before).toBeLessThanOrEqual(1)
  expect(downloads).toHaveLength(0)
  await expect(page.getByText(/Ready —/)).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(B_MARKER)
  // Nothing of B's data was read by the export at all: every export request so far was A's.
  const subs = held.subs.slice(0, 6)
  expect(subs.every((s) => s === userA.id)).toBe(true)
})

test('sign-out in another tab while the export is held: nothing is delivered', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  const held = holdDataRequests(page, 5)
  const downloads = collectDownloads(page)
  await page.goto('/profile/export')
  await expect(page.getByRole('button', { name: 'Prepare CSV export' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  held.arm()
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await held.holding
  await actInOtherTab(other, { kind: 'sign-out' })
  await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 15_000 })
  const before = held.requests()
  held.release()
  await page.waitForTimeout(3000)
  expect(held.requests() - before).toBeLessThanOrEqual(1)
  expect(downloads).toHaveLength(0)
})

test('an ordinary token refresh mid-export does not abort it: 11 real files, all requests as A', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  await signInThroughForm(page, userA)
  const held = holdDataRequests(page, 6)
  const downloads = collectDownloads(page)
  let refreshes = 0
  page.on('request', (req) => {
    if (req.url().includes('grant_type=refresh_token')) refreshes += 1
  })
  await page.goto('/profile/export')
  await expect(page.getByRole('button', { name: 'Prepare CSV export' })).toBeVisible()
  await page.waitForLoadState('networkidle')
  held.arm()
  await page.getByRole('button', { name: 'Prepare CSV export' }).click()
  await held.holding
  // The stored access token expires while the export is held: the very next request's session
  // lookup must refresh it (a real TOKEN_REFRESHED for the SAME user) and carry on.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.endsWith('-auth-token'))
    if (!key) throw new Error('no supabase auth-token key in localStorage')
    const session = JSON.parse(localStorage.getItem(key) ?? '{}') as { expires_at?: number }
    session.expires_at = Math.floor(Date.now() / 1000) - 60
    localStorage.setItem(key, JSON.stringify(session))
  })
  held.release()
  await expect(page.getByText(/Ready — CSV export, 11 files/)).toBeVisible({ timeout: 120_000 })
  expect(refreshes).toBeGreaterThan(0)
  expect(held.tokens.size).toBeGreaterThan(1) // requests before and after used different tokens
  expect(held.subs.every((s) => s === userA.id)).toBe(true)

  await page.getByRole('button', { name: /Save \/ Share CSV export/ }).click()
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(11)
  const names = downloads.map((d) => d.suggestedFilename()).sort()
  expect(names).toEqual([...EXPORT_CSV_FILENAMES].sort())
  for (const download of downloads) {
    const target = `${testInfo.outputDir}/${download.suggestedFilename()}`
    await download.saveAs(target)
    const bytes = await readFile(target)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.toString('utf8')).not.toContain(B_MARKER)
  }
})

test('Quick CSV: A → B in another tab while its page request is held delivers no file', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  await signInThroughForm(page, userA)
  const other = await openOtherTab(context)
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached: () => void = () => undefined
  const holding = new Promise<void>((resolve) => {
    reached = resolve
  })
  const downloads = collectDownloads(page)
  await page.goto('/portfolio')
  const tile = page.getByRole('button', { name: /Quick CSV/ })
  await expect(tile).toBeVisible()
  await page.waitForLoadState('networkidle')
  // From here on the next list_portfolio request is the export's own page.
  let held = false
  await page.route('**/rest/v1/rpc/list_portfolio', async (route) => {
    if (!held) {
      held = true
      reached()
      await gate
    }
    await route.continue()
  })
  await tile.click()
  await holding
  await actInOtherTab(other, { kind: 'sign-in', user: userB })
  await page.waitForTimeout(1500)
  release()
  await page.waitForTimeout(4000)
  expect(downloads).toHaveLength(0)
  await expect(page.locator('body')).not.toContainText('A-note')
})
