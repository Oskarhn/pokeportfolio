import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * P203: scripts/ci/collect-diagnostics.mjs runs under `if: failure()` in db-tests. It must never
 * turn a red job into a differently-red one, whether or not Docker is present, so the contract
 * tested here is "always exits 0 and always leaves containers.txt". What it collects from a live
 * stack was verified by running it against an isolated local stack (see the PR description).
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('scripts/ci/collect-diagnostics.mjs', () => {
  it('exits 0 and writes containers.txt when nothing matches the filter', () => {
    const out = mkdtempSync(join(tmpdir(), 'p203-diag-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/ci/collect-diagnostics.mjs',
          '--out',
          out,
          '--filter',
          'no-such-container-p203-test',
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
      )
      expect(result.status).toBe(0)
      expect(existsSync(join(out, 'containers.txt'))).toBe(true)
      // Either docker listed nothing (empty file) or docker is missing (says so) — never a crash.
      const text = readFileSync(join(out, 'containers.txt'), 'utf8')
      expect(text === '' || text.startsWith('docker unavailable')).toBe(true)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 90_000)
})
