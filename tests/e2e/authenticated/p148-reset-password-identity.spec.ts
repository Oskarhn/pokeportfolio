import { expect, test } from '@playwright/test'
import { createAnonClient, type SyntheticUser } from '../../db/setup'
import {
  actInOtherTab,
  createPair,
  deletePair,
  openOtherTab,
  signInThroughForm,
  type Pair,
} from './support/two-tab'

/**
 * P148 - the recovery form's password change is a user-scoped write to the auth service. It is not
 * a data write, so the identity lease of the data layer (D-136) does not reach it: supabase-js's
 * `auth.updateUser` acts for whoever the browser's session belongs to when the request is made.
 *
 * This tab is made deaf to cross-tab auth events (no BroadcastChannel: an older Safari, or simply
 * an event that has not arrived yet), which is the situation the leased token provider already
 * defends every data write against. Another tab signs in as B; the form typed under A is then
 * submitted. B's password must not change.
 */

test.use({ storageState: { cookies: [], origins: [] } })

const NEW_PASSWORD = 'p148 recovery password 91827364'

async function canSignIn(user: SyntheticUser, password: string): Promise<boolean> {
  const { error } = await createAnonClient().auth.signInWithPassword({
    email: user.email,
    password,
  })
  return error === null
}

test.describe('reset-password form: whose password does it change?', () => {
  let pair: Pair | null = null
  test.afterEach(async () => {
    await deletePair(pair)
    pair = null
  })

  test("positive control: with no identity change the signed-in user's own password changes", async ({
    page,
  }) => {
    pair = await createPair('p148-pw-ctl')
    await signInThroughForm(page, pair.a)
    await page.goto('/reset-password')
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Save new password' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/reset-password'), { timeout: 15_000 })
    expect(await canSignIn(pair.a, NEW_PASSWORD)).toBe(true)
    expect(await canSignIn(pair.b, NEW_PASSWORD)).toBe(false)
  })

  test("the browser already holds B's session (this tab never heard): B's password is NOT changed to A's typed value", async ({
    context,
    page,
  }) => {
    pair = await createPair('p148-pw-gap')
    // this tab receives no cross-tab auth events
    await page.addInitScript(() => {
      delete (window as unknown as { BroadcastChannel?: unknown }).BroadcastChannel
    })
    await signInThroughForm(page, pair.a)
    await page.goto('/reset-password')
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD)

    const other = await openOtherTab(context)
    await actInOtherTab(other, { kind: 'sign-in', user: pair.b })
    // the shared browser storage now holds B; this tab's form is still A's
    await page.getByRole('button', { name: 'Save new password' }).click()
    // the outcome is either a message on the form or nothing at all - never a silent change of B
    await expect(page.getByRole('button', { name: /Save new password|Saving/ })).toBeVisible()
    await page.waitForTimeout(1_500)

    expect(await canSignIn(pair.b, NEW_PASSWORD), "B's password was changed by A's form").toBe(
      false,
    )
    expect(
      await canSignIn(pair.a, NEW_PASSWORD),
      "A's password changed although B was current",
    ).toBe(false)
  })
})
