import { test, expect } from '@playwright/test'

/**
 * Browser coverage of the auth surface, deliberately scoped to what is deterministic without a
 * Supabase project (docs/TESTING.md §6). The preview server is built against a placeholder
 * Supabase URL, so every network call fails the same way every time — which is enough to exercise
 * routing, guards, form semantics, error states and the mobile layout, and keeps public CI free of
 * any dependency on remote credentials.
 *
 * What is *not* here: a real sign-in, and a real redemption. Those need a live stack and are
 * covered against one in tests/authorization/, which is also where the security assertions belong
 * — the browser is not what enforces any of them.
 */

test.describe('routing and guards', () => {
  test('an anonymous visit to the app lands on sign-in', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('the admin route is not reachable without a session', async ({ page }) => {
    await page.goto('/admin/invitations')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Invitations' })).toHaveCount(0)
  })

  test('the catalog route is not reachable without a session', async ({ page }) => {
    await page.goto('/catalog')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Catalog' })).toHaveCount(0)
  })

  test('a catalog card detail deep link is not reachable without a session', async ({ page }) => {
    await page.goto('/catalog/00000000-0000-0000-0000-000000000000')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('the Portfolio route is not reachable without a session', async ({ page }) => {
    await page.goto('/portfolio')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Portfolio' })).toHaveCount(0)
  })

  test('a Portfolio holding deep link is not reachable without a session', async ({ page }) => {
    await page.goto('/portfolio/00000000-0000-0000-0000-000000000000')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('the manual-card route is not reachable without a session', async ({ page }) => {
    await page.goto('/portfolio/manual/new')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Add a card manually' })).toHaveCount(0)
  })

  test('the add-to-collection route is not reachable without a session', async ({ page }) => {
    await page.goto('/add?variantId=00000000-0000-0000-0000-000000000000')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('the Profile route is not reachable without a session', async ({ page }) => {
    await page.goto('/profile')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('the export/backup route is not reachable without a session (M13)', async ({ page }) => {
    await page.goto('/profile/export')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Export & backup' })).toHaveCount(0)
  })

  test('the Purchases route is not reachable without a session', async ({ page }) => {
    await page.goto('/purchases')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Purchases' })).toHaveCount(0)
  })

  test('the new-purchase route is not reachable without a session', async ({ page }) => {
    await page.goto('/purchases/new')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Record purchase' })).toHaveCount(0)
  })

  test('a purchase detail deep link is not reachable without a session', async ({ page }) => {
    await page.goto('/purchases/00000000-0000-0000-0000-000000000000')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('a purchase edit deep link is not reachable without a session', async ({ page }) => {
    await page.goto('/purchases/00000000-0000-0000-0000-000000000000/edit')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('legacy /more redirects to /profile, which is not reachable without a session (M7.1)', async ({
    page,
  }) => {
    await page.goto('/more')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test.describe('legacy /collection links redirect to /portfolio (M7)', () => {
    test('/collection redirects', async ({ page }) => {
      await page.goto('/collection')
      await expect(page).toHaveURL(/\/login$/)
    })

    test('/collection/$holdingId redirects, preserving the id', async ({ page }) => {
      await page.goto('/collection/00000000-0000-0000-0000-000000000000')
      // Redirected to /portfolio/$holdingId, then bounced to sign-in because there is no session —
      // the id survives the rename either way, which is the point of the redirect.
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    })

    test('/collection/manual/new redirects', async ({ page }) => {
      await page.goto('/collection/manual/new')
      await expect(page).toHaveURL(/\/login$/)
    })
  })

  test('there is no way to create an account from the sign-in screen', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText(/create account/i)).toHaveCount(0)
    await expect(page.getByText(/sign up/i)).toHaveCount(0)
    await expect(page.getByText(/invite-only/i)).toBeVisible()
  })
})

test.describe('sign-in form', () => {
  test('carries the attributes a password manager needs', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username')
    await expect(page.getByLabel('Password')).toHaveAttribute('autocomplete', 'current-password')
    await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email')
  })

  test('reveals and re-hides the password without clearing it', async ({ page }) => {
    await page.goto('/login')
    const password = page.getByLabel('Password')
    await password.fill('a-typed-password')
    await expect(password).toHaveAttribute('type', 'password')

    await page.getByRole('button', { name: 'Show' }).click()
    await expect(password).toHaveAttribute('type', 'text')
    await expect(password).toHaveValue('a-typed-password')

    await page.getByRole('button', { name: 'Hide' }).click()
    await expect(password).toHaveAttribute('type', 'password')
  })

  test('reports a failed sign-in without saying which half was wrong', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('nobody@example.invalid')
    await page.getByLabel('Password').fill('not-the-right-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 15_000 })
    await expect(alert).toHaveText(/did not work/i)
    await expect(alert).not.toHaveText(/no such|not found|unknown user/i)
  })
})

test.describe('invitation redemption', () => {
  test('an unusable invitation says so and offers the way forward', async ({ page }) => {
    await page.goto('/invite/this-token-was-never-issued-anywhere-at-all')
    await expect(page.getByRole('heading', { name: 'Invitation unavailable' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible()
  })
})

test.describe('password recovery', () => {
  test('the request form answers the same way regardless of the address', async ({ page }) => {
    await page.goto('/forgot-password')
    await page.getByLabel('Email').fill('someone@example.invalid')
    await page.getByRole('button', { name: 'Send recovery link' }).click()
    await expect(page.getByRole('alert')).toContainText(/if that address has an account/i)
  })

  test('a reset link that established no session is reported as unusable', async ({ page }) => {
    await page.goto('/reset-password')
    await expect(page.getByRole('heading', { name: 'Recovery link unavailable' })).toBeVisible()
  })
})

test.describe('layout', () => {
  test('the sign-in screen does not scroll sideways', async ({ page }) => {
    await page.goto('/login')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  // Companion to the sideways check, and worth stating plainly: this would NOT have caught the
  // defect that prompted it. An installed iPhone PWA let the sign-in form be scrolled entirely off
  // the top, because `min-h-dvh` sizes the shell to the largest viewport while the visible area was
  // smaller. Chromium resolves dvh, svh and the visual viewport to the same number, so this assertion
  // passed throughout. It is here because "the sign-in screen fits on the screen" is an invariant
  // worth holding on every viewport the suite runs, not because it guards that bug — the guard for
  // that one is a person with a phone.
  test('the sign-in screen fits the viewport without scrolling', async ({ page }) => {
    await page.goto('/login')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })

  test('interactive controls clear a 44px touch target', async ({ page }) => {
    await page.goto('/login')
    const box = await page.getByRole('button', { name: 'Sign in' }).boundingBox()
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  })
})
