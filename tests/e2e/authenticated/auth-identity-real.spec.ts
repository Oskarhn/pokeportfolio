import { fileURLToPath } from 'node:url'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  type SyntheticUser,
} from '../../db/setup'

const SYNTHETIC_CARD_IMAGE = fileURLToPath(
  new URL('../../fixtures/scanner/synthetic-card.png', import.meta.url),
)

/**
 * P143 / P130-22 + P130-23 against a REAL local GoTrue: two pages of ONE browser context share the
 * same localStorage and the same BroadcastChannel, exactly like two tabs of one profile.
 *
 * "Page 2" is the other tab. It reaches the app's own Supabase client (Vite's dev server exposes
 * the module at `/src/data/supabase-client.ts`, and importing it inside the page yields the same
 * singleton the running app uses) and performs a REAL `signInWithPassword` / `signOut` /
 * `refreshSession`. supabase-js then does what it does for a real second tab: rewrites the shared
 * storage entry and broadcasts the event, and PAGE 1 — which never reloads — receives it through
 * its own `onAuthStateChange`.
 *
 * Each test signs in its OWN disposable users through the real login form (never the shared
 * `e2e-auth` session: `signOut()` is GLOBAL scope and would revoke it for every other spec — P112).
 */

test.use({ storageState: { cookies: [], origins: [] } })

const supabaseUrl = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`

const MARKER_A = 'A-ONLY-p143-real-marker'

interface Pair {
  a: SyntheticUser
  b: SyntheticUser
}

async function createPair(label: string): Promise<Pair> {
  const service = createServiceClient()
  return {
    a: await createSyntheticUser(service, `${label}-a`),
    b: await createSyntheticUser(service, `${label}-b`),
  }
}

async function deletePair(pair: Pair | null): Promise<void> {
  if (pair === null) return
  const service = createServiceClient()
  await deleteSyntheticUser(service, pair.a.id)
  await deleteSyntheticUser(service, pair.b.id)
}

async function signInThroughForm(page: Page, user: SyntheticUser): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
}

/** The other tab: same origin, runs the app's own client singleton. */
async function openOtherTab(context: BrowserContext): Promise<Page> {
  const other = await context.newPage()
  await other.goto('/privacy')
  return other
}

type OtherTabAction =
  | { kind: 'sign-in'; user: SyntheticUser }
  | { kind: 'sign-out' }
  | { kind: 'refresh' }
  | { kind: 'update-user' }

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
              : await supabase.auth.updateUser({ data: { p143: String(Date.now()) } })
      if (result.error) throw new Error(`other-tab ${kind} failed: ${result.error.message}`)
    },
    [
      action.kind,
      action.kind === 'sign-in' ? action.user.email : '',
      action.kind === 'sign-in' ? action.user.password : '',
    ] as [string, string, string],
  )
}

async function armBroadcastCounter(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const w = window as unknown as { __p143Deliveries: number; __p143Channel: BroadcastChannel }
    w.__p143Deliveries = 0
    w.__p143Channel = new BroadcastChannel(key)
    w.__p143Channel.addEventListener('message', () => {
      w.__p143Deliveries += 1
    })
  }, STORAGE_KEY)
}

async function switchAndSettle(first: Page, other: Page, action: OtherTabAction): Promise<void> {
  const before = await first.evaluate(
    () => (window as unknown as { __p143Deliveries: number }).__p143Deliveries,
  )
  await actInOtherTab(other, action)
  await first.waitForFunction(
    (n) => (window as unknown as { __p143Deliveries: number }).__p143Deliveries > n,
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

async function allFieldValues(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select')).map(
      (el) => (el as HTMLInputElement).value,
    ),
  )
}

interface StateShape {
  name: string
  path: () => Promise<string>
  ready: (page: Page) => Promise<void>
  enterMarker: (page: Page) => Promise<void>
}

async function anySealedProductId(): Promise<string> {
  const service = createServiceClient()
  const { data, error } = await service.from('sealed_products').select('id').limit(1).single()
  if (error) throw new Error(`no sealed product in the seed catalog: ${error.message}`)
  return String(data.id)
}

// One representative per DIFFERENT state pattern: a plain useState form, two forms with a fixed
// per-mount request key (P138/P140), and an inline edit-in-place section keyed on the loaded record.
const SHAPES: StateShape[] = [
  {
    name: 'PurchaseFormPage (useState form + manual-card cache)',
    path: () => Promise.resolve('/purchases/new'),
    ready: (page) => expect(page.getByLabel('Shipping')).toBeVisible(),
    enterMarker: (page) => page.getByLabel('Notes').fill(MARKER_A),
  },
  {
    name: 'AddToCollectionPage (per-mount request key)',
    path: () => Promise.resolve(`/add?variantId=${seedCatalog.pikachuVariantId}`),
    ready: (page) => expect(page.getByLabel('Quantity')).toBeVisible({ timeout: 15_000 }),
    enterMarker: (page) => page.getByLabel('Notes').fill(MARKER_A),
  },
  {
    name: 'AddSealedProductPage (per-mount request key)',
    path: async () => `/portfolio/sealed/new?sealedProductId=${await anySealedProductId()}`,
    ready: (page) => expect(page.getByLabel('Quantity')).toBeVisible({ timeout: 15_000 }),
    enterMarker: (page) => page.getByLabel('Notes').fill(MARKER_A),
  },
  {
    name: 'ProfilePage display-name editor (edit-in-place)',
    path: () => Promise.resolve('/profile'),
    ready: (page) => expect(page.getByRole('button', { name: 'Add a display name' })).toBeVisible(),
    enterMarker: async (page) => {
      await page.getByRole('button', { name: 'Add a display name' }).click()
      await page.getByLabel('Display name').fill(MARKER_A)
    },
  },
]

test.describe('P143 — real two-page identity switch (shared browser auth state)', () => {
  let pair: Pair | null = null

  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  for (const shape of SHAPES) {
    test(`A -> B: ${shape.name} — A's unsaved input is gone for B`, async ({ context, page }) => {
      pair = await createPair('p143-shape')
      await signInThroughForm(page, pair.a)
      await page.goto(await shape.path())
      await shape.ready(page)
      await shape.enterMarker(page)
      await armBroadcastCounter(page)
      const other = await openOtherTab(context)

      await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })

      // Positive control: page 1 really acts as B now (its next SPA navigation shows B's email).
      // `expect.soft` so a survival failure is reported alongside the control at the reproduction.
      expect.soft((await allFieldValues(page)).some((v) => v.includes(MARKER_A))).toBe(false)
      await expect.soft(page.getByText(MARKER_A)).toHaveCount(0)
      await page.getByRole('link', { name: 'Profile' }).first().click()
      await expect(page.getByText(pair.b.email)).toBeVisible()
      await expect(page.getByText(pair.a.email)).toHaveCount(0)
    })
  }

  test('A -> B then B -> A: the second switch is fresh as well', async ({ context, page }) => {
    pair = await createPair('p143-roundtrip')
    await signInThroughForm(page, pair.a)
    await page.goto('/purchases/new')
    await page.getByLabel('Notes').fill(MARKER_A)
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })
    await expect.soft(page.getByLabel('Notes')).toHaveValue('')
    await page.getByLabel('Notes').fill('B-ONLY-p143-real-marker')

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.a })
    await expect.soft(page.getByLabel('Notes')).toHaveValue('')
    expect.soft((await allFieldValues(page)).some((v) => v.includes('ONLY'))).toBe(false)
  })

  test("the consequence: A's typed profile name is never written to B's account", async ({
    context,
    page,
  }) => {
    pair = await createPair('p143-consequence')
    await signInThroughForm(page, pair.a)
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Add a display name' }).click()
    await page.getByLabel('Display name').fill(MARKER_A)
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })

    // A form that survived is still there to be submitted — under B's session. On a correct
    // build there is nothing left to press.
    if ((await page.getByLabel('Display name').count()) > 0) {
      await page.getByRole('button', { name: 'Save' }).click()
      await page.waitForTimeout(1_000)
    }
    const service = createServiceClient()
    const { data, error } = await service
      .from('profiles')
      .select('display_name')
      .eq('id', pair.b.id)
      .single()
    expect(error).toBeNull()
    expect(data?.display_name).not.toBe(MARKER_A)
  })

  test("A's cached server data is never rendered under B (query cache cleared BEFORE the new tree mounts)", async ({
    context,
    page,
  }) => {
    pair = await createPair('p143-cache')
    const service = createServiceClient()
    const nameA = 'A-NAME-p143-cache-marker'
    const nameB = 'B-NAME-p143-cache-marker'
    await service.from('profiles').update({ display_name: nameA }).eq('id', pair.a.id)
    await service.from('profiles').update({ display_name: nameB }).eq('id', pair.b.id)
    await signInThroughForm(page, pair.a)
    await page.goto('/profile')
    // The name renders twice (header + the edit button), hence `.first()` for presence checks.
    await expect(page.getByText(nameA).first()).toBeVisible()
    await armBroadcastCounter(page)
    // Records, at EVERY DOM mutation, whether B's identity is on screen together with A's name.
    // A stale-cache render would flash A's name for one commit; polling for the end state alone
    // would never see it.
    await page.evaluate(
      ([emailB, aName]) => {
        const w = window as unknown as { __p143Leak: boolean }
        w.__p143Leak = false
        new MutationObserver(() => {
          const text = document.body.innerText
          if (text.includes(emailB) && text.includes(aName)) w.__p143Leak = true
        }).observe(document.body, { subtree: true, childList: true, characterData: true })
      },
      [pair.b.email, nameA] as [string, string],
    )
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })

    await expect(page.getByText(nameB).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(nameA)).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { __p143Leak: boolean }).__p143Leak),
    ).toBe(false)
  })

  test('same-user refresh / user update / repeated sign-in do NOT destroy unsaved input', async ({
    context,
    page,
  }) => {
    pair = await createPair('p143-refresh')
    await signInThroughForm(page, pair.a)
    await page.goto('/purchases/new')
    await page.getByLabel('Notes').fill(MARKER_A)
    await page.getByLabel('Shipping').fill('42.50')
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { kind: 'refresh' })
    await switchAndSettle(page, other, { kind: 'update-user' })
    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.a })

    await expect(page.getByLabel('Notes')).toHaveValue(MARKER_A)
    await expect(page.getByLabel('Shipping')).toHaveValue('42.50')
  })

  test('cross-tab sign-out: the other tab loses the protected page, its state and its session', async ({
    context,
    page,
  }) => {
    pair = await createPair('p143-xsignout')
    await signInThroughForm(page, pair.a)
    await page.goto('/purchases/new')
    await page.getByLabel('Notes').fill(MARKER_A)
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { kind: 'sign-out' })

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel('Notes')).toHaveCount(0)
    expect((await allFieldValues(page)).some((v) => v.includes(MARKER_A))).toBe(false)
    expect(await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull()
  })

  test('scanner: a nonempty batch and session defaults of A do not survive into B', async ({
    context,
    page,
  }) => {
    test.setTimeout(180_000)
    pair = await createPair('p143-scanner')
    await signInThroughForm(page, pair.a)
    await page.goto('/scan')
    await page.getByRole('button', { name: 'Choose photo' }).click()
    await page.locator('input[type="file"]').setInputFiles(SYNTHETIC_CARD_IMAGE)
    await page.getByRole('button', { name: 'Use photo' }).click()
    await page.getByRole('button', { name: /search manually/i }).click({ timeout: 90_000 })
    await page.getByLabel('Card name').fill('Pikachu')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByText('Tap a card to confirm it').waitFor({ timeout: 15_000 })
    await page
      .locator('#scanner-search-results-label')
      .locator('xpath=following-sibling::ul[1]//button')
      .first()
      .click()
    await expect(page.getByText('Checking available versions…')).toHaveCount(0, { timeout: 15_000 })
    const versionGroup = page.getByRole('group', { name: 'Version' })
    if (await versionGroup.isVisible().catch(() => false)) {
      await versionGroup.getByRole('button').first().click()
    }
    await page.getByRole('button', { name: 'Add to batch' }).click()
    await expect(page.getByText('1 card scanned')).toBeVisible({ timeout: 10_000 })
    await armBroadcastCounter(page)
    const other = await openOtherTab(context)

    await switchAndSettle(page, other, { kind: 'sign-in', user: pair.b })

    // No summary of A's batch under B; the intro screen instead — and the unsaved-work registry
    // holds nothing stale that would block a reload or show the leave-sheet.
    await expect.soft(page.getByText(/card scanned/i)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Choose photo' })).toBeVisible({
      timeout: 10_000,
    })
    const blocked = await page.evaluate(async () => {
      const path = '/src/platform/unsaved-work-registry.ts'
      const registry = (await import(/* @vite-ignore */ path)) as {
        hasAnyUnsavedWork: () => boolean
      }
      return registry.hasAnyUnsavedWork()
    })
    expect(blocked).toBe(false)
  })
})
