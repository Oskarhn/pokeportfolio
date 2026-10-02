/**
 * P163 — integration tests for the release pipeline: the P142 CI-gated deploy job together with
 * the P160 public-configuration guards.
 *
 * Two layers, both local and both without a GitHub run:
 *   1. A policy checker over `.github/workflows/ci.yml` (comments stripped, steps parsed) plus a
 *      small simulator of GitHub's step-outcome semantics. Each rule has a mutation proof: the same
 *      checker run over a deliberately broken copy of the workflow must report it.
 *   2. Real subprocess runs of the guard CLIs (`check-public-env`, `check-dist-secrets`,
 *      `release-guard`) against synthetic fixtures.
 *
 * A static pass here is NOT a hosted, gated deployment: the workflow has never run on GitHub.
 * Every secret-shaped fixture is synthetic and assembled at runtime.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { bundleDeclaresExactSha } from '../../scripts/lib/build-identity.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows')
const WORKFLOW = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf-8')

// ---------------------------------------------------------------------------------------------
// Workflow parsing (deliberately small — this repo has no YAML dependency, see
// workflow-deploy-gate.test.ts for why).
// ---------------------------------------------------------------------------------------------

/** Removes comment-only lines so prose in a comment can never satisfy or trip a rule. */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}

function jobCode(code: string, job: string): string {
  const lines = code.split('\n')
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

interface Step {
  name: string
  raw: string
  condition: string | undefined
  env: Record<string, string>
}

function parseSteps(job: string): Step[] {
  const lines = job.split('\n')
  const stepsAt = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l))
  if (stepsAt === -1) return []
  const blocks: string[][] = []
  for (const line of lines.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(line)) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }
  return blocks.map((block) => {
    const raw = block.join('\n')
    const name =
      /^\s+(?:- )?name:\s*(.+?)\s*$/m.exec(raw)?.[1] ??
      /^\s+(?:- )?uses:\s*(.+?)\s*$/m.exec(raw)?.[1] ??
      '(unnamed)'
    const condition = /^ {8}if:\s*(.+?)\s*$/m.exec(raw)?.[1]
    const env: Record<string, string> = {}
    const envAt = block.findIndex((l) => /^ {8}env:\s*$/.test(l))
    if (envAt !== -1) {
      for (const l of block.slice(envAt + 1)) {
        const m = /^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(l)
        if (!m) break
        env[m[1]!] = m[2]!
      }
    }
    return { name, raw, condition, env }
  })
}

const GATED = "steps.guard-main.outputs.current == 'true'"
const SECRET_URL = '${{ secrets.PRODUCTION_SUPABASE_URL }}'
const SECRET_KEY = '${{ secrets.PRODUCTION_SUPABASE_PUBLISHABLE_KEY }}'

/**
 * The pipeline policy. Returns one human-readable violation per broken rule; `[]` means the
 * workflow files satisfy every rule. The mutation tests below run this same function over broken
 * copies, so a rule that cannot fail is caught.
 */
function pipelineViolations(files: Record<string, string>): string[] {
  const out: string[] = []
  const ci = stripComments(files['ci.yml'] ?? '')

  // --- eligibility ---------------------------------------------------------------------------
  const deploy = jobCode(ci, 'deploy-production')
  if (!/^ {4}needs:\s*\[build-and-test,\s*db-tests\]\s*$/m.test(deploy)) {
    out.push('deploy does not need BOTH build-and-test and db-tests')
  }
  const pushToMain = new RegExp(
    String.raw`^ {4}if:\s*github\.event_name == 'push' && github\.ref == 'refs/heads/main'\s*$`,
    'm',
  )
  if (!pushToMain.test(deploy)) {
    out.push('deploy is not restricted to a push to main')
  }

  // --- nothing that prints a value before a guard can run -----------------------------------
  if (/\$\{\{\s*vars\./.test(ci)) out.push('a vars.* expression is used (variables are not masked)')
  if (/^(?: {4})?env:/m.test(ci)) out.push('env block above step level (workflow or job)')

  // --- credential scoping --------------------------------------------------------------------
  for (const job of ['build-and-test', 'db-tests']) {
    const code = jobCode(ci, job)
    if (/CLOUDFLARE_|PRODUCTION_SUPABASE_/.test(code)) out.push(`${job} references a deploy secret`)
    for (const m of code.matchAll(/^ {10}VITE_[A-Z_]+:\s*(.+)$/gm)) {
      if (m[1]!.includes('${{')) out.push(`${job} feeds an expression into a VITE_ variable`)
    }
  }
  if (/^ {4}environment:/m.test(deploy)) out.push('deploy carries an environment: key')

  // --- step structure ------------------------------------------------------------------------
  const steps = parseSteps(deploy)
  const at = (needle: RegExp) => steps.findIndex((s) => needle.test(s.raw))
  const idx = {
    guard: at(/check-public-env\.mjs --require-hosted/),
    stale: at(/release-guard\.mjs remote-main-current/),
    install: at(/pnpm install/),
    clean: at(/rm -rf dist/),
    build: at(/^\s+run: pnpm build\s*$/m),
    scan: at(/check-dist-secrets\.mjs/),
    identity: at(/release-guard\.mjs build-identity/),
    upload: at(/wrangler pages deploy/),
  }
  for (const [k, v] of Object.entries(idx)) if (v === -1) out.push(`deploy job has no ${k} step`)
  const order = ['guard', 'install', 'clean', 'build', 'scan', 'identity', 'upload'] as const
  for (let i = 0; i + 1 < order.length; i++) {
    const a = idx[order[i]!]
    const b = idx[order[i + 1]!]
    if (a !== -1 && b !== -1 && a > b)
      out.push(`step order: ${order[i]} must precede ${order[i + 1]}`)
  }
  if (idx.stale !== -1 && idx.guard > idx.stale)
    out.push('step order: guard must precede stale check')

  // every step from the stale check onwards is gated on it (a stale run deploys nothing)
  if (idx.stale !== -1) {
    steps.slice(idx.stale + 1).forEach((s) => {
      if (s.condition !== GATED) out.push(`step "${s.name}" is not gated on the stale-run check`)
    })
  }
  if (idx.guard !== -1 && steps[idx.guard]!.condition !== undefined) {
    out.push('the public configuration guard must be unconditional')
  }

  // fail closed: nothing may turn a failure into a pass
  if (/continue-on-error|\|\|\s*true|\balways\(\)|\bfailure\(\)|\bcancelled\(\)/.test(deploy)) {
    out.push('deploy job contains a fail-open construct')
  }

  // guard and build use secrets only; the build selects the deploy profile
  const guard = steps[idx.guard]
  const build = steps[idx.build]
  for (const s of [guard, build]) {
    if (!s) continue
    if (
      s.env.VITE_SUPABASE_URL !== SECRET_URL ||
      s.env.VITE_SUPABASE_PUBLISHABLE_KEY !== SECRET_KEY
    ) {
      out.push(`step "${s.name}" must read its public config from the two repository secrets`)
    }
  }
  if (build && build.env.PP_REQUIRE_HOSTED_PUBLIC_ENV !== "'1'") {
    out.push('build does not select the deploy profile')
  }
  for (const s of steps) {
    const hasCf = /CLOUDFLARE_/.test(Object.keys(s.env).join(' '))
    if (hasCf && !/wrangler pages deploy/.test(s.raw))
      out.push('Cloudflare credential outside the upload step')
    if (
      /PRODUCTION_SUPABASE_/.test(s.raw) &&
      s !== guard &&
      s !== build &&
      !/deployment-check/.test(s.raw)
    ) {
      out.push(`step "${s.name}" receives the configuration secrets without needing them`)
    }
  }
  const upload = steps[idx.upload]
  if (upload && !upload.raw.includes('--commit-hash="$GITHUB_SHA"'))
    out.push('upload is not pinned to the SHA')

  // --- one automatic production path ---------------------------------------------------------
  let uploads = 0
  for (const [name, text] of Object.entries(files)) {
    const code = stripComments(text)
    uploads += (code.match(/wrangler pages deploy/g) ?? []).length
    if (/workflow_run:|deploy_hooks|api\.cloudflare\.com/.test(code)) {
      out.push(`${name}: second deploy trigger (workflow_run / deploy hook / raw API)`)
    }
  }
  if (uploads !== 1)
    out.push(`expected exactly one upload command across all workflows, found ${String(uploads)}`)
  if ((deploy.match(/group:\s*production-deploy/g) ?? []).length !== 1)
    out.push('deploy concurrency group count')
  if (!/group:\s*production-deploy\s*\n\s*cancel-in-progress:\s*false/.test(deploy)) {
    out.push('deploy concurrency may cancel an in-flight upload')
  }
  return out
}

/** Minimal model of GitHub's step semantics: implicit success(), `if`, continue-on-error. */
function simulate(
  steps: Step[],
  fails: string[],
  mainIsCurrent: boolean,
): { ran: string[]; jobSucceeded: boolean } {
  const ran: string[] = []
  let failed = false
  for (const s of steps) {
    const always = /\balways\(\)/.test(s.condition ?? '')
    const gated = s.condition?.includes(GATED) === true
    const conditionOk = s.condition === undefined || always || (gated && mainIsCurrent)
    if (!conditionOk) continue
    if (failed && !always) continue
    ran.push(s.name)
    const failsHere = fails.some((f) => s.raw.includes(f))
    if (failsHere && !/continue-on-error/.test(s.raw) && !/\|\|\s*true/.test(s.raw)) failed = true
  }
  return { ran, jobSucceeded: !failed }
}

const deploySteps = parseSteps(jobCode(stripComments(WORKFLOW), 'deploy-production'))
const UPLOAD = 'wrangler pages deploy'
const workflowFiles = (ci: string): Record<string, string> => {
  const files: Record<string, string> = {}
  for (const f of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    files[f] = readFileSync(join(WORKFLOW_DIR, f), 'utf-8')
  }
  files['ci.yml'] = ci
  return files
}

/** Cuts one deploy-job step out of the text and returns [textWithoutStep, stepText]. */
function cutStep(text: string, nameFragment: string): [string, string] {
  // Only inside the deploy job: build-and-test carries a step with the same name (P160).
  const marker = text.indexOf(`- name: ${nameFragment}`, text.indexOf('\n  deploy-production:'))
  if (marker === -1) throw new Error(`step not found: ${nameFragment}`)
  const start = text.lastIndexOf('\n', marker) + 1 // include the step's own indentation
  const next = text.indexOf('\n      - ', marker + 1)
  const end = next === -1 ? text.length : next + 1
  return [text.slice(0, start) + text.slice(end), text.slice(start, end)]
}

describe('the unmutated workflow satisfies every pipeline rule', () => {
  it('has no violations', () => {
    expect(pipelineViolations(workflowFiles(WORKFLOW))).toEqual([])
  })

  it('has one upload command in exactly one workflow file, inside deploy-production', () => {
    expect(deploySteps.filter((s) => s.raw.includes(UPLOAD))).toHaveLength(1)
  })
})

describe('mutation proofs — each simulated regression is reported', () => {
  const violations = (ci: string) => pipelineViolations(workflowFiles(ci)).join(' | ')

  it('removed db-tests dependency', () => {
    const m = WORKFLOW.replace('needs: [build-and-test, db-tests]', 'needs: [build-and-test]')
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('BOTH build-and-test and db-tests')
  })

  it('pull-request deployment enabled', () => {
    const m = WORKFLOW.replace(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
      "if: github.ref == 'refs/heads/main'",
    )
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('not restricted to a push to main')
  })

  it('stale SHA accepted: upload no longer gated on the stale-run check', () => {
    const m = WORKFLOW.replace(
      /(- name: Deploy to Cloudflare Pages \(Production\)\n)\s+if: steps\.guard-main\.outputs\.current == 'true'\n/,
      '$1',
    )
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('Deploy to Cloudflare Pages (Production)" is not gated')
  })

  it('stale SHA accepted: stale-run check removed', () => {
    const [m] = cutStep(WORKFLOW, 'Check that origin/main is still exactly this commit')
    expect(violations(m)).toContain('no stale step')
  })

  it('mismatching build SHA accepted: identity check removed', () => {
    const [m] = cutStep(WORKFLOW, 'Verify build identity before upload')
    expect(violations(m)).toContain('no identity step')
  })

  it('guard after upload: the public configuration guard moved to the end of the job', () => {
    const [without, guard] = cutStep(WORKFLOW, 'Public configuration guard (deploy profile)')
    const m = `${without.trimEnd()}\n\n      ${guard.trim()}\n`
    expect(violations(m)).toContain('step order: guard must precede install')
  })

  it('guard after upload: the dist scan moved after the upload', () => {
    const [without, scan] = cutStep(WORKFLOW, 'Built artefact secret scan (dist/)')
    const m = `${without.trimEnd()}\n\n      ${scan.trim()}\n`
    expect(violations(m)).toContain('step order: scan must precede identity')
  })

  it('dist scanner removed', () => {
    const [m] = cutStep(WORKFLOW, 'Built artefact secret scan (dist/)')
    expect(violations(m)).toContain('no scan step')
  })

  it('stale dist could survive: the clean-build step removed', () => {
    const [m] = cutStep(WORKFLOW, 'Remove any pre-existing build output')
    expect(violations(m)).toContain('no clean step')
  })

  it('stale dist accepted after a failed build: continue-on-error on the build', () => {
    const m = WORKFLOW.replace(
      '        run: pnpm build\n        env:\n          VITE_SUPABASE_URL: ${{ secrets.PRODUCTION',
      '        continue-on-error: true\n        run: pnpm build\n        env:\n          VITE_SUPABASE_URL: ${{ secrets.PRODUCTION',
    )
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('fail-open construct')
  })

  it('stale dist accepted after a failed build: || true on the build', () => {
    const m = WORKFLOW.replace(
      /run: pnpm build\n(\s+env:\n\s+VITE_SUPABASE_URL: \$\{\{ secrets)/,
      'run: pnpm build || true\n$1',
    )
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('fail-open construct')
  })

  it('upload made unconditional-on-failure with always()', () => {
    const m = WORKFLOW.replace(
      /(- name: Deploy to Cloudflare Pages \(Production\)\n\s+if: )steps\.guard-main\.outputs\.current == 'true'/,
      '$1always()',
    )
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('fail-open construct')
  })

  it('a value in a job-level env block, printed before any guard can run', () => {
    const m = WORKFLOW.replace(
      '    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    # The one deployment',
      '    runs-on: ubuntu-latest\n    env:\n      VITE_SUPABASE_URL: ${{ secrets.PRODUCTION_SUPABASE_URL }}\n    permissions:\n      contents: read\n    # The one deployment',
    )
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('env block above step level')
  })

  it('an unmasked variable feeding the build (vars.*)', () => {
    const m = WORKFLOW.replaceAll('secrets.PRODUCTION_SUPABASE_URL', 'vars.VITE_SUPABASE_URL')
    expect(m).not.toBe(WORKFLOW)
    expect(violations(m)).toContain('vars.* expression')
  })

  it('a second, parallel Production deploy path', () => {
    const files = workflowFiles(WORKFLOW)
    files['extra.yml'] =
      'jobs:\n  x:\n    steps:\n      - run: pnpm exec wrangler pages deploy dist\n'
    expect(pipelineViolations(files).join(' | ')).toContain('exactly one upload command')
  })

  it('a workflow_run-triggered deploy path', () => {
    const files = workflowFiles(WORKFLOW)
    files['extra.yml'] = 'on:\n  workflow_run:\n    workflows: [CI]\n'
    expect(pipelineViolations(files).join(' | ')).toContain('second deploy trigger')
  })

  it('the deploy profile is not selected for the build', () => {
    const m = WORKFLOW.replace(
      "PP_REQUIRE_HOSTED_PUBLIC_ENV: '1'",
      "PP_REQUIRE_HOSTED_PUBLIC_ENV: '0'",
    )
    expect(violations(m)).toContain('deploy profile')
  })
})

describe('step semantics: a failed or skipped step can never be followed by an upload', () => {
  const idx = deploySteps.findIndex((s) => s.raw.includes(UPLOAD))
  const uploaded = (r: { ran: string[] }) => r.ran.some((n) => n.startsWith('Deploy to Cloudflare'))

  it('a fully successful, current run reaches the upload', () => {
    expect(idx).toBeGreaterThan(-1)
    const r = simulate(deploySteps, [], true)
    expect(uploaded(r)).toBe(true)
    expect(r.jobSucceeded).toBe(true)
  })

  it.each([
    ['the public configuration guard', 'check-public-env.mjs'],
    ['the build', 'run: pnpm build'],
    ['the dist scan', 'check-dist-secrets.mjs'],
    ['the build identity check', 'build-identity'],
  ])('a failing %s stops everything after it, so nothing is uploaded', (_label, fragment) => {
    const r = simulate(deploySteps, [fragment], true)
    expect(uploaded(r)).toBe(false)
    expect(r.jobSucceeded).toBe(false)
  })

  it('a failing guard runs no install and no build at all', () => {
    const r = simulate(deploySteps, ['check-public-env.mjs'], true)
    expect(r.ran.some((n) => /Install|Build/.test(n))).toBe(false)
  })

  it('a stale run uploads nothing and ends successfully', () => {
    const r = simulate(deploySteps, [], false)
    expect(uploaded(r)).toBe(false)
    expect(r.jobSucceeded).toBe(true)
  })

  it('the simulator itself detects a fail-open workflow (always() on the upload)', () => {
    const broken = deploySteps.map((s) =>
      s.raw.includes(UPLOAD) ? { ...s, condition: 'always()', raw: s.raw } : s,
    )
    expect(uploaded(simulate(broken, ['run: pnpm build'], true))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Real subprocess runs.
// ---------------------------------------------------------------------------------------------

const REF = 'abcdefghijklmnopqrst'
const TAIL = 'SYNTHETICTAIL0123456789abcdefXYZ'
const secretKey = () => ['sb', 'secret', TAIL].join('_')
const publishableKey = () => ['sb', 'publishable', 'Q'.repeat(24)].join('_')
const hostedUrl = () => `https://${REF}.supabase.co`
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const serviceRoleJwt = () =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'synthetic', role: 'service_role' })}.${'s'.repeat(20)}`

const scratch: string[] = []
function tmp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

function run(script: string, args: string[], env: Record<string, string>, cwd = REPO_ROOT) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !(
          k.startsWith('VITE_') ||
          k === 'CF_PAGES' ||
          k === 'PP_REQUIRE_HOSTED_PUBLIC_ENV' ||
          k === 'GITHUB_OUTPUT'
        ),
    ),
  )
  return spawnSync(process.execPath, [join(REPO_ROOT, script), ...args], {
    env: { ...clean, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  })
}

/** The exact invocation the workflow's first guard step uses. */
const guard = (env: Record<string, string>, cwd?: string) =>
  run('scripts/check-public-env.mjs', ['--require-hosted', '--process-env-only'], env, cwd)

function expectNoLeak(output: string, value: string) {
  for (let i = 0; i + 10 <= value.length; i += 1) {
    expect(output, `window at ${String(i)} leaked`).not.toContain(value.slice(i, i + 10))
  }
}

describe(
  'the workflow’s first guard, run exactly as the workflow runs it',
  { timeout: 60_000 },
  () => {
    const good = { VITE_SUPABASE_URL: hostedUrl(), VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey() }

    it('accepts a well-formed hosted configuration', () => {
      expect(guard(good).status).toBe(0)
    })

    it('refuses a raw secret-shaped value in the URL slot, without echoing it', () => {
      const value = secretKey()
      const r = guard({ ...good, VITE_SUPABASE_URL: value })
      expect(r.status).toBe(1)
      expect(`${r.stdout}${r.stderr}`).toContain('url_is_secret_key_shaped')
      expectNoLeak(`${r.stdout}${r.stderr}`, value)
    })

    it('refuses a secret hidden in the query of an otherwise valid URL', () => {
      const value = `${hostedUrl()}/?apikey=${secretKey()}`
      const r = guard({ ...good, VITE_SUPABASE_URL: value })
      expect(r.status).toBe(1)
      expectNoLeak(`${r.stdout}${r.stderr}`, value)
    })

    it('refuses a secret in userinfo and in the fragment', () => {
      for (const value of [
        `https://${secretKey()}@${REF}.supabase.co`,
        `${hostedUrl()}/#${secretKey()}`,
      ]) {
        const r = guard({ ...good, VITE_SUPABASE_URL: value })
        expect(r.status).toBe(1)
        expectNoLeak(`${r.stdout}${r.stderr}`, value)
      }
    })

    it('refuses a service_role JWT as the frontend key and an extra secret-valued VITE_ field', () => {
      const jwtValue = serviceRoleJwt()
      const a = guard({ ...good, VITE_SUPABASE_PUBLISHABLE_KEY: jwtValue })
      expect(a.status).toBe(1)
      expectNoLeak(`${a.stdout}${a.stderr}`, jwtValue)
      const extra = secretKey()
      const b = guard({ ...good, VITE_EXTRA_TOKEN: extra })
      expect(b.status).toBe(1)
      expectNoLeak(`${b.stdout}${b.stderr}`, extra)
    })

    it('refuses a missing value and a local/placeholder configuration (fail closed, not a skip)', () => {
      expect(guard({}).status).toBe(1)
      expect(
        guard({
          VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
          VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
        }).status,
      ).toBe(1)
    })

    it('--process-env-only needs no installed dependencies: the script has no static vite import', () => {
      const source = readFileSync(join(REPO_ROOT, 'scripts', 'check-public-env.mjs'), 'utf8')
      expect(source).not.toMatch(/^import[^\n]*from 'vite'/m)
    })

    it('--process-env-only ignores .env files; the prebuild guard (without it) does not', () => {
      const cwd = tmp('p163-envfile-')
      writeFileSync(join(cwd, '.env.production'), `VITE_API_KEY=${secretKey()}\n`)
      expect(guard(good, cwd).status).toBe(0)
      const full = run('scripts/check-public-env.mjs', ['--require-hosted'], good, cwd)
      expect(full.status).toBe(1)
      expectNoLeak(`${full.stdout}${full.stderr}`, secretKey())
    })
  },
)

describe(
  'stale or missing build output can never pass the identity gate',
  { timeout: 60_000 },
  () => {
    const NEW = 'a'.repeat(40)
    const OLD = 'b'.repeat(40)
    const identity = (metaPath: string) =>
      run(
        'scripts/release-guard.mjs',
        ['build-identity', '--github-sha', NEW, '--build-meta', metaPath],
        {},
      )

    it('a complete-looking dist left over from another commit is refused', () => {
      const dist = join(tmp('p163-stale-'), 'dist')
      mkdirSync(dist)
      writeFileSync(join(dist, 'build-meta.json'), JSON.stringify({ sha: OLD }))
      expect(identity(join(dist, 'build-meta.json')).status).toBe(1)
    })

    it('a dirty build of the same commit is refused', () => {
      const dist = join(tmp('p163-dirty-'), 'dist')
      mkdirSync(dist)
      writeFileSync(join(dist, 'build-meta.json'), JSON.stringify({ sha: `${NEW}+dirty` }))
      expect(identity(join(dist, 'build-meta.json')).status).toBe(1)
    })

    it('after the clean step and a failed build there is no dist, and the identity gate fails', () => {
      const dist = join(tmp('p163-gone-'), 'dist')
      expect(identity(join(dist, 'build-meta.json')).status).toBe(1)
    })

    it('the artefact scan refuses a partial dist and a missing dist', () => {
      const base = tmp('p163-partial-')
      const partial = join(base, 'dist')
      mkdirSync(partial)
      writeFileSync(join(partial, 'sw.js'), '// aborted build')
      expect(run('scripts/check-dist-secrets.mjs', [partial], {}).status).toBe(1)
      expect(run('scripts/check-dist-secrets.mjs', [join(base, 'nope')], {}).status).toBe(1)
    })

    it('the exact build identity is accepted', () => {
      const dist = join(tmp('p163-ok-'), 'dist')
      mkdirSync(dist)
      writeFileSync(join(dist, 'build-meta.json'), JSON.stringify({ sha: NEW }))
      expect(identity(join(dist, 'build-meta.json')).status).toBe(0)
    })

    it('a bundle SHA match needs the same quote on both sides', () => {
      expect(bundleDeclaresExactSha(`x="${NEW}"`, NEW)).toBe(true)
      expect(bundleDeclaresExactSha(`x=\`${NEW}\``, NEW)).toBe(true)
      expect(bundleDeclaresExactSha(`x="${NEW}'`, NEW)).toBe(false)
      expect(bundleDeclaresExactSha(`x="${NEW}+dirty"`, NEW)).toBe(false)
    })
  },
)

describe('stale-run refusal against a real (local) origin', { timeout: 60_000 }, () => {
  function gitOk(cwd: string, ...args: string[]) {
    const r = spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
      {
        cwd,
        encoding: 'utf8',
      },
    )
    expect(r.status, `git ${args.join(' ')}`).toBe(0)
    return r.stdout.trim()
  }
  function fixture() {
    const base = tmp('p163-origin-')
    const bare = join(base, 'origin.git')
    const work = join(base, 'work')
    mkdirSync(work)
    gitOk(base, 'init', '--bare', '--initial-branch=main', bare)
    gitOk(work, 'init', '--initial-branch=main')
    gitOk(work, 'remote', 'add', 'origin', bare)
    writeFileSync(join(work, 'a.txt'), '1')
    gitOk(work, 'add', '.')
    gitOk(work, 'commit', '-m', 'one', '--no-gpg-sign')
    const first = gitOk(work, 'rev-parse', 'HEAD')
    gitOk(work, 'push', 'origin', 'main')
    writeFileSync(join(work, 'a.txt'), '2')
    gitOk(work, 'commit', '-am', 'two', '--no-gpg-sign')
    const second = gitOk(work, 'rev-parse', 'HEAD')
    gitOk(work, 'push', 'origin', 'main')
    return { work, first, second }
  }
  const guardMain = (sha: string, cwd: string) =>
    run('scripts/release-guard.mjs', ['remote-main-current', '--github-sha', sha], {}, cwd)

  it('proceeds only for the SHA origin/main points at', () => {
    const { work, second } = fixture()
    const r = guardMain(second, work)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('current=true')
  })

  it('refuses a stale SHA: exits 0 with current=false, so nothing later runs', () => {
    const { work, first } = fixture()
    const r = guardMain(first, work)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('current=false')
  })

  it('fails (not a silent green skip) when origin cannot be read at all', () => {
    const cwd = tmp('p163-noremote-')
    gitOk(cwd, 'init', '--initial-branch=main')
    const r = guardMain('c'.repeat(40), cwd)
    expect(r.status).toBe(1)
  })
})
