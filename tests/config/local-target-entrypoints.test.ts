import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPsql } from '../../scripts/lib/psql-exec.mjs'
import { NonLocalTargetError } from '../support/local-target'
import { createAnonClient, createServiceClient } from '../db/setup'
import { HeldLockSession } from '../db/lib/held-lock-session'
import { runRawSqlAsync } from '../db/raw-sql'

/**
 * P206: the entrypoint half of the destructive-target guard (the policy and the test runners are in
 * local-target-guard.test.ts).
 *
 * A guard that is only tested as a function can be bypassed by an entrypoint that never calls it.
 * This file therefore (1) classifies EVERY tool under scripts/ that can reach a service-role key or a
 * direct Postgres connection, so a new tool fails here until someone decides how it is guarded;
 * (2) proves the shared harness helpers refuse a hosted target when they are called; and (3) starts
 * each guarded tool as a real process against a hosted-looking address and requires it to exit with
 * the guard's message before any network traffic.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const run = promisify(execFile)

// Fake project reference on a reserved TLD: if a guard ever regressed, the process would fail on name
// resolution of a host that cannot exist, never reach a real project.
const HOSTED_API = 'https://abcdefghijklmnopqrst.supabase.invalid'
const HOSTED_DB =
  'postgresql://postgres:not-a-real-password@db.abcdefghijklmnopqrst.supabase.invalid:5432/postgres'

/** Tools that call `assertLocalTestTarget(process.env)` themselves, before any client exists. */
const DIRECT = [
  'scripts/p132b/deadlock-campaign.ts',
  'scripts/p189/seed-synthetic-account.ts',
  'scripts/portfolio-perf-benchmark.mjs',
  'scripts/portfolio-snapshots-benchmark.mjs',
  'scripts/release-rehearsal/delete-account-rehearsal.ts',
  'scripts/release-rehearsal/seed-db104.ts',
] as const

/** Tools whose only route to the service role is `createServiceClient()` from the guarded harness. */
const VIA_HARNESS = [
  'scripts/p117-atomicity-check.ts',
  'scripts/p117-inventory-race.ts',
  'scripts/p117-money-boundary.ts',
  'scripts/p117-purchase-idempotency-stress.ts',
  'scripts/p120-cleanup-scale.ts',
  'scripts/p120-money-boundary-callers.ts',
  'scripts/p120-purchase-property-fuzz.ts',
  'scripts/p120-rls-hostile-fuzz.ts',
  'scripts/p123-sale-property-fuzz.ts',
] as const

/**
 * Shared modules that carry the guard for their callers (checked separately below).
 */
const GUARDED_LIBRARIES = ['scripts/lib/psql-exec.mjs', 'scripts/lib/local-target.mjs'] as const

/**
 * Tools that mention a backend variable but are deliberately NOT local-only. Each reason is the
 * reviewable decision; a tool that mutates data must never be listed here.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'scripts/scanner-visual-index/build-index.ts':
    'read-only catalog export; --target=hosted is the point (D-097), local is the default demo stack',
  'scripts/scanner-visual-index/verify-index.ts': 'reads generated files; no backend writes',
  'scripts/scanner-visual-index/stage-index-assets.mjs': 'copies files; no backend access',
  'scripts/scanner-visual-index/seed-local-demo-catalog.mjs':
    'connects only to the fixed local address postgresql://…@127.0.0.1:54322 by construction',
  'scripts/scanner-name-lexicon/build-lexicon.ts':
    'read-only catalog export from the hosted project',
  'scripts/scanner-recognition-lab/f03/real-hosted-benchmark.ts':
    'read-only benchmark of the hosted catalog by design',
  'scripts/scanner-visual-benchmark/browser-cold-start.mjs': 'browser timing; no backend writes',
  'scripts/verify-scanner-platform-build.mjs': 'inspects a built bundle; no backend access',
  'scripts/check-dist-secrets.mjs': 'scans build output for secret shapes',
  'scripts/deployment-check.mjs': 'read-only probe of a deployed site',
  'scripts/remote-security-check.mjs':
    "owner-run probe of the hosted project with the owner's own credentials; not a test suite",
  'scripts/lib/release-config-check.mjs': 'pure configuration analysis',
  'scripts/lib/public-env-guard.mjs': 'public-variable scanner',
  'scripts/p165/edge-harness/harness.mjs': 'Deno stub harness; SUPABASE_URL is a .invalid stub',
  'scripts/p165/mutants.mjs': 'rewrites test source text; no backend access',
  'scripts/p197d/cors-harness.mjs': 'Deno stub harness; SUPABASE_URL is a .invalid stub',
  'scripts/restore-gate/deletion-proof-core.ts':
    'owner-operated Production deletion proof (P197B); Production by design',
  'scripts/restore-gate/owner-deletion-proof.ts':
    'owner-operated Production deletion proof (P197B); Production by design',
}

const TRIGGER = /SUPABASE_SERVICE_ROLE_KEY|createServiceClient|\bDB_URL\b|auth\.admin\./

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|mjs)$/.test(name) && !name.endsWith('.d.mts')) out.push(full)
  }
  return out
}

const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

describe('every tool that can reach a service-role key or a direct database is classified', () => {
  const found = walk(join(repoRoot, 'scripts'))
    .map((file) => relative(repoRoot, file).replaceAll('\\', '/'))
    .filter((rel) => TRIGGER.test(read(rel)))

  const classified = new Set<string>([
    ...DIRECT,
    ...VIA_HARNESS,
    ...GUARDED_LIBRARIES,
    ...Object.keys(EXEMPT),
  ])

  it('has no unclassified tool (add it to DIRECT, VIA_HARNESS or, with a reason, EXEMPT)', () => {
    expect(found.filter((rel) => !classified.has(rel))).toEqual([])
  })

  it('names only files that exist and still match', () => {
    for (const rel of classified) expect(existsSync(join(repoRoot, rel)), rel).toBe(true)
  })

  it.each(DIRECT)('%s calls the shared guard before anything else', (rel) => {
    const source = read(rel)
    expect(source).toContain('assertLocalTestTarget(process.env)')
    expect(source).toContain('local-target.mjs')
  })

  it.each(VIA_HARNESS)('%s gets its service client from the guarded harness', (rel) => {
    const source = read(rel)
    expect(source).toContain('createServiceClient')
    expect(source).toMatch(/from '\.\.\/tests\/db\/setup'/)
  })

  it('no exempt tool writes through createServiceClient or the Auth admin API', () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(read(rel), rel).not.toMatch(/createServiceClient|auth\.admin\./)
    }
  })

  it('no per-script loopback regex remains next to the shared guard', () => {
    for (const rel of [...DIRECT, ...VIA_HARNESS]) {
      expect(read(rel), rel).not.toMatch(/\^http:\\\/\\\/\(127/)
    }
  })

  it('the P200 duplicate guard module is gone: there is exactly one definition of "local"', () => {
    expect(existsSync(join(repoRoot, 'scripts/lib/local-stack-guard.mjs'))).toBe(false)
  })

  it('psql-exec guards every path, not only the docker fallback', () => {
    const source = read('scripts/lib/psql-exec.mjs')
    expect(source).toContain("assertLocalUrl('DB_URL', dbUrl)")
    expect(source).not.toContain('got: ${dbUrl}')
  })
})

describe('the shared harness refuses a hosted target when it is called', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const local = {
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'unused-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'unused-service',
    DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  }

  function stub(overrides: Record<string, string>): void {
    for (const [name, value] of Object.entries({ ...local, ...overrides })) {
      vi.stubEnv(name, value)
    }
  }

  it('builds a client for an entirely local target', () => {
    stub({})
    expect(() => createServiceClient()).not.toThrow()
    expect(() => createAnonClient()).not.toThrow()
  })

  it.each([
    ['SUPABASE_URL', HOSTED_API],
    // A local API URL does not excuse a hosted database or a tunnelled project key.
    ['DB_URL', HOSTED_DB],
  ])('createServiceClient and createAnonClient refuse a hosted %s', (name, value) => {
    stub({ [name]: value })
    expect(() => createServiceClient()).toThrow(NonLocalTargetError)
    expect(() => createAnonClient()).toThrow(NonLocalTargetError)
  })

  it('HeldLockSession refuses a hosted DB_URL before it opens a connection', async () => {
    stub({ DB_URL: HOSTED_DB })
    await expect(HeldLockSession.beginAs('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      NonLocalTargetError,
    )
  })

  it('runRawSqlAsync refuses a hosted DB_URL before it starts a session', async () => {
    stub({ DB_URL: HOSTED_DB })
    await expect(runRawSqlAsync('select 1')).rejects.toThrow(NonLocalTargetError)
  })

  it('runPsql refuses a hosted DB_URL and a missing one, and does not echo the URL', () => {
    let message = ''
    try {
      runPsql(HOSTED_DB, ['-c', 'select 1'])
    } catch (error) {
      expect(error).toBeInstanceOf(NonLocalTargetError)
      message = (error as Error).message
    }
    expect(message).toContain('DB_URL')
    expect(message).not.toContain('not-a-real-password')
    expect(() => runPsql(undefined, ['-c', 'select 1'])).toThrow(/local DB_URL is required/)
    expect(() => runPsql('', ['-c', 'select 1'])).toThrow(/local DB_URL is required/)
    expect(() =>
      runPsql('postgresql://postgres@127.0.0.1:1/postgres?host=db.example.org', []),
    ).toThrow(NonLocalTargetError)
  })
})

describe('each guarded tool really exits before touching a hosted target', () => {
  const env = {
    ...process.env,
    SUPABASE_URL: HOSTED_API,
    SUPABASE_ANON_KEY: 'unused',
    SUPABASE_SERVICE_ROLE_KEY: 'unused',
    DB_URL: HOSTED_DB,
    // The registry rehearsal also needs its own inputs; they must not be what stops the process.
    REGISTRY_URL: 'https://registry.example.invalid',
    ERASURE_OPERATOR_TOKEN: 'unused',
  }

  async function runTool(rel: string): Promise<{ code: number; output: string }> {
    const isTs = rel.endsWith('.ts')
    const args = isTs ? ['node_modules/tsx/dist/cli.mjs', rel, 'x', 'y'] : [rel]
    try {
      const { stdout, stderr } = await run(process.execPath, args, {
        cwd: repoRoot,
        env,
        timeout: 100_000,
      })
      return { code: 0, output: `${stdout}${stderr}` }
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string }
      return { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout}${e.stderr}` }
    }
  }

  it.each([...DIRECT, ...VIA_HARNESS])(
    '%s refuses with the guard message and no network error',
    async (rel) => {
      const { code, output } = await runTool(rel)
      expect(code, output).not.toBe(0)
      expect(output).toContain('Refusing to run destructive tests')
      // The hosted address was judged, not contacted.
      expect(output).not.toMatch(/ENOTFOUND|fetch failed|getaddrinfo/)
      expect(output).not.toContain('not-a-real-password')
    },
    120_000,
  )
})
