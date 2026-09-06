import { resolveBuildSha } from '../../vite.config'

// P113: parametrized so an isolated worktree can run its own E2E suite on a non-default port
// without ever reaching a concurrently-running session's server on the default port — the exact
// stale-server risk this file's own guard exists to catch, just avoided proactively instead of
// only detected after the fact. Defaults to 4173 (unchanged behavior for every existing caller).
const PREVIEW_PORT = process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173'
const PREVIEW_BASE_URL = `http://localhost:${PREVIEW_PORT}`

/**
 * P106 build-isolation hardening. `playwright.config.ts`'s production-preview webServer sets
 * `reuseExistingServer: !process.env.CI` — correct for fast local iteration, but it means a
 * LOCAL run silently reuses whatever is already answering on port 4173 without ever invoking
 * `pnpm build` again. Reproduced directly this session: a worktree's own `pnpm exec playwright
 * test` run failed with a confusing "dist/assets not found" (the test's own dist, correctly
 * absent after a deliberate clean) even though a server clearly answered the webServer readiness
 * probe — the answering server belonged to a DIFFERENT build than the one this run's own
 * `dist/assets` reflected. Left unguarded, that class of mismatch degrades into dozens of
 * unrelated-looking failures ("heading not found", stale copy, wrong feature flags) with no hint
 * that the whole run was pointed at the wrong build.
 *
 * This global setup runs once, after the webServer's own readiness probe succeeds and before any
 * test executes, and asks the SAME question `src/platform/build-freshness-runtime.ts` already
 * asks in production (`/build-meta.json`, `no-store`) — except here the comparison is against
 * `resolveBuildSha()` computed FRESH, right now, in this process, from this worktree's own git
 * state (the exact function `vite.config.ts` uses to stamp the build it just produced). A
 * mismatch means the server is not this build — most likely a stale `pnpm preview` left running
 * from a different worktree or an earlier build in this same directory — and the whole run is
 * aborted immediately with one specific, attributable diagnostic instead of a wall of unrelated
 * page-content assertion failures.
 *
 * Deliberately silent (not a hard requirement) when `/build-meta.json` is unreachable or has no
 * `sha` field: a run that only exercises the authenticated project (Vite's dev server on 4174,
 * which never emits this build-time artifact) has nothing to check here.
 */
export default async function globalSetup(): Promise<void> {
  const expectedSha = resolveBuildSha()
  let response: Response
  try {
    response = await fetch(`${PREVIEW_BASE_URL}/build-meta.json`, { cache: 'no-store' })
  } catch {
    return // production-preview server not in use by this run — nothing to guard
  }
  if (!response.ok) return
  const meta = (await response.json().catch(() => null)) as { sha?: string } | null
  if (!meta || typeof meta.sha !== 'string') return

  if (meta.sha !== expectedSha) {
    throw new Error(
      `E2E build-identity mismatch: ${PREVIEW_BASE_URL}/build-meta.json reports build ` +
        `"${meta.sha}", but this worktree's own fresh build should be "${expectedSha}". ` +
        `Playwright's webServer (reuseExistingServer, local-only) connected to a STALE server — ` +
        `most likely one left running from a different worktree or an earlier build in this same ` +
        `directory — instead of running this worktree's own "pnpm build && pnpm preview". Find ` +
        `and stop whatever is listening on port 4173 (Windows: ` +
        `"netstat -ano | findstr :4173" then "taskkill /PID <pid> /F"; POSIX: ` +
        `"lsof -i :4173" then "kill <pid>") and re-run. Left unguarded, every unrelated test in ` +
        `this run would otherwise fail against the wrong build with no hint why.`,
    )
  }
}
