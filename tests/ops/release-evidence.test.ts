import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LOCAL_GATES,
  STATUSES,
  classifyCiChecks,
  decideVerdict,
  redact,
  scanSkipSites,
  tailRedacted,
} from '../../scripts/lib/release-evidence.mjs'

/**
 * P203: the release-evidence report must never turn "did not run" into "passed". These tests pin the
 * classification rules, prove the verdict is READY only when every required item is PASS (exhaustively
 * over the status alphabet), prove nothing credential-shaped survives into a report, prove the script
 * has no deploy surface, and run the real CLI to show an un-run report comes back INCOMPLETE.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const GOOD = { shaIsFull: true, clean: true, headMatches: true }

const run = (id: number, name: string, status: string, conclusion: string | null) => ({
  id,
  name,
  status,
  conclusion,
})

describe('classifyCiChecks', () => {
  it('is PASS only for a completed success', () => {
    const result = classifyCiChecks([
      run(1, 'build-and-test', 'completed', 'success'),
      run(2, 'db-tests', 'completed', 'success'),
      run(3, 'native-checks', 'completed', 'success'),
    ])
    expect(result.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS'])
  })

  it('reports an absent check as MISSING, not PASS', () => {
    const result = classifyCiChecks([run(1, 'build-and-test', 'completed', 'success')])
    expect(result.find((c) => c.name === 'db-tests')?.status).toBe('MISSING')
    expect(result.find((c) => c.name === 'native-checks')?.status).toBe('MISSING')
  })

  it.each(['queued', 'in_progress', 'waiting', 'pending'])('reports %s as PENDING', (status) => {
    const result = classifyCiChecks([run(1, 'db-tests', status, null)], ['db-tests'])
    expect(result[0]?.status).toBe('PENDING')
  })

  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'stale'])(
    'reports a completed %s as FAIL, never PASS',
    (conclusion) => {
      const result = classifyCiChecks([run(1, 'db-tests', 'completed', conclusion)], ['db-tests'])
      expect(result[0]?.status).toBe('FAIL')
    },
  )

  it('lets the newest run decide in both directions', () => {
    const rerunGreen = classifyCiChecks(
      [run(5, 'db-tests', 'completed', 'success'), run(4, 'db-tests', 'completed', 'failure')],
      ['db-tests'],
    )
    const laterRed = classifyCiChecks(
      [run(4, 'db-tests', 'completed', 'success'), run(5, 'db-tests', 'completed', 'failure')],
      ['db-tests'],
    )
    expect(rerunGreen[0]?.status).toBe('PASS')
    expect(laterRed[0]?.status).toBe('FAIL')
  })

  it.each([null, undefined, 'oops', 42])(
    'reports UNKNOWN when CI could not be read (%j)',
    (bad) => {
      const result = classifyCiChecks(bad as never)
      expect(result.map((c) => c.status)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN'])
    },
  )

  it('ignores a green check that merely has the same prefix', () => {
    const result = classifyCiChecks(
      [run(1, 'db-tests-extra', 'completed', 'success')],
      ['db-tests'],
    )
    expect(result[0]?.status).toBe('MISSING')
  })
})

describe('decideVerdict', () => {
  const item = (name: string, status: string, required = true) => ({ name, status, required })

  it('is READY only when every required item is PASS on a clean full-SHA checkout', () => {
    expect(decideVerdict([item('a', 'PASS'), item('b', 'PASS')], GOOD).verdict).toBe('READY')
  })

  it('exhaustively: READY iff all required statuses are PASS (3 items x every status)', () => {
    for (const a of STATUSES) {
      for (const b of STATUSES) {
        for (const c of STATUSES) {
          const { verdict } = decideVerdict([item('a', a), item('b', b), item('c', c)], GOOD)
          const allPass = [a, b, c].every((s) => s === 'PASS')
          const anyFail = [a, b, c].includes('FAIL')
          expect(verdict === 'READY').toBe(allPass)
          expect(verdict === 'FAILED').toBe(anyFail)
        }
      }
    }
  })

  it('a gate that did not run makes the report INCOMPLETE, never READY', () => {
    const { verdict, reasons } = decideVerdict([item('unit', 'NOT_RUN'), item('ci', 'PASS')], GOOD)
    expect(verdict).toBe('INCOMPLETE')
    expect(reasons.join(' ')).toContain('NOT_RUN')
  })

  it('a failure outranks incompleteness', () => {
    expect(decideVerdict([item('a', 'FAIL'), item('b', 'NOT_RUN')], GOOD).verdict).toBe('FAILED')
  })

  it('does not let an optional gate that did not run block, nor an optional failure fail the report', () => {
    expect(decideVerdict([item('a', 'PASS'), item('e2e', 'NOT_RUN', false)], GOOD).verdict).toBe(
      'READY',
    )
    expect(decideVerdict([item('a', 'PASS'), item('e2e', 'FAIL', false)], GOOD).verdict).toBe(
      'READY',
    )
  })

  it.each([
    ['a dirty tree', { ...GOOD, clean: false }],
    ['a checkout at another commit', { ...GOOD, headMatches: false }],
    ['a non-full SHA', { ...GOOD, shaIsFull: false }],
  ])('refuses READY for %s even when every item passed', (_label, subject) => {
    const { verdict, reasons } = decideVerdict([item('a', 'PASS')], subject)
    expect(verdict).toBe('INCOMPLETE')
    expect(reasons.length).toBeGreaterThan(0)
  })

  it('an empty item list on a good subject is vacuously READY only because nothing is required', () => {
    // The CLI always supplies the five required local gates and three CI checks, so this cannot be
    // reached from the command line; it pins the function's own contract.
    expect(decideVerdict([], GOOD).verdict).toBe('READY')
  })
})

describe('redact', () => {
  const jwt = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'c3ludGhldGljLXNpZ25hdHVyZQ',
  ].join('.')

  // Built from parts at run time: a literal here would be indistinguishable from a committed key
  // to secret scanners (GitHub push protection rejected an earlier draft of this file).
  const sbSecret = ['sb_', 'secret_', 'SYNTHETICSYNTHETIC', '_not_a_key'].join('')
  const ghToken = ['gh', 'p_', 'SYNTHETICSYNTHETIC', '0123456789'].join('')

  it.each([
    ['a JWT', `key ${jwt} end`, jwt],
    ['a sb_secret key', `k ${sbSecret}`, 'SYNTHETICSYNTHETIC'],
    ['a GitHub token', `t ${ghToken}`, 'SYNTHETICSYNTHETIC'],
    ['a bearer header', 'Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
    ['a URL password', 'postgresql://postgres:hunter2-pass@db.example.org:5432/x', 'hunter2-pass'],
    ['a password assignment', 'PASSWORD=correct-horse-battery', 'correct-horse-battery'],
    ['a long hex token', `token ${'ab12'.repeat(14)}`, 'ab12ab12ab12'],
  ])('removes %s', (_label, input, secret) => {
    const out = redact(input)
    expect(out).not.toContain(secret)
    expect(out).toContain('REDACTED')
  })

  it('keeps a 40-character commit SHA readable', () => {
    const sha = '6eadd33744abc90fecf1fd8e5f4b324eb4ec4d18'
    expect(redact(`commit ${sha}`)).toContain(sha)
  })

  it('tailRedacted keeps only the last lines and redacts them', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`)
    lines.push('SECRET=do-not-print-me')
    const out = tailRedacted(lines.join('\n'), 5)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).not.toContain('do-not-print-me')
    expect(out).not.toContain('line 10')
  })
})

describe('scanSkipSites', () => {
  it('counts skip, fixme and todo sites per file, largest first', () => {
    const result = scanSkipSites([
      { path: 'a.spec.ts', source: "test.skip(true, 'x')\nit('ok', () => {})" },
      {
        path: 'b.test.ts',
        source: "it.skip('a')\ndescribe.skip('b')\ntest.fixme('c')\nit.todo('d')",
      },
      { path: 'c.test.ts', source: "it('clean', () => {})" },
    ])
    expect(result.total).toBe(5)
    expect(result.byFile).toEqual([
      { path: 'b.test.ts', count: 4 },
      { path: 'a.spec.ts', count: 1 },
    ])
  })
})

describe('the script has no deploy surface', () => {
  const script = readFileSync(join(repoRoot, 'scripts/release-evidence.mjs'), 'utf8')
  const lib = readFileSync(join(repoRoot, 'scripts/lib/release-evidence.mjs'), 'utf8')
  const code = (source: string): string =>
    source
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')

  it.each([
    /wrangler/i,
    /supabase\s+db\s+push/i,
    /functions\s+deploy/i,
    /pages\s+deploy/i,
    /workflow\s+run/i,
    /workflow_dispatch/i,
    /git\s+push/i,
    /\bcurl\b/i,
  ])('contains no %s', (pattern) => {
    expect(code(script)).not.toMatch(pattern)
    expect(code(lib)).not.toMatch(pattern)
  })

  it('only ever spawns git, gh and pnpm', () => {
    const spawned = [...code(script).matchAll(/spawnSync\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(new Set(spawned)).toEqual(new Set(['git', 'pnpm', 'gh']))
  })

  it('runs only the fixed pnpm argv of the allowlist, none of which can release', () => {
    const argv = Object.values(LOCAL_GATES).map((g) => g.args.join(' '))
    expect(argv.sort()).toEqual(
      ['build', 'format:check', 'lint', 'test', 'test:db', 'test:e2e', 'typecheck'].sort(),
    )
    for (const gate of Object.values(LOCAL_GATES)) {
      expect(gate.args.join(' ')).not.toMatch(/deploy|publish|release|push|migrat|backup/)
    }
  })

  it('pins the build gate to a placeholder backend, never an ambient VITE_SUPABASE_URL', () => {
    expect(LOCAL_GATES.build?.env?.VITE_SUPABASE_URL).toBe('http://127.0.0.1:54321')
  })
})

describe('the real command', () => {
  function evidence(args: string[]) {
    const outDir = mkdtempSync(join(tmpdir(), 'p203-evidence-'))
    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/release-evidence.mjs', '--out-dir', outDir, ...args],
        { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
      )
      let report: Record<string, unknown> | undefined
      let markdown = ''
      const sha = /\b([0-9a-f]{40})\b/.exec(result.stdout)?.[1]
      if (sha) {
        report = JSON.parse(
          readFileSync(join(outDir, `${sha.slice(0, 12)}.json`), 'utf8'),
        ) as Record<string, unknown>
        markdown = readFileSync(join(outDir, `${sha.slice(0, 12)}.md`), 'utf8')
      }
      return { result, report, markdown }
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  }

  it('with nothing run and no CI query, exits INCOMPLETE and marks every item NOT_RUN', () => {
    const { result, report, markdown } = evidence(['--no-ci'])
    expect(result.status).toBe(2)
    expect(report?.verdict).toBe('INCOMPLETE')
    const gates = report?.localGates as Array<{ status: string }>
    const ci = report?.ci as Array<{ status: string }>
    expect(gates.every((g) => g.status === 'NOT_RUN')).toBe(true)
    expect(ci.every((c) => c.status === 'NOT_RUN')).toBe(true)
    expect(markdown).toContain('**Verdict: INCOMPLETE**')
    expect(markdown).toContain('authorises nothing')
    expect(markdown).not.toMatch(/\| PASS \|/)
  }, 90_000)

  it('rejects an unknown gate and a malformed SHA with exit 3 and no report', () => {
    expect(evidence(['--run', 'deploy']).result.status).toBe(3)
    expect(evidence(['--sha', 'abc123']).result.status).toBe(3)
  }, 90_000)
})
