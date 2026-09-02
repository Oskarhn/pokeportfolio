/**
 * Local-build APP_BUILD_SHA dirty-worktree marker (P87 F-43).
 *
 * P86's audit found `resolveBuildSha`'s local fallback trusted `git rev-parse HEAD` with no
 * `git status --porcelain` check — a developer running a local build with uncommitted changes got
 * an `APP_BUILD_SHA` naming a commit that does not contain the edit under test, exactly the
 * "which commit is this actually running" confusion D-100 exists to eliminate. Production
 * (`CF_PAGES_COMMIT_SHA`) is unaffected and asserted separately below.
 *
 * `node:child_process` is mocked so this test never depends on (or is flaky against) this
 * repository's OWN real working-tree state at test-run time.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const execSyncMock = vi.fn<(...args: unknown[]) => string>()
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]): string => execSyncMock(...args),
}))

describe('resolveBuildSha (P83/D-100, hardened P87 F-43)', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    delete process.env.CF_PAGES_COMMIT_SHA
  })

  it('CF_PAGES_COMMIT_SHA is always authoritative in production and never dirty-suffixed', async () => {
    process.env.CF_PAGES_COMMIT_SHA = 'abc123deadbeef'
    const { resolveBuildSha } = await import('../../vite.config.ts')
    expect(resolveBuildSha()).toBe('abc123deadbeef')
    // git is never even consulted when the Pages env var is present.
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('a clean local worktree reports the bare commit sha, no suffix', async () => {
    execSyncMock.mockImplementation((...args) => {
      const cmd = args[0]
      if (cmd === 'git rev-parse HEAD') return 'aaaa111122223333444455556666777788889999\n'
      if (cmd === 'git status --porcelain') return ''
      throw new Error(`unexpected command: ${String(cmd)}`)
    })
    const { resolveBuildSha } = await import('../../vite.config.ts')
    expect(resolveBuildSha()).toBe('aaaa111122223333444455556666777788889999')
  })

  it('a dirty local worktree appends +dirty — the P87 F-43 fix', async () => {
    execSyncMock.mockImplementation((...args) => {
      const cmd = args[0]
      if (cmd === 'git rev-parse HEAD') return 'aaaa111122223333444455556666777788889999\n'
      if (cmd === 'git status --porcelain') return ' M src/App.tsx\n?? scratch.txt\n'
      throw new Error(`unexpected command: ${String(cmd)}`)
    })
    const { resolveBuildSha } = await import('../../vite.config.ts')
    expect(resolveBuildSha()).toBe('aaaa111122223333444455556666777788889999+dirty')
  })

  it('falls back to "unknown" when git itself is unavailable, never throws', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('git: command not found')
    })
    const { resolveBuildSha } = await import('../../vite.config.ts')
    expect(resolveBuildSha()).toBe('unknown')
  })
})
