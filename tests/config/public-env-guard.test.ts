/**
 * P160 — the public (`VITE_*`) configuration guard and the built-artefact secret scan.
 *
 * Every secret-shaped fixture here is SYNTHETIC and assembled at runtime from fragments, so no
 * key-shaped literal sits in the repository (and none is a real credential). The output contract
 * under test: a failure names a field and a category and never any part of the value.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  KNOWN_PUBLIC_VARS,
  assertPublicEnv,
  collectPublicEnv,
  findSecretShapes,
  formatGuardReport,
  resolveRequireHosted,
  validatePublicEnv,
} from '../../scripts/lib/public-env-guard.mjs'
import viteConfig from '../../vite.config.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const REF = 'abcdefghijklmnopqrst'
const TAIL = 'SYNTHETICTAIL0123456789abcdefXYZ'
const secretKey = () => ['sb', 'secret', TAIL].join('_')
const publishableKey = () => ['sb', 'publishable', 'Q'.repeat(24)].join('_')
const hostedUrl = () => `https://${REF}.supabase.co`
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (role: string) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'synthetic-test', role })}.${'s'.repeat(20)}`

const cats = (r: ReturnType<typeof validatePublicEnv>) =>
  r.problems.map((p) => `${p.field}:${p.category}`)

/** No 10-character window of `value` may appear in `output` (catches partial echoes too). */
function expectNoLeak(output: string, value: string) {
  expect(output).not.toContain(value)
  for (let i = 0; i + 10 <= value.length; i += 1) {
    expect(output, `window at ${String(i)} leaked`).not.toContain(value.slice(i, i + 10))
  }
}

const scratch: string[] = []
function tmp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

function runNode(args: string[], env: Record<string, string>, cwd: string) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !(k.startsWith('VITE_') || k === 'CF_PAGES' || k === 'PP_REQUIRE_HOSTED_PUBLIC_ENV'),
    ),
  )
  return spawnSync(process.execPath, args, {
    env: { ...clean, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

describe('validatePublicEnv — accepted configurations', () => {
  it('accepts a normal hosted URL + publishable key, in both profiles', () => {
    const env = {
      VITE_SUPABASE_URL: hostedUrl(),
      VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey(),
    }
    for (const requireHosted of [false, true]) {
      const r = validatePublicEnv(env, { requireHosted })
      expect(r.ok).toBe(true)
      expect(r.profile).toBe('hosted')
    }
    // Shape acceptance is reported as exactly that, never as proof of low privilege.
    expect(validatePublicEnv(env).notes.map((n) => n.category)).toContain(
      'publishable_key_accepted_by_shape_only',
    )
    expect(validatePublicEnv({ ...env, VITE_SUPABASE_URL: `${hostedUrl()}/` }).ok).toBe(true)
  })

  it('accepts the exact placeholder pair CI and Playwright build with (local profile only)', () => {
    const ci = {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
    }
    const e2e = { ...ci, VITE_SUPABASE_PUBLISHABLE_KEY: 'e2e-placeholder-not-a-key' }
    expect(validatePublicEnv(ci, { requirePresent: true }).ok).toBe(true)
    expect(validatePublicEnv(e2e, { requirePresent: true }).ok).toBe(true)
  })

  it('accepts a legacy anon JWT for a local stack only, and says it did so', () => {
    const local = validatePublicEnv({
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon'),
    })
    expect(local.ok).toBe(true)
    expect(local.notes.map((n) => n.category)).toContain('legacy_anon_jwt_accepted_local_only')
    const hosted = validatePublicEnv({
      VITE_SUPABASE_URL: hostedUrl(),
      VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon'),
    })
    expect(cats(hosted)).toEqual(['VITE_SUPABASE_PUBLISHABLE_KEY:key_legacy_jwt_not_allowed_here'])
  })

  it('treats unset and empty optional variables alike (a copied .env.example has empty ones)', () => {
    const r = validatePublicEnv({
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
      VITE_SUPABASE_PROJECT_REF: '',
      VITE_CF_ANALYTICS_TOKEN: '',
      VITE_APP_URL: 'http://localhost:5173',
    })
    expect(r.ok).toBe(true)
  })
})

describe('validatePublicEnv — the incident and its neighbours are refused', () => {
  it('URL slot holding a secret key (the reported incident)', () => {
    const r = validatePublicEnv({
      VITE_SUPABASE_URL: secretKey(),
      VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey(),
    })
    expect(cats(r)).toEqual(['VITE_SUPABASE_URL:url_is_secret_key_shaped'])
    expect(r.ok).toBe(false)
  })

  it('a secret key smuggled into a VALID URL (query) — the build used to succeed and inline it', () => {
    for (const value of [
      `${hostedUrl()}/?apikey=${secretKey()}`,
      `${hostedUrl()}/#${secretKey()}`,
      `https://${secretKey()}@${REF}.supabase.co`,
    ]) {
      const r = validatePublicEnv({
        VITE_SUPABASE_URL: value,
        VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey(),
      })
      expect(r.ok, 'must refuse').toBe(false)
      expect(cats(r)[0]).toBe('VITE_SUPABASE_URL:url_is_secret_key_shaped')
    }
  })

  it('URL slot holding a publishable key, or any JWT', () => {
    expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: publishableKey() }))).toEqual([
      'VITE_SUPABASE_URL:url_is_publishable_key_shaped',
    ])
    expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: jwt('anon') }))).toEqual([
      'VITE_SUPABASE_URL:url_is_jwt_shaped',
    ])
    expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: jwt('service_role') }))).toEqual([
      'VITE_SUPABASE_URL:url_is_service_role_jwt_shaped',
    ])
  })

  it('userinfo, query, fragment, extra path, port on a hosted origin', () => {
    const expectCat = (value: string, category: string) => {
      expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: value }))).toEqual([
        `VITE_SUPABASE_URL:${category}`,
      ])
    }
    expectCat(`https://user:pw@${REF}.supabase.co`, 'url_has_credentials')
    expectCat(`https://user@${REF}.supabase.co`, 'url_has_credentials')
    expectCat(`${hostedUrl()}/?a=b`, 'url_has_query_or_fragment')
    expectCat(`${hostedUrl()}?`, 'url_has_query_or_fragment')
    expectCat(`${hostedUrl()}#frag`, 'url_has_query_or_fragment')
    expectCat(`${hostedUrl()}/rest/v1`, 'url_has_path')
    expectCat(`https://${REF}.supabase.co:8443`, 'url_host_not_supabase')
  })

  it('empty, missing and whitespace values', () => {
    const missing = validatePublicEnv({}, { requirePresent: true })
    expect(cats(missing)).toEqual([
      'VITE_SUPABASE_URL:missing',
      'VITE_SUPABASE_PUBLISHABLE_KEY:missing',
    ])
    const empty = validatePublicEnv(
      { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' },
      { requirePresent: true },
    )
    expect(cats(empty)).toEqual(cats(missing))
    // Nothing configured is fine for `vite`/Vitest (presence is a build-time requirement).
    expect(validatePublicEnv({}).ok).toBe(true)
    expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: '   ' }))).toEqual([
      'VITE_SUPABASE_URL:value_has_whitespace_or_control',
    ])
    expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: `${hostedUrl()}\n` }))).toEqual([
      'VITE_SUPABASE_URL:value_has_whitespace_or_control',
    ])
  })

  it('http and non-Supabase hosts, including local-looking lookalikes', () => {
    const expectCat = (value: string, category: string) => {
      expect(cats(validatePublicEnv({ VITE_SUPABASE_URL: value }))).toEqual([
        `VITE_SUPABASE_URL:${category}`,
      ])
    }
    expectCat(`http://${REF}.supabase.co`, 'url_not_https')
    expectCat('https://example.com', 'url_host_not_supabase')
    expectCat(`https://${REF}.supabase.co.evil.example`, 'url_host_not_supabase')
    expectCat('https://supabase.co', 'url_host_not_supabase')
    expectCat('https://short.supabase.co', 'url_host_not_supabase')
    expectCat('http://localhost.evil.example', 'url_not_https')
    expectCat('http://127.0.0.1.evil.example', 'url_not_https')
    expectCat('ftp://127.0.0.1', 'url_scheme_not_allowed')
    expectCat('not a url', 'value_has_whitespace_or_control')
    expectCat('notaurl', 'not_a_url')
  })

  it('a service-role key, secret key, URL or gibberish as the FRONTEND key', () => {
    const url = hostedUrl()
    const expectKey = (value: string, category: string, base = url) => {
      expect(
        cats(validatePublicEnv({ VITE_SUPABASE_URL: base, VITE_SUPABASE_PUBLISHABLE_KEY: value })),
      ).toEqual([`VITE_SUPABASE_PUBLISHABLE_KEY:${category}`])
    }
    expectKey(jwt('service_role'), 'key_service_role_jwt')
    expectKey(jwt('service_role'), 'key_service_role_jwt', 'http://127.0.0.1:54321')
    expectKey(secretKey(), 'key_secret_shaped')
    expectKey(hostedUrl(), 'key_is_url')
    expectKey(jwt('authenticated'), 'key_jwt_unverifiable')
    expectKey('eyJhbGciOiJI.eyJzdWIiOiIx.', 'key_unrecognized_shape')
    expectKey('definitely-not-a-key', 'key_unrecognized_shape')
    expectKey('ci-placeholder-not-a-key', 'key_placeholder_not_allowed_here')
    expectKey(`sb_publishable_short`, 'key_unrecognized_shape')
  })

  it('deploy profile refuses a local or placeholder configuration', () => {
    const r = validatePublicEnv(
      {
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
      },
      { requireHosted: true },
    )
    expect(cats(r)).toEqual([
      'VITE_SUPABASE_URL:local_config_not_allowed_in_production',
      'VITE_SUPABASE_PUBLISHABLE_KEY:key_placeholder_not_allowed_here',
    ])
  })

  it('project ref: malformed, or contradicting the URL', () => {
    const base = { VITE_SUPABASE_URL: hostedUrl() }
    expect(cats(validatePublicEnv({ ...base, VITE_SUPABASE_PROJECT_REF: 'nope' }))).toEqual([
      'VITE_SUPABASE_PROJECT_REF:project_ref_malformed',
    ])
    expect(
      cats(validatePublicEnv({ ...base, VITE_SUPABASE_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz' })),
    ).toEqual(['VITE_SUPABASE_PROJECT_REF:project_ref_mismatch'])
    expect(validatePublicEnv({ ...base, VITE_SUPABASE_PROJECT_REF: REF }).ok).toBe(true)
  })

  it('other VITE_ variables: credential-named or secret-valued ones are refused', () => {
    expect(cats(validatePublicEnv({ VITE_STITCH_API_KEY: 'anything' }))).toEqual([
      'VITE_STITCH_API_KEY:sensitive_variable_name',
    ])
    expect(cats(validatePublicEnv({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'x' }))).toEqual([
      'VITE_SUPABASE_SERVICE_ROLE_KEY:sensitive_variable_name',
    ])
    expect(cats(validatePublicEnv({ VITE_SOMETHING: secretKey() }))).toEqual([
      'VITE_SOMETHING:value_secret_key_shaped',
    ])
    expect(cats(validatePublicEnv({ VITE_APP_URL: secretKey() }))).toEqual([
      'VITE_APP_URL:value_secret_key_shaped',
    ])
    expect(cats(validatePublicEnv({ VITE_CF_ANALYTICS_TOKEN: jwt('service_role') }))).toEqual([
      'VITE_CF_ANALYTICS_TOKEN:value_service_role_jwt_shaped',
    ])
    expect(validatePublicEnv({ VITE_SOMETHING_HARMLESS: 'blue' }).ok).toBe(true)
    // An unprintable name is masked rather than echoed.
    const odd = validatePublicEnv({ 'VITE_bad name secret': 'x' })
    expect(odd.problems[0]?.field).toBe('VITE_<unprintable-name>')
  })
})

describe('output contract: no value fragment ever reaches a report or an error', () => {
  const hostile = [
    secretKey(),
    `${hostedUrl()}/?apikey=${secretKey()}`,
    `https://user:${TAIL}@${REF}.supabase.co`,
    jwt('service_role'),
  ]
  it('formatGuardReport and assertPublicEnv carry categories only', () => {
    for (const value of hostile) {
      const env = { VITE_SUPABASE_URL: value, VITE_SUPABASE_PUBLISHABLE_KEY: value }
      const report = formatGuardReport(validatePublicEnv(env, { requirePresent: true })).join('\n')
      expectNoLeak(report, value)
      let message = ''
      try {
        assertPublicEnv(env, { requirePresent: true })
      } catch (error) {
        message = `${String(error)}\n${(error as Error).stack ?? ''}`
      }
      expect(message).not.toBe('')
      expectNoLeak(message, value)
    }
  })

  it('the CLI exits 1 and prints no fragment of the value', () => {
    const cwd = tmp('p160-cli-')
    const script = join(REPO_ROOT, 'scripts', 'check-public-env.mjs')
    for (const value of hostile) {
      const r = runNode(
        [script],
        { VITE_SUPABASE_URL: value, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey() },
        cwd,
      )
      expect(r.status).toBe(1)
      expectNoLeak(`${r.stdout}\n${r.stderr}`, value)
      expect(r.stdout).toContain('VITE_SUPABASE_URL')
    }
  })

  it('the CLI passes a valid synthetic configuration and refuses a placeholder one when hosted', () => {
    const cwd = tmp('p160-cli-ok-')
    const script = join(REPO_ROOT, 'scripts', 'check-public-env.mjs')
    const good = {
      VITE_SUPABASE_URL: hostedUrl(),
      VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey(),
    }
    expect(runNode([script], good, cwd).status).toBe(0)
    expect(runNode([script, '--require-hosted'], good, cwd).status).toBe(0)
    const placeholder = {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
    }
    expect(runNode([script], placeholder, cwd).status).toBe(0)
    expect(runNode([script], { ...placeholder, CF_PAGES: '1' }, cwd).status).toBe(1)
    expect(
      runNode([script], { ...placeholder, PP_REQUIRE_HOSTED_PUBLIC_ENV: '1' }, cwd).status,
    ).toBe(1)
    expect(runNode([script], {}, cwd).status).toBe(1) // nothing set: presence is required to build
  })
})

describe('build abort happens before any artefact is written', () => {
  const viteBin = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

  it('`vite build` with a secret in the URL slot fails and creates no output directory', () => {
    const outDir = join(tmp('p160-build-'), 'out')
    const value = secretKey()
    const r = runNode(
      [viteBin, 'build', '--outDir', outDir],
      { VITE_SUPABASE_URL: value, VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key' },
      REPO_ROOT,
    )
    expect(r.status).not.toBe(0)
    expect(existsSync(outDir)).toBe(false)
    const output = `${r.stdout}\n${r.stderr}`
    expect(output).toContain('url_is_secret_key_shaped')
    expectNoLeak(output, value)
  })

  it('…also when the secret hides inside an otherwise valid URL (previously built fine)', () => {
    const outDir = join(tmp('p160-build2-'), 'out')
    const value = `${hostedUrl()}/?apikey=${secretKey()}`
    const r = runNode(
      [viteBin, 'build', '--outDir', outDir],
      { VITE_SUPABASE_URL: value, VITE_SUPABASE_PUBLISHABLE_KEY: publishableKey() },
      REPO_ROOT,
    )
    expect(r.status).not.toBe(0)
    expect(existsSync(outDir)).toBe(false)
    expectNoLeak(`${r.stdout}\n${r.stderr}`, value)
  })

  it('a Cloudflare Pages build (CF_PAGES=1) refuses a local/placeholder configuration', () => {
    const outDir = join(tmp('p160-build3-'), 'out')
    const r = runNode(
      [viteBin, 'build', '--outDir', outDir],
      {
        CF_PAGES: '1',
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'ci-placeholder-not-a-key',
      },
      REPO_ROOT,
    )
    expect(r.status).not.toBe(0)
    expect(existsSync(outDir)).toBe(false)
    expect(`${r.stdout}\n${r.stderr}`).toContain('local_config_not_allowed_in_production')
  })
})

describe('wiring: every build path reaches the guard', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }

  it('`prebuild` runs the guard first, so it precedes asset staging, tsc and vite', () => {
    expect(pkg.scripts.prebuild?.startsWith('node scripts/check-public-env.mjs && ')).toBe(true)
    expect(pkg.scripts.build).toBe('tsc -b && vite build')
  })

  it('vite.config.ts pins the env prefix and puts the guard plugin first', () => {
    expect((viteConfig as { envPrefix?: unknown }).envPrefix).toBe('VITE_')
    const plugins = ((viteConfig as { plugins?: unknown[] }).plugins ?? []).flat() as {
      name?: string
    }[]
    expect(plugins[0]?.name).toBe('pokeportfolio:public-env-guard')
  })

  it('CI scans dist/ right after the build and before the platform verifier', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const build = ci.indexOf('run: pnpm build')
    const scan = ci.indexOf('node scripts/check-dist-secrets.mjs')
    const verifier = ci.indexOf('node scripts/verify-scanner-platform-build.mjs')
    expect(build).toBeGreaterThan(-1)
    expect(scan).toBeGreaterThan(build)
    expect(verifier).toBeGreaterThan(scan)
  })

  it('any workflow that deploys to Pages first runs both gates in the deploy profile', () => {
    const dir = join(REPO_ROOT, '.github', 'workflows')
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(dir, file), 'utf8')
      const deploy = text.indexOf('wrangler pages deploy')
      if (deploy === -1) continue
      const before = text.slice(0, deploy)
      expect(before, `${file}: build env must select the deploy profile`).toContain(
        'PP_REQUIRE_HOSTED_PUBLIC_ENV',
      )
      expect(before, `${file}: input guard`).toContain('check-public-env.mjs --require-hosted')
      expect(before, `${file}: artefact scan`).toContain('check-dist-secrets.mjs')
    }
  })

  it('src/ names only known public variables and never reads the whole env object', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8')
          for (const m of text.matchAll(/VITE_[A-Z0-9_]+/g)) {
            if (!KNOWN_PUBLIC_VARS.includes(m[0])) offenders.push(`${path}: ${m[0]}`)
          }
          if (/import\.meta\.env(?![.?A-Za-z_])/.test(text)) offenders.push(`${path}: bare env`)
        }
      }
    }
    walk(join(REPO_ROOT, 'src'))
    expect(offenders).toEqual([])
  })
})

describe('resolveRequireHosted / collectPublicEnv', () => {
  it('selects the deploy profile for Cloudflare Pages builds or an explicit opt-in', () => {
    expect(resolveRequireHosted({})).toBe(false)
    expect(resolveRequireHosted({ CF_PAGES: '1' })).toBe(true)
    expect(resolveRequireHosted({ PP_REQUIRE_HOSTED_PUBLIC_ENV: '1' })).toBe(true)
    expect(resolveRequireHosted({ CF_PAGES: '0' })).toBe(false)
  })

  it('process variables override .env file values, and only VITE_ entries are collected', () => {
    const merged = collectPublicEnv(
      { VITE_A: 'file', VITE_B: 'file', OTHER: 'file' },
      { VITE_B: 'process', SUPABASE_SERVICE_ROLE_KEY: 'x', VITE_C: 'process' },
    )
    expect(merged).toEqual({ VITE_A: 'file', VITE_B: 'process', VITE_C: 'process' })
  })
})

describe('findSecretShapes and scripts/check-dist-secrets.mjs', () => {
  it('matches a key SHAPE, not the bare prefix (supabase-js carries the prefix itself)', () => {
    expect(findSecretShapes(`if(k.startsWith("sb_secret_"))throw 1`)).toEqual({
      secretKey: false,
      serviceRoleJwt: false,
    })
    expect(findSecretShapes(`x="${secretKey()}"`).secretKey).toBe(true)
    expect(findSecretShapes(`x="${jwt('service_role')}"`).serviceRoleJwt).toBe(true)
    expect(findSecretShapes(`x="${jwt('anon')}"`)).toEqual({
      secretKey: false,
      serviceRoleJwt: false,
    })
  })

  const script = join(REPO_ROOT, 'scripts', 'check-dist-secrets.mjs')
  const completeDist = (dir: string, extra: Record<string, string> = {}) => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    const files: Record<string, string> = {
      'index.html': '<!doctype html>',
      'build-meta.json': '{}',
      _headers: '/*',
      'assets/app.js': 'if(k.startsWith("sb_secret_"))throw 1',
      ...extra,
    }
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
  }

  it('passes a complete, clean artefact (including the bare supabase-js prefix)', () => {
    const dir = tmp('p160-dist-ok-')
    completeDist(dir)
    const r = runNode([script, dir], {}, REPO_ROOT)
    expect(r.status).toBe(0)
  })

  it('fails on a secret-shaped string, naming the file and category only', () => {
    const dir = tmp('p160-dist-bad-')
    const value = secretKey()
    completeDist(dir, { 'assets/leak.js': `var u="${value}"` })
    const r = runNode([script, dir], {}, REPO_ROOT)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('assets/leak.js: secret_key_shaped_present')
    expectNoLeak(`${r.stdout}\n${r.stderr}`, value)
    const dir2 = tmp('p160-dist-bad2-')
    completeDist(dir2, { 'assets/leak2.js': `var u="${jwt('service_role')}"` })
    const r2 = runNode([script, dir2], {}, REPO_ROOT)
    expect(r2.status).toBe(1)
    expect(r2.stdout).toContain('service_role_jwt_present')
  })

  it('fails closed on a partial artefact, an empty directory and a missing directory', () => {
    const partial = tmp('p160-dist-partial-')
    // What an aborted build used to leave behind: public/ copied, no index.html.
    completeDist(partial)
    rmSync(join(partial, 'index.html'))
    const r = runNode([script, partial], {}, REPO_ROOT)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('index.html: artifact_incomplete')
    expect(runNode([script, tmp('p160-dist-empty-')], {}, REPO_ROOT).status).toBe(1)
    expect(runNode([script, join(partial, 'does-not-exist')], {}, REPO_ROOT).status).toBe(1)
  })
})
