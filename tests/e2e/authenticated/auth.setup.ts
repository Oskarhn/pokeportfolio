import { test as setup, expect } from '@playwright/test'
import { createServiceClient, createSyntheticUser, type SyntheticUser } from '../../db/setup'

/**
 * P94 §20 — local authenticated E2E infrastructure. This is Playwright's own recommended
 * "setup project" pattern (a real spec file that runs once before the dependent project, not the
 * older `globalSetup` function export): create a real synthetic user through the SAME
 * invitation-issue -> claim -> createUser -> finalize path `tests/db/setup.ts`'s
 * `createSyntheticUser` already uses for every DB/authorization test in this repo (never
 * `auth.admin.createUser` alone — the S2 signup-gate trigger refuses that, by design, docs/
 * SECURITY.md), sign in through the REAL `/login` form (not a hand-constructed localStorage
 * session — Supabase's client-side session storage shape is an implementation detail this test
 * has no business depending on), and save the resulting authenticated browser state for every
 * spec in the `desktop-chromium-authenticated` project to reuse.
 *
 * LOCAL ONLY. Requires:
 *   - a local Supabase stack already running and freshly migrated (`pnpm db:reset`)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY exported in this shell
 *     (`pnpm exec supabase status -o env`), exactly like `pnpm test:db`
 *   - PLAYWRIGHT_AUTHENTICATED_E2E=1, which is what registers this project at all
 *     (playwright.config.ts) — omitted by default so `pnpm test:e2e` never silently requires a
 *     running Supabase stack.
 *
 * The generated credentials are a fresh UUID-derived password for a synthetic, local-only,
 * `@example.invalid` address — never a real account, never printed, never persisted anywhere but
 * this run's own gitignored `playwright/.auth/e2e-user.json`. See auth.teardown.ts for cleanup.
 */

const AUTH_FILE = 'playwright/.auth/e2e-user.json'
const CREDENTIALS_ENV_FILE = 'playwright/.auth/e2e-user-credentials.json'

setup(
  'create a synthetic invite-redeemed user and sign in through the real login form',
  async ({ page }) => {
    const service = createServiceClient()
    const user: SyntheticUser = await createSyntheticUser(service, 'e2e-auth')

    // Persisted so auth.teardown.ts (a separate process/spec) can delete the SAME user without
    // re-deriving it — Playwright teardown projects have no shared in-memory state with setup —
    // and so other authenticated specs can sign in a SECOND client (e.g. to create a real holding
    // fixture through the real add_card_acquisition RPC, never a hand-crafted table insert) without
    // re-deriving credentials either. Same sensitivity as the storageState file itself: a synthetic,
    // local-only, throwaway account whose only reachable database is this machine's own Docker
    // Postgres — gitignored alongside it, never a real credential.
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.mkdir(path.dirname(CREDENTIALS_ENV_FILE), { recursive: true })
    await fs.writeFile(
      CREDENTIALS_ENV_FILE,
      JSON.stringify({ id: user.id, email: user.email, password: user.password }),
    )

    await page.goto('/login')
    await page.getByLabel('Email').fill(user.email)
    await page.getByLabel('Password').fill(user.password)
    await page.getByRole('button', { name: /sign in/i }).click()

    // A successful sign-in navigates to '/' (LoginPage.tsx) — waiting for the URL to leave /login
    // is a real, behavior-level proof of success, not a guess at post-login UI content.
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    await expect(page.getByRole('alert')).toHaveCount(0)

    await page.context().storageState({ path: AUTH_FILE })
  },
)
