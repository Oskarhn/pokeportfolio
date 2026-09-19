import { createClient } from '@supabase/supabase-js'
import { test, expect, type Page } from '@playwright/test'
import {
  createInvitationDirect,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type SyntheticUser,
} from '../../db/setup'

/**
 * P143 — the identity boundary remounts the whole authenticated subtree when the user id changes,
 * and the two flows that CREATE a session from a public page (invitation redemption and the
 * password-recovery landing) are exactly where that remount happens mid-flow: the page that is
 * driving the sign-in is itself replaced. These specs prove both still complete, against a real
 * GoTrue and the real `redeem-invitation` Edge Function.
 *
 * The invitation flow doubles as the most REALISTIC direct A -> B: `/invite/$token` is not wrapped
 * in `RedirectIfSignedIn`, so a person who is signed in as A in one tab can redeem an invitation in
 * another; supabase-js then broadcasts `SIGNED_IN(B)` to the first tab (P130-23's own description
 * of the path).
 */

test.use({ storageState: { cookies: [], origins: [] } })

const supabaseUrl = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
// Generated per run (the local stack is disposable); never a fixed credential in the repository.
const NEW_PASSWORD = `p143-${crypto.randomUUID()}`

const createdEmails: string[] = []
let disposable: SyntheticUser[] = []

test.afterEach(async () => {
  const service = createServiceClient()
  for (const user of disposable) await deleteSyntheticUser(service, user.id)
  disposable = []
  if (createdEmails.length > 0) {
    const { data } = await service.auth.admin.listUsers({ perPage: 200 })
    for (const listed of data.users) {
      if (listed.email !== undefined && createdEmails.includes(listed.email)) {
        await deleteSyntheticUser(service, listed.id)
      }
    }
    createdEmails.length = 0
  }
})

async function redeemThroughUi(page: Page, token: string, password: string): Promise<void> {
  await page.goto(`/invite/${token}`)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

test.describe('P143 — session-creating public flows survive the identity remount', () => {
  test('invitation redemption (signed out) completes: signed in as the new user, on Home', async ({
    page,
  }) => {
    const service = createServiceClient()
    const invitation = await createInvitationDirect(service)
    createdEmails.push(invitation.email)

    await redeemThroughUi(page, invitation.token, NEW_PASSWORD)

    await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 })
    await page.getByRole('link', { name: 'Profile' }).first().click()
    await expect(page.getByText(invitation.email)).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test("redeeming an invitation in a second tab while A is signed in: A's tab is reset for the new user, and the second tab completes", async ({
    context,
    page,
  }) => {
    const service = createServiceClient()
    const a = await createSyntheticUser(service, 'p143-entry-a')
    disposable.push(a)
    await page.goto('/login')
    await page.getByLabel('Email').fill(a.email)
    await page.getByLabel('Password').fill(a.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    await page.goto('/purchases/new')
    await page.getByLabel('Notes').fill('A-ONLY-p143-entry-marker')
    await page.getByLabel('Shipping').fill('777')
    await page.evaluate((key) => {
      const w = window as unknown as { __p143Deliveries: number }
      w.__p143Deliveries = 0
      new BroadcastChannel(key).addEventListener('message', () => {
        w.__p143Deliveries += 1
      })
    }, STORAGE_KEY)

    const invitation = await createInvitationDirect(service)
    createdEmails.push(invitation.email)
    const second = await context.newPage()
    await redeemThroughUi(second, invitation.token, NEW_PASSWORD)
    await second.waitForURL((url) => url.pathname === '/', { timeout: 20_000 })
    await page.waitForFunction(
      () => (window as unknown as { __p143Deliveries: number }).__p143Deliveries > 0,
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve()
            })
          })
        }),
    )

    // Soft, so a survival failure is reported next to the positive control below.
    await expect.soft(page.getByLabel('Notes')).toHaveValue('')
    await expect.soft(page.getByLabel('Shipping')).toHaveValue('')
    // Control: the FIRST tab acts as the invited user now.
    await page.getByRole('link', { name: 'Profile' }).first().click()
    await expect(page.getByText(invitation.email)).toBeVisible()
    await expect(page.getByText(a.email)).toHaveCount(0)
  })

  test('recovery-link landing: the session from the URL fragment is established, the new password is saved, and the flow ends on Home', async ({
    page,
  }) => {
    const service = createServiceClient()
    const user = await createSyntheticUser(service, 'p143-recovery')
    disposable.push(user)
    // A real session for the user, taken in Node and handed to the page the way a recovery link's
    // fragment hands one over (supabase-js `detectSessionInUrl`).
    const anonKey = process.env.SUPABASE_ANON_KEY ?? ''
    const node = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await node.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    })
    expect(error).toBeNull()
    const session = data.session
    if (session === null) throw new Error('no session for the recovery landing')

    await page.goto(
      `/reset-password#access_token=${session.access_token}&refresh_token=${session.refresh_token}` +
        `&expires_in=3600&token_type=bearer&type=recovery`,
    )
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Save new password' }).click()

    await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 })
    await page.getByRole('link', { name: 'Profile' }).first().click()
    await expect(page.getByText(user.email)).toBeVisible()
    // The new password really was set.
    const again = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const signIn = await again.auth.signInWithPassword({
      email: user.email,
      password: NEW_PASSWORD,
    })
    expect(signIn.error).toBeNull()
  })
})
