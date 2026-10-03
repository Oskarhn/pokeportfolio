import { test, expect, type Page } from '@playwright/test'
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  signInAs,
  type SyntheticUser,
} from '../../db/setup'
import { countOwnedRows, seedAccountLedger } from '../../db/lib/account-ledger-fixture'

/**
 * P152 — Settings → Delete account, through a real browser against the real local stack and the
 * deployed delete-account function. Uses its own disposable users and an empty storage state (the
 * shared e2e-auth user every other spec inherits must never be deleted — same hazard P112 recorded
 * for sign-out).
 */

test.use({ storageState: { cookies: [], origins: [] } })

async function signInThroughForm(page: Page, user: SyntheticUser) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
}

async function authUserExists(id: string): Promise<boolean> {
  const { data } = await createServiceClient().auth.admin.getUserById(id)
  return Boolean(data.user)
}

test.describe('Settings → Delete account', () => {
  const users: SyntheticUser[] = []

  async function newUser(label: string, seed: boolean): Promise<SyntheticUser> {
    const service = createServiceClient()
    const user = await createSyntheticUser(service, label)
    users.push(user)
    if (seed) await seedAccountLedger(service, user, await signInAs(user), label)
    return user
  }

  test.afterEach(async () => {
    const service = createServiceClient()
    for (const user of users.splice(0)) {
      await service.from('account_deletion_requests').delete().eq('user_id', user.id)
      await deleteSyntheticUser(service, user.id)
    }
  })

  test('explains consequences, refuses a wrong password, and deletes only the signed-in account', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const a = await newUser('e2e-del-a', true)
    const bystander = await newUser('e2e-del-b', true)
    const service = createServiceClient()
    const bystanderBefore = await countOwnedRows(service, bystander.id)

    await signInThroughForm(page, a)
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Delete account…' }).click()

    const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
    await expect(dialog).toBeVisible()
    // The account being deleted is named, and the honest limits are stated.
    await expect(dialog).toContainText(a.email)
    await expect(dialog).toContainText('cannot be undone')
    await expect(dialog).toContainText('Deleted right away')
    await expect(dialog).toContainText('backups')
    await expect(dialog).toContainText('may still contain your data')
    await expect(dialog.getByRole('link', { name: /Export/ })).toBeVisible()

    // Nothing can be submitted without both the password and the acknowledgement.
    const confirm = dialog.getByRole('button', { name: 'Permanently delete account' })
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel('Your password').fill('definitely-not-my-password')
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel(/I understand this is permanent/).check()
    await expect(confirm).toBeEnabled()

    // Wrong password: refused, and everything is still there.
    await confirm.click()
    // Generous: the first call to the function boots its edge worker, and under the full parallel
    // suite that cold start can take several seconds (about 1 s when run alone).
    await expect(dialog.getByRole('alert')).toContainText('not correct', { timeout: 30_000 })
    expect(await authUserExists(a.id)).toBe(true)
    expect((await countOwnedRows(service, a.id)).purchases).toBeGreaterThan(0)
    // The password field was cleared: a retry needs a freshly typed password.
    await expect(dialog.getByLabel('Your password')).toHaveValue('')

    // Right password.
    await dialog.getByLabel('Your password').fill(a.password)
    await confirm.click()

    // Signed out, back on the sign-in page, told plainly.
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 30_000 })
    await expect(page.getByText('Your account has been deleted.')).toBeVisible()

    // Server side: A is gone entirely, the bystander is byte-for-byte as many rows as before.
    expect(await authUserExists(a.id)).toBe(false)
    const after = await countOwnedRows(service, a.id)
    for (const [table, n] of Object.entries(after)) expect(n, table).toBe(0)
    expect(await countOwnedRows(service, bystander.id)).toEqual(bystanderBefore)
    expect(await authUserExists(bystander.id)).toBe(true)

    // This browser no longer holds A's session or anything keyed to A.
    const leftovers = await page.evaluate((userId) => {
      const keys = Object.keys(window.localStorage)
      return {
        sessionKeys: keys.filter((k) => k.endsWith('-auth-token')),
        userKeys: keys.filter((k) => k.includes(userId)),
      }
    }, a.id)
    expect(leftovers.userKeys).toEqual([])
    expect(leftovers.sessionKeys).toEqual([])

    // A can never sign in again.
    await page.getByLabel('Email').fill(a.email)
    await page.getByLabel('Password').fill(a.password)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page.getByText('did not work')).toBeVisible()
  })

  test('a confirmation opened for A closes, sends nothing and deletes nobody when the session becomes B', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000)
    const a = await newUser('e2e-switch-a', true)
    const b = await newUser('e2e-switch-b', true)
    const service = createServiceClient()

    const deleteRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/functions/v1/delete-account')) deleteRequests.push(request.url())
    })

    await signInThroughForm(page, a)
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Delete account…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
    await expect(dialog).toContainText(a.email)
    await dialog.getByLabel('Your password').fill(a.password)
    await dialog.getByLabel(/I understand this is permanent/).check()
    await expect(dialog.getByRole('button', { name: 'Permanently delete account' })).toBeEnabled()

    // Another tab signs in as B. supabase-js announces that to every other tab over a
    // BroadcastChannel as SIGNED_IN — a direct A→B replacement with no signed-out step between.
    const bSession = (await (await signInAs(b)).auth.getSession()).data.session
    expect(bSession).not.toBeNull()
    const otherTab = await context.newPage()
    await otherTab.goto('/faq')
    await otherTab.evaluate((session) => {
      const storageKey = Object.keys(window.localStorage).find((k) => k.endsWith('-auth-token'))
      if (!storageKey) throw new Error('no auth storage key found')
      window.localStorage.setItem(storageKey, JSON.stringify(session))
      const channel = new BroadcastChannel(storageKey)
      channel.postMessage({ event: 'SIGNED_IN', session })
      channel.close()
    }, bSession)
    await otherTab.close()

    // The confirmation that was opened for A is gone; it never became B's. Since P143 an identity
    // change remounts the whole authenticated subtree, so the section's own "the account changed"
    // note is lost with it — the safety property (nothing open, nothing sent, nobody deleted) is
    // what is asserted, not the note.
    await expect(dialog).toBeHidden()
    expect(deleteRequests).toEqual([])
    expect(await authUserExists(a.id)).toBe(true)
    expect(await authUserExists(b.id)).toBe(true)
    expect((await countOwnedRows(service, b.id)).purchases).toBeGreaterThan(0)
    expect((await countOwnedRows(service, a.id)).purchases).toBeGreaterThan(0)

    // Reopening now is a new confirmation for the CURRENT account (B), not a resurrected one for A.
    await page.getByRole('button', { name: 'Delete account…' }).click()
    const reopened = page.getByRole('dialog', { name: 'Delete your account?' })
    await expect(reopened).toContainText(b.email)
    await expect(reopened).not.toContainText(a.email)
    await expect(reopened.getByLabel('Your password')).toHaveValue('')
    await expect(
      reopened.getByRole('button', { name: 'Permanently delete account' }),
    ).toBeDisabled()
  })
})
