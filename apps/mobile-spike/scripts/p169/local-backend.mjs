#!/usr/bin/env node
/**
 * Isolated local Supabase stack for P169 (native catalog search + Price Check). LOCAL ONLY.
 *
 * Differs from the P158/P166 stack (scripts/local-backend.mjs, reused here unchanged through its
 * exported `transformConfig`) in three ways:
 *   - its own project id and ports (559xx, or 560xx for the DB-106 candidate stack), so it never
 *     touches the P158/P166 stack or any other worktree's stack;
 *   - the edge runtime is ON, serving exactly two functions and nothing else:
 *       search-prices           = the P165 CANDIDATE function, read from git object 3d03eec
 *       search-prices-released  = the RELEASED function, read from git object d8682e0
 *     (ingest-*, sync-catalog, fetch-fx-rate and redeem-invitation are NOT copied, so nothing can
 *     be dispatched to them);
 *   - the one outbound dependency of those functions, the TCGdex base URL, is redirected to a
 *     local, synthetic, controlled mock (scripts/p169/mock-tcgdex.mjs). No real provider is called.
 *
 * Every copied function file is taken from a git OBJECT (not from a worktree that could be dirty),
 * its original SHA-256 is recorded, and each substitution must apply exactly once or the script
 * refuses (fail closed). The substitutions are: the TCGdex base URL, and (released only) the
 * `../_shared/` import path, so the released function keeps its own released `_shared` modules.
 * The manifest is written to <workdir>/functions-manifest.json.
 *
 *   node scripts/p169/local-backend.mjs prepare [--db106]
 *   node scripts/p169/local-backend.mjs start   [--db106]
 *   node scripts/p169/local-backend.mjs write-env [--db106]
 *   node scripts/p169/local-backend.mjs stop    [--db106]
 *
 * --db106 builds the same stack from the P165 candidate's 106 migrations (git object 3d03eec) in a
 * separate workdir/project, to check that the reads this feature makes are unchanged on DB 106.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { transformConfig } from '../local-backend.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..', '..')
const repoRoot = resolve(appRoot, '..', '..')

export const RELEASED_SHA = 'd8682e047b757f63673a63ac8185a4806d68cb98'
export const CANDIDATE_SHA = '3d03eec7a24756c635857bc7320b51e17cc8572c'
// Not 55999: the P166 backend tests use 127.0.0.1:55999 as their deliberately DEAD URL.
export const MOCK_TCGDEX_PORT = 55979
const TCGDEX_BASE_LITERAL = "const BASE_URL = 'https://api.tcgdex.net/v2'"

/**
 * Named stacks, each with its own project id, ports and mock port so parallel sessions never share
 * a database. p169 / p169-db106 are P169's; p170 is the integrated candidate's (API 55471, mock
 * 55461: below the Windows-reserved ranges seen on this machine, clear of P167's 550xx).
 */
const STACKS = {
  p169: {
    projectId: 'pokeportfolio-p169',
    portShift: 600,
    dir: 'p169',
    mockPort: MOCK_TCGDEX_PORT,
  },
  'p169-db106': {
    projectId: 'pokeportfolio-p169-db106',
    portShift: 700,
    dir: 'p169-db106',
    mockPort: MOCK_TCGDEX_PORT,
  },
  p170: { projectId: 'pokeportfolio-p170', portShift: 150, dir: 'p170', mockPort: 55461 },
  // The recovered integrated candidate (P173): API 55421, mock 55411. It also carries the
  // migrations the worktree adds on top of the released 104 (`withWorktreeMigrations`).
  p173: {
    projectId: 'pokeportfolio-p173',
    portShift: 100,
    dir: 'p173',
    mockPort: 55411,
    withWorktreeMigrations: true,
  },
  // P177: native financial-write runtime verification. API 55521, mock 55491 (clear of every port
  // above). Carries the worktree's 107 migrations (P173's + P175's two P144 migrations) on top of
  // the released 104, same mechanism as P173.
  p177: {
    projectId: 'pokeportfolio-p177-app',
    portShift: 200,
    dir: 'p177',
    mockPort: 55491,
    withWorktreeMigrations: true,
  },
  // P178: dark-first native UI device verification. API 55571, mock 55495 (clear of every port
  // above). Same migration set as P177 (this worktree adds none of its own).
  p178: {
    projectId: 'pokeportfolio-p178-app',
    portShift: 250,
    dir: 'p178',
    mockPort: 55495,
    withWorktreeMigrations: true,
  },
  // P179: dark-first native UI finish-gate review, own stack/AVD/ports (independent of P178's,
  // which stays intact for reference). API 55621, mock 55496 (clear of every port above). Same
  // migration set as P177/P178 (this worktree adds none of its own).
  p179: {
    projectId: 'pokeportfolio-p179-app',
    portShift: 300,
    dir: 'p179',
    mockPort: 55496,
    withWorktreeMigrations: true,
  },
  // P180: native financial reliability (FX contract, pending-write journal). API 55671, mock 55497
  // (clear of every port above). Same migration set as P177/P178/P179 (this worktree adds none of
  // its own — 107 local migrations).
  p180: {
    projectId: 'pokeportfolio-p180-app',
    portShift: 350,
    dir: 'p180',
    mockPort: 55497,
    withWorktreeMigrations: true,
  },
  // P181: native device-matrix/accessibility/performance gate, own stack/AVD/ports (independent of
  // P180's, which stays intact for reference). API 55721, mock 55498 (clear of every port above).
  // Same migration set as P177-P180 (this worktree adds none of its own).
  p181: {
    projectId: 'pokeportfolio-p181-app',
    portShift: 400,
    dir: 'p181',
    mockPort: 55498,
    withWorktreeMigrations: true,
  },
  // P184: native release-candidate scanner hardening, own stack/AVD/ports. API 55771, mock 55499
  // (clear of every port above). Same 107 local migrations as P177-P182 (this worktree adds none).
  p184: {
    projectId: 'pokeportfolio-p184-app',
    portShift: 450,
    dir: 'p184',
    mockPort: 55499,
    withWorktreeMigrations: true,
  },
  // P185: native RC closure, own stack/AVD/ports. API 55821, mock 55500 (clear of every port
  // above). Same 107 local migrations as P177-P184 (this worktree adds none).
  // P185 DB-suite stack: the same migrations plus the real redeem-invitation function, so the
  // root `pnpm test:db` runs with a working invitation path (the app stack serves only search-prices).
  p185db: {
    projectId: 'pokeportfolio-p185-db',
    portShift: 550,
    dir: 'p185db',
    mockPort: 55501,
    withWorktreeMigrations: true,
  },
  p185: {
    projectId: 'pokeportfolio-p185-app',
    portShift: 500,
    dir: 'p185',
    mockPort: 55500,
    withWorktreeMigrations: true,
  },
  // P186: packaging/performance phase, own stacks. App API 55971, DB-suite API 56071, mocks 55502/55503
  // (clear of every port above; same 107 migrations as P185 - this phase adds none).
  p186db: {
    projectId: 'pokeportfolio-p186-db',
    portShift: 750,
    dir: 'p186db',
    mockPort: 55503,
    withWorktreeMigrations: true,
  },
  p186: {
    projectId: 'pokeportfolio-p186-app',
    portShift: 650,
    dir: 'p186',
    mockPort: 55502,
    withWorktreeMigrations: true,
  },
}

/**
 * A stack name outside the registry is accepted when the caller names its port shift (`--port-shift=N`
 * or P185_PORT_SHIFT / P186_PORT_SHIFT), so a parallel instance needs no edit to this file
 * (scripts/p186/instance.cjs). The registry entries keep their fixed ports.
 */
function registryEntry(name, argv) {
  const known = STACKS[name]
  if (known !== undefined) return known
  const shift =
    argv.find((a) => a.startsWith('--port-shift='))?.slice('--port-shift='.length) ??
    process.env.P185_PORT_SHIFT ??
    process.env.P186_PORT_SHIFT
  if (shift === undefined)
    throw new Error(
      `unknown stack "${name}"; expected one of ${Object.keys(STACKS).join(', ')}, or pass --port-shift=N / set P186_PORT_SHIFT for a new instance`,
    )
  return createRequire(import.meta.url)('../p186/instance.cjs').dynamicStack(name, shift)
}

export function stackOf(argv) {
  const named = argv.find((a) => a.startsWith('--stack='))?.slice('--stack='.length)
  const db106 = argv.includes('--db106')
  const name = named ?? (db106 ? 'p169-db106' : 'p169')
  const s = registryEntry(name, argv)
  return {
    name,
    db106: name === 'p169-db106',
    projectId: s.projectId,
    workdir: join(appRoot, '.local-backend', s.dir),
    apiPort: 54321 + 1000 + s.portShift,
    dbContainer: `supabase_db_${s.projectId}`,
    portShift: s.portShift,
    mockPort: s.mockPort,
    withWorktreeMigrations: s.withWorktreeMigrations === true,
  }
}

function git(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

function blob(sha, path) {
  return git(['show', `${sha}:${path}`])
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Replaces `from` with `to` exactly `expected` times, or throws. */
function substitute(text, from, to, expected, label) {
  const count = text.split(from).length - 1
  if (count !== expected) {
    throw new Error(
      `${label}: expected ${expected} occurrence(s) of ${JSON.stringify(from)}, found ${count}`,
    )
  }
  return text.split(from).join(to)
}

function p169Config(source, stack) {
  // P180 §15: `transformConfig` now takes its identity as an explicit argument (see its own header
  // comment in ../local-backend.mjs) instead of closing over that module's `resolveStackIdentity()`
  // — which used to read the SHARED, gitignored .local-backend/stack.json as a fallback, so a named
  // stack build here could silently inherit whatever the BASE P158 stack's last `start` happened to
  // record (P177's own disclosed finding). `portOffset: 1000` and `enableEdgeRuntime: false`
  // reproduce this function's own PRE-EXISTING behaviour exactly (the two lines immediately below
  // already re-derive project_id and ports from `stack` itself, unconditionally; edge_runtime is
  // force-enabled a few lines down regardless of this flag) — nothing about this stack's OWN output
  // changes, only where its inputs come from.
  let config = transformConfig(source, {
    projectId: stack.projectId,
    portOffset: 1000,
    enableEdgeRuntime: false,
  })
  config = config.replace(/^project_id = ".*"$/m, `project_id = "${stack.projectId}"`)
  config = config.replace(
    /^(\s*(?:port|shadow_port)\s*=\s*)(\d+)(.*)$/gm,
    (line, pre, port, post) => {
      const n = Number(port)
      return n >= 55300 && n <= 55399 ? `${pre}${n + stack.portShift}${post}` : line
    },
  )
  config = config.replaceAll('http://127.0.0.1:55321', `http://127.0.0.1:${stack.apiPort}`)
  // Re-enable ONLY the edge runtime (transformConfig disables it for the P158 stack).
  const lines = config.split('\n')
  let section = ''
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^\[([^\]]+)\]\s*$/.exec(lines[i])
    if (header) section = header[1]
    if (section === 'edge_runtime' && /^\s*enabled\s*=/.test(lines[i])) lines[i] = 'enabled = true'
    if (section === 'edge_runtime' && /^\s*inspector_port\s*=/.test(lines[i])) {
      lines[i] = `inspector_port = ${8083 + stack.portShift}`
    }
  }
  config = lines.join('\n')
  if (
    config.includes('pokeportfolio-dev.pages.dev') ||
    /[a-z0-9-]\.supabase\.co(?![a-z])/i.test(config)
  ) {
    throw new Error('generated config references a hosted origin; refusing')
  }
  return config
}

function writeFunctions(target, mockPort) {
  const MOCK_BASE_URL = `http://host.docker.internal:${mockPort}/v2`
  const manifest = { mockBaseUrl: MOCK_BASE_URL, files: [] }
  const put = (sha, srcPath, destPath, transform) => {
    const original = blob(sha, srcPath)
    const { text, substitutions } = transform(original)
    const dest = join(target, 'functions', destPath)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, text)
    manifest.files.push({
      source: `${sha.slice(0, 12)}:${srcPath}`,
      dest: `functions/${destPath}`,
      originalSha256: sha256(original),
      servedSha256: sha256(text),
      substitutions,
    })
  }
  const same = (text) => ({ text, substitutions: [] })
  const mockUrl = (label) => (text) => ({
    text: substitute(text, TCGDEX_BASE_LITERAL, `const BASE_URL = '${MOCK_BASE_URL}'`, 1, label),
    substitutions: ['TCGdex BASE_URL -> local synthetic mock'],
  })
  const releasedImports = (text) => ({
    text: substitute(text, "from '../_shared/", "from '../_shared_released/", 2, 'released index'),
    substitutions: ["import path '../_shared/' -> '../_shared_released/'"],
  })

  // Candidate (P165 / P153 observations[]).
  put(CANDIDATE_SHA, 'supabase/functions/search-prices/index.ts', 'search-prices/index.ts', same)
  put(
    CANDIDATE_SHA,
    'supabase/functions/_shared/tcgdex.ts',
    '_shared/tcgdex.ts',
    mockUrl('candidate tcgdex'),
  )
  put(CANDIDATE_SHA, 'supabase/functions/_shared/service-key.ts', '_shared/service-key.ts', same)
  put(
    CANDIDATE_SHA,
    'supabase/functions/_shared/price-observations.ts',
    '_shared/price-observations.ts',
    same,
  )
  // Released (DB 104 main): headline only.
  put(
    RELEASED_SHA,
    'supabase/functions/search-prices/index.ts',
    'search-prices-released/index.ts',
    releasedImports,
  )
  put(
    RELEASED_SHA,
    'supabase/functions/_shared/tcgdex.ts',
    '_shared_released/tcgdex.ts',
    mockUrl('released tcgdex'),
  )
  put(
    RELEASED_SHA,
    'supabase/functions/_shared/service-key.ts',
    '_shared_released/service-key.ts',
    same,
  )
  return manifest
}

function writeMigrations(target, stack) {
  const dir = join(target, 'migrations')
  mkdirSync(dir, { recursive: true })
  const sha = stack.db106 ? CANDIDATE_SHA : RELEASED_SHA
  const names = git(['ls-tree', '--name-only', `${sha}:supabase/migrations`])
    .split('\n')
    .filter((n) => n.endsWith('.sql'))
  for (const name of names) writeFileSync(join(dir, name), blob(sha, `supabase/migrations/${name}`))
  // Migrations this worktree adds to the released set (read from the checkout, recorded by hash so
  // the run says exactly which SQL it applied). Never edits or replaces a released file.
  const added = []
  if (stack.withWorktreeMigrations) {
    const own = join(repoRoot, 'supabase', 'migrations')
    for (const name of readdirSync(own).filter((n) => n.endsWith('.sql'))) {
      if (names.includes(name)) continue
      const text = readFileSync(join(own, name), 'utf8')
      writeFileSync(join(dir, name), text)
      added.push({ name, sha256: sha256(text) })
    }
  }
  const seedNames = git(['ls-tree', '--name-only', `${sha}:supabase/seed`])
    .split('\n')
    .filter((n) => n.endsWith('.sql'))
  mkdirSync(join(target, 'seed'), { recursive: true })
  for (const name of seedNames)
    writeFileSync(join(target, 'seed', name), blob(sha, `supabase/seed/${name}`))
  return {
    migrationSha: sha,
    migrationCount: names.length + added.length,
    addedMigrations: added,
  }
}

export function prepare(stack) {
  const target = join(stack.workdir, 'supabase')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const baseConfig = blob(RELEASED_SHA, 'supabase/config.toml')
  writeFileSync(join(target, 'config.toml'), p169Config(baseConfig, stack))
  const migrations = writeMigrations(target, stack)
  const manifest = {
    ...writeFunctions(target, stack.mockPort),
    ...migrations,
    projectId: stack.projectId,
  }
  writeFileSync(join(stack.workdir, 'functions-manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

function cli(stack, args, options = {}) {
  return spawnSync(
    'pnpm',
    ['--dir', repoRoot, 'exec', 'supabase', ...args, '--workdir', stack.workdir],
    {
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  )
}

export function readLocalEnv(stack) {
  const r = cli(stack, ['status', '-o', 'env'], { capture: true })
  if (r.status !== 0) throw new Error('supabase status failed; is the P169 stack running?')
  const text = (r.stdout ?? '').trim()
  const jsonStart = text.indexOf('{')
  if (jsonStart !== -1) return JSON.parse(text.slice(jsonStart))
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  const stack = stackOf(process.argv.slice(3))
  if (command === 'prepare') {
    const m = prepare(stack)
    console.log(
      `prepared ${stack.workdir} (${m.migrationCount} migrations from ${m.migrationSha.slice(0, 7)})`,
    )
  } else if (command === 'start') {
    const m = prepare(stack)
    console.log(
      `${m.migrationCount} migrations from ${m.migrationSha.slice(0, 7)}; functions from git objects`,
    )
    const r = cli(stack, [
      'start',
      '-x',
      'logflare,vector,studio,mailpit,imgproxy,storage-api,realtime,postgres-meta,supavisor',
    ])
    process.exit(r.status ?? 1)
  } else if (command === 'write-env') {
    const env = readLocalEnv(stack)
    if (env.API_URL !== `http://127.0.0.1:${stack.apiPort}`) {
      throw new Error(`unexpected API_URL ${env.API_URL}; refusing`)
    }
    writeFileSync(
      join(stack.workdir, 'public-env.json'),
      JSON.stringify(
        {
          apiUrl: env.API_URL,
          publishableKey: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
          dbContainer: stack.dbContainer,
          projectId: stack.projectId,
        },
        null,
        2,
      ),
    )
    console.log(`wrote ${join(stack.workdir, 'public-env.json')} (public values only)`)
  } else if (command === 'stop') {
    const r = cli(stack, ['stop', '--no-backup'])
    process.exit(r.status ?? 1)
  } else if (command === 'manifest') {
    console.log(readFileSync(join(stack.workdir, 'functions-manifest.json'), 'utf8'))
  } else {
    console.error('usage: local-backend.mjs prepare|start|write-env|stop|manifest [--db106]')
    process.exit(2)
  }
}
