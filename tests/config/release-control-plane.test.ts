/**
 * P193 — `main` is an integrated development branch, Production is a manually released, verified
 * `main` SHA. These tests keep that true:
 *
 *   - static checks over the two workflow files (no YAML dependency in this repo, so the same narrow
 *     text isolation the older gate tests used), each with a mutation proof;
 *   - the pure CI-evidence rules in scripts/lib/release-verify.mjs;
 *   - the real `release-guard verify-release-sha` CLI against a throwaway local git repository.
 *
 * What is NOT proven here: a real dispatch has never run on GitHub, and nothing here can see the
 * Cloudflare Pages Git-integration setting (that is recorded in docs/release/P193_MAIN_AND_PRODUCTION_POLICY.md).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  REQUIRED_CHECKS,
  evaluateRequiredChecks,
  isFullSha,
} from '../../scripts/lib/release-verify.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8')
const release = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'deploy-production.yml'),
  'utf-8',
)

/** The `on:` block: its header through the next top-level key. */
function triggerBlock(text: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^on:\s*$/.test(l))
  if (start === -1) throw new Error('trigger block not found')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]!) && !lines[i]!.startsWith('#')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function jobBlock(text: string, job: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^  ${job}:\\s*$`).test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')

/** One workflow_dispatch input's own lines (its header through the next input or key). */
function inputBlock(onBlock: string, name: string): string {
  const lines = onBlock.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^ {6}${name}:\\s*$`).test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,6}\S/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** The policy as one function so every rule has a mutation proof against a broken copy. */
function controlPlaneViolations(ciText: string, releaseText: string): string[] {
  const out: string[] = []
  const ciCode = code(ciText)
  const relCode = code(releaseText)

  // 1/2/3: no automatic path from ci.yml to a deploy
  if (/wrangler|pages deploy|deploy-production|api\.cloudflare\.com/.test(ciCode)) {
    out.push('ci.yml contains a deploy step or job')
  }
  if (/CLOUDFLARE_|PRODUCTION_SUPABASE_/.test(ciCode)) out.push('ci.yml reads a Production secret')
  if (!/branches:\s*\[main, 'release\/\*\*'\]/.test(triggerBlock(ciText))) {
    out.push('ci.yml no longer validates pushes to main and release/**')
  }
  if (!/\n {2}pull_request:/.test(triggerBlock(ciText)))
    out.push('ci.yml no longer validates pull requests')

  // 4: manual trigger only
  const on = code(triggerBlock(releaseText))
  const triggers = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
    out.push(
      `deploy-production.yml triggers must be exactly [workflow_dispatch], got [${triggers.join(', ')}]`,
    )
  }
  if (
    /^\s+(push|pull_request|pull_request_target|schedule|release|workflow_run|workflow_call):/m.test(
      on,
    )
  ) {
    out.push('deploy-production.yml has an automatic trigger')
  }

  // 5: explicit SHA required
  if (!/^\s+required:\s*true\s*$/m.test(inputBlock(on, 'sha'))) {
    out.push('the sha input is not required')
  }
  if (!/verify-release-sha --sha "\$RELEASE_SHA"/.test(relCode)) {
    out.push('the verify job does not run verify-release-sha on the input SHA')
  }
  if (!/ref:\s*\$\{\{\s*needs\.verify\.outputs\.sha\s*\}\}/.test(relCode)) {
    out.push('the deploy job does not check out the verified SHA')
  }

  // 6: dispatch only from main
  if (!/GITHUB_REF" != "refs\/heads\/main"/.test(relCode)) out.push('no main-only dispatch guard')
  // real deploy requires the backend acknowledgement
  if (!/BACKEND_ACK" != "BACKEND-ROLLED-OUT"/.test(relCode))
    out.push('no backend acknowledgement guard')
  // dry run is the default
  if (!/^\s+default:\s*true\s*$/m.test(inputBlock(on, 'dry_run')))
    out.push('dry_run does not default to true')

  // 8: Production secrets only in the deploy job
  const verify = jobBlock(relCode, 'verify')
  if (/secrets\./.test(verify)) out.push('the verify job reads a secret')
  const permissions = /^permissions:\s*\n((?: {2}\S.*\n)+)/m.exec(relCode)?.[1] ?? ''
  if (/write/.test(permissions)) out.push('deploy-production.yml requests a write permission')
  return out
}

describe('the real workflows satisfy the control-plane policy', () => {
  it('has no violations', () => {
    expect(controlPlaneViolations(ci, release)).toEqual([])
  })

  it('ci.yml still runs build-and-test, db-tests and native-checks with no job-level condition', () => {
    for (const job of ['build-and-test', 'db-tests', 'native-checks']) {
      const block = jobBlock(ci, job)
      expect(block, `${job} missing`).not.toBe('')
      expect(block).not.toMatch(/^ {4}if:/m)
    }
  })

  it('the three required checks are exactly the three CI job names', () => {
    expect([...REQUIRED_CHECKS].sort()).toEqual(['build-and-test', 'db-tests', 'native-checks'])
  })
})

describe('mutation proofs — each regression is reported', () => {
  const v = (c: string, r: string) => controlPlaneViolations(c, r).join(' | ')

  it('a deploy job returns to ci.yml', () => {
    const m = `${ci}\n  deploy-production:\n    needs: [build-and-test]\n    runs-on: ubuntu-24.04\n    steps:\n      - run: pnpm exec wrangler pages deploy dist\n`
    expect(v(m, release)).toContain('ci.yml contains a deploy step or job')
  })

  it('ci.yml starts reading a Production secret', () => {
    const m = `${ci}\n      - run: echo \${{ secrets.CLOUDFLARE_API_TOKEN }}\n`
    expect(v(m, release)).toContain('ci.yml reads a Production secret')
  })

  it('a push trigger is added to the Production workflow', () => {
    const m = release.replace(
      'on:\n  workflow_dispatch:',
      'on:\n  push:\n    branches: [main]\n  workflow_dispatch:',
    )
    expect(m).not.toBe(release)
    expect(v(ci, m)).toContain('automatic trigger')
  })

  it('a pull_request trigger is added to the Production workflow', () => {
    const m = release.replace(
      'on:\n  workflow_dispatch:',
      'on:\n  pull_request:\n  workflow_dispatch:',
    )
    expect(v(ci, m)).toContain('automatic trigger')
  })

  it('the manual trigger is removed (a release/tag/schedule path instead)', () => {
    const m = release.replace('workflow_dispatch:', 'release:')
    expect(v(ci, m)).toContain('triggers must be exactly [workflow_dispatch]')
  })

  it('the sha input becomes optional', () => {
    const m = release.replace(/(sha:\n[\s\S]*?)required: true/, '$1required: false')
    expect(m).not.toBe(release)
    expect(v(ci, m)).toContain('the sha input is not required')
  })

  it('the SHA verification step is removed', () => {
    const m = release.replace('verify-release-sha --sha "$RELEASE_SHA"', 'echo skipped')
    expect(v(ci, m)).toContain('does not run verify-release-sha')
  })

  it('the deploy job checks out whatever was typed instead of the verified SHA', () => {
    const m = release.replace('ref: ${{ needs.verify.outputs.sha }}', 'ref: ${{ inputs.sha }}')
    expect(v(ci, m)).toContain('does not check out the verified SHA')
  })

  it('the dispatch-from-main guard is removed', () => {
    const m = release.replace('"$GITHUB_REF" != "refs/heads/main"', '"x" != "y"')
    expect(v(ci, m)).toContain('no main-only dispatch guard')
  })

  it('the backend acknowledgement is removed', () => {
    const m = release.replace('"$BACKEND_ACK" != "BACKEND-ROLLED-OUT"', '"x" != "y"')
    expect(v(ci, m)).toContain('no backend acknowledgement guard')
  })

  it('dry_run stops defaulting to true', () => {
    const m = release.replace(/(dry_run:\n[\s\S]*?default: )true/, '$1false')
    expect(m).not.toBe(release)
    expect(v(ci, m)).toContain('dry_run does not default to true')
  })

  it('the verify job gets a Production secret', () => {
    const m = release.replace(
      'GITHUB_TOKEN: ${{ github.token }}',
      'GITHUB_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    )
    expect(v(ci, m)).toContain('the verify job reads a secret')
  })

  it('a write permission is granted to the Production workflow', () => {
    const m = release.replace('  checks: read\n', '  checks: read\n  contents: write\n')
    expect(v(ci, m)).toContain('write permission')
  })

  it('ci.yml stops validating pull requests or main/release pushes', () => {
    expect(v(ci.replace('  pull_request:\n', ''), release)).toContain('pull requests')
    expect(
      v(ci.replace("branches: [main, 'release/**']", 'branches: [feature]'), release),
    ).toContain('main and release/**')
  })
})

describe('ci.yml: a main push is validated, never cancelled into a missing check-run', () => {
  const header = ci.slice(0, ci.indexOf('\njobs:'))
  it('only pull-request runs are cancelled by a newer commit', () => {
    expect(header).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    )
  })
})

describe('evaluateRequiredChecks — CI evidence for the exact SHA', () => {
  const run = (name: string, id: number, conclusion: string | null, status = 'completed') => ({
    id,
    name,
    status,
    conclusion,
  })
  const green = [
    run('build-and-test', 1, 'success'),
    run('db-tests', 2, 'success'),
    run('native-checks', 3, 'success'),
  ]

  it('accepts three successful required checks', () => {
    expect(evaluateRequiredChecks(green)).toEqual({ ok: true, missing: [], notGreen: [] })
  })

  it('refuses a missing check', () => {
    expect(evaluateRequiredChecks(green.slice(0, 2)).missing).toEqual(['native-checks'])
  })

  it.each(['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null])(
    'refuses conclusion %s',
    (conclusion) => {
      const runs = [green[0]!, green[1]!, run('native-checks', 3, conclusion)]
      expect(evaluateRequiredChecks(runs).notGreen).toEqual(['native-checks'])
    },
  )

  it('refuses a check that is still running', () => {
    const runs = [green[0]!, green[1]!, run('native-checks', 3, null, 'in_progress')]
    expect(evaluateRequiredChecks(runs).ok).toBe(false)
  })

  it('the newest run wins: a re-run success supersedes an earlier failure, and a later failure wins', () => {
    expect(
      evaluateRequiredChecks([
        run('build-and-test', 1, 'failure'),
        ...green.map((g) => ({ ...g })).slice(0, 0),
        run('build-and-test', 9, 'success'),
        green[1]!,
        green[2]!,
      ]).ok,
    ).toBe(true)
    expect(
      evaluateRequiredChecks([
        run('build-and-test', 1, 'success'),
        run('build-and-test', 9, 'failure'),
        green[1]!,
        green[2]!,
      ]).ok,
    ).toBe(false)
  })

  it('an unrelated green check never stands in for a required one', () => {
    expect(evaluateRequiredChecks([run('lint', 1, 'success')]).ok).toBe(false)
    expect(evaluateRequiredChecks(undefined).ok).toBe(false)
  })

  it('isFullSha accepts only a full lowercase 40-hex SHA', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true)
    for (const bad of [
      'main',
      'HEAD',
      'abc1234',
      'A'.repeat(40),
      `${'a'.repeat(39)}g`,
      'a'.repeat(41),
      '',
      undefined,
      7,
    ]) {
      expect(isFullSha(bad)).toBe(false)
    }
  })
})

describe('release-guard verify-release-sha against a local repository', { timeout: 60_000 }, () => {
  const scratch: string[] = []
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true })
  })

  function git(cwd: string, ...args: string[]) {
    const r = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
      { cwd, encoding: 'utf8' },
    )
    expect(r.status, `git ${args.join(' ')}`).toBe(0)
    return r.stdout.trim()
  }

  /** main has two commits; `side` is a commit that is NOT an ancestor of main. */
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'p193-'))
    scratch.push(dir)
    git(dir, 'init', '--initial-branch=main')
    writeFileSync(join(dir, 'a'), '1')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'one', '--no-gpg-sign')
    const first = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'a'), '2')
    git(dir, 'commit', '-am', 'two', '--no-gpg-sign')
    const second = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'update-ref', 'refs/remotes/origin/main', second)
    git(dir, 'checkout', '-q', '-b', 'side', first)
    writeFileSync(join(dir, 'b'), 'x')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'side', '--no-gpg-sign')
    const side = git(dir, 'rev-parse', 'HEAD')
    return { dir, first, second, side }
  }

  function checksFile(dir: string, runs: object[]) {
    const p = join(dir, 'checks.json')
    writeFileSync(p, JSON.stringify({ check_runs: runs }))
    return p
  }
  const greenRuns = REQUIRED_CHECKS.map((name, i) => ({
    id: i + 1,
    name,
    status: 'completed',
    conclusion: 'success',
  }))

  function verify(cwd: string, args: string[]) {
    return spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'release-guard.mjs'), 'verify-release-sha', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_TOKEN: '' },
      },
    )
  }

  it('accepts a main SHA with green required checks', () => {
    const { dir, second } = fixture()
    const r = verify(dir, ['--sha', second, '--checks-file', checksFile(dir, greenRuns)])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`sha=${second}`)
  })

  it('accepts an older commit that is an ancestor of main', () => {
    const { dir, first } = fixture()
    expect(verify(dir, ['--sha', first, '--checks-file', checksFile(dir, greenRuns)]).status).toBe(
      0,
    )
  })

  it('refuses a SHA that is not reachable from main, even with green checks', () => {
    const { dir, side } = fixture()
    const r = verify(dir, ['--sha', side, '--checks-file', checksFile(dir, greenRuns)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not reachable from origin/main')
  })

  it('refuses a SHA that does not exist', () => {
    const { dir } = fixture()
    const r = verify(dir, ['--sha', 'c'.repeat(40), '--checks-file', checksFile(dir, greenRuns)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not exist')
  })

  it.each(['main', 'HEAD', 'abc1234', ''])('refuses the non-SHA input %j', (input) => {
    const { dir } = fixture()
    const r = verify(dir, ['--sha', input, '--checks-file', checksFile(dir, greenRuns)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('40-hex')
  })

  it('refuses a missing --sha', () => {
    const { dir } = fixture()
    expect(verify(dir, ['--checks-file', checksFile(dir, greenRuns)]).status).toBe(1)
  })

  it('refuses when a required check is red, missing or skipped', () => {
    const { dir, second } = fixture()
    for (const runs of [
      greenRuns.map((r) => (r.name === 'db-tests' ? { ...r, conclusion: 'failure' } : r)),
      greenRuns.filter((r) => r.name !== 'native-checks'),
      greenRuns.map((r) => (r.name === 'build-and-test' ? { ...r, conclusion: 'skipped' } : r)),
    ]) {
      const r = verify(dir, ['--sha', second, '--checks-file', checksFile(dir, runs)])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('required CI is not green')
    }
  })

  it('without a checks file it needs a token and a repo: fails closed instead of trusting the input', () => {
    const { dir, second } = fixture()
    const r = verify(dir, ['--sha', second])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('GITHUB_TOKEN')
  })
})
