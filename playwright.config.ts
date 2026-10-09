import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertLocalTestTarget } from './tests/support/local-target.ts'

// P94 §20-22: local-authenticated-E2E infrastructure. Set when a caller wants the
// `*-authenticated` project to run at all — see docs/TESTING.md §6a. Absent by
// default so `pnpm test:e2e` on a machine with no local Supabase stack running still exercises
// the placeholder-backend suite exactly as before; nothing here changes unauthenticated behavior.
const AUTHENTICATED_E2E_ENABLED = process.env.PLAYWRIGHT_AUTHENTICATED_E2E === '1'
// P203: every Playwright run builds or serves the app against VITE_SUPABASE_URL, and the
// authenticated project also creates and deletes users through SUPABASE_URL / DB_URL. Evaluated
// when the config loads, so a hosted target aborts before a browser or a fixture exists.
assertLocalTestTarget(process.env)
const AUTH_STATE_FILE = 'playwright/.auth/e2e-user.json'
// P113: overridable so an isolated worktree (e.g. a parallel chaos-hardening session) never binds
// the same port as another session's own preview server — see global-setup.ts. Defaults to 4173,
// unchanged for every existing caller.
const PREVIEW_PORT = process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173'

export default defineConfig({
  testDir: './tests/e2e',
  // P106: aborts the whole run immediately, with one specific diagnostic, if the production-
  // preview webServer's reuseExistingServer connected to a stale server from a different build
  // (a different worktree, or an earlier build left running in this same directory) instead of
  // this run's own fresh one — see global-setup.ts's own header for the real failure this
  // reproduces and closes.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${PREVIEW_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: '**/authenticated/**',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-iphone',
      testIgnore: '**/authenticated/**',
      use: { ...devices['iPhone 14'] },
    },
    // P94 §20-22: local-authenticated-E2E infrastructure — a REAL local Supabase stack, a real
    // synthetic invite-redeemed user, a real sign-in through the real login form, and real
    // per-test data (a real holding to prefill Sale Add against, etc). Only registered when
    // PLAYWRIGHT_AUTHENTICATED_E2E=1 — see docs/TESTING.md §6a for exactly how to
    // run it and why it is opt-in (needs `pnpm db:reset` + exported Supabase env vars first).
    ...(AUTHENTICATED_E2E_ENABLED
      ? [
          {
            name: 'setup',
            testDir: './tests/e2e/authenticated',
            testMatch: /auth\.setup\.ts/,
            use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4174' },
          },
          {
            name: 'teardown',
            testDir: './tests/e2e/authenticated',
            testMatch: /auth\.teardown\.ts/,
            use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4174' },
          },
          {
            name: 'desktop-chromium-authenticated',
            testDir: './tests/e2e/authenticated',
            testIgnore: /auth\.(setup|teardown)\.ts/,
            dependencies: ['setup'],
            teardown: 'teardown',
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1440, height: 900 },
              baseURL: 'http://localhost:4174',
              storageState: AUTH_STATE_FILE,
            },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: `pnpm build && pnpm preview --port ${PREVIEW_PORT}`,
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      // The bundle needs *some* Supabase configuration to start — src/data/supabase-client.ts
      // refuses to run without it. Deliberately a placeholder that resolves to nothing: the E2E
      // suite covers routing, guards, form semantics and layout, and every network call failing
      // identically is what makes those assertions deterministic. Real auth flows are exercised
      // against a live stack in tests/authorization/, and (for real UI-driven authenticated forms)
      // the authenticated project below — not this server.
      env: {
        VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY:
          process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'e2e-placeholder-not-a-key',
      },
    },
    // P94 §20-22: a SECOND, independent server — Vite's own dev server (not a production
    // build+preview), so it can point at a REAL local Supabase backend without needing a
    // separate build output directory (a production build's env vars are baked in at build time,
    // and the placeholder server above already owns the one `dist/` this repo builds). Only
    // started when the authenticated project is registered, and only reachable by it
    // (`baseURL: 'http://localhost:4174'` above) — the placeholder-backend suite above is
    // completely unaffected either way.
    ...(AUTHENTICATED_E2E_ENABLED
      ? [
          {
            command: 'pnpm exec vite --port 4174 --strictPort',
            url: 'http://localhost:4174',
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
            env: {
              VITE_SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321',
              VITE_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_ANON_KEY ?? '',
            },
          },
        ]
      : []),
    // P189: the erasure registry the DEPLOYED delete-account function records to (the stack hands it
    // ERASURE_REGISTRY_URL / _TOKEN at start). Without a reachable registry every deletion is refused
    // (503 deletion_unavailable) by design, so the real-browser deletion specs need this running.
    // The same stable file as tests/db/global-setup.ts uses, so the database's receipts and the
    // registry never disagree between suites.
    ...(AUTHENTICATED_E2E_ENABLED &&
    process.env.ERASURE_REGISTRY_URL &&
    process.env.ERASURE_REGISTRY_TOKEN &&
    process.env.ERASURE_REGISTRY_KEY
      ? [
          {
            command: `pnpm exec tsx scripts/restore-gate/registry-sink.ts --registry "${join(tmpdir(), `p189-erasure-registry-${new URL(process.env.ERASURE_REGISTRY_URL).port}.ndjson`)}" --port ${new URL(process.env.ERASURE_REGISTRY_URL).port} --host 0.0.0.0`,
            port: Number(new URL(process.env.ERASURE_REGISTRY_URL).port),
            reuseExistingServer: true,
            timeout: 30_000,
            env: {
              ERASURE_SINK_TOKEN: process.env.ERASURE_REGISTRY_TOKEN,
              ERASURE_REGISTRY_KEY: process.env.ERASURE_REGISTRY_KEY,
            },
          },
        ]
      : []),
  ],
})
