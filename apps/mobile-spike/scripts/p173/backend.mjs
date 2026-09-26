#!/usr/bin/env node
/**
 * The ONE isolated local Supabase stack of the P170 integrated candidate (LOCAL ONLY, synthetic data).
 *
 * It is P169's stack builder (DB 104 from the released main, the CANDIDATE and the RELEASED
 * `search-prices` functions from git objects, the TCGdex base URL redirected to a local synthetic
 * mock) under its own project id and ports, seeded with BOTH tracks' fixtures so one database serves
 * the whole journey:
 *   - P167's users (a large collection incl. 2^53+1 / 2^58+1 values, a manual zero, an unpriced
 *     holding; user B with a small disjoint one),
 *   - P169's catalog (same-name cards, several printings, a huge price, a zero, provider failures,
 *     Japanese and bulk cards) and fx rates.
 * The P167 tooling and tests look for `.local-backend/{stack.json,public-env.json,fixture.json}`;
 * this script writes those next to P169's `.local-backend/p170/` so both suites run unchanged.
 *
 *   node scripts/p170/backend.mjs start        prepare + `supabase start` (containers of THIS project only)
 *   node scripts/p170/backend.mjs seed         both seeds + the EU/US pricing preference of the P167 users
 *   node scripts/p170/backend.mjs write-env    public connection values for the two test suites
 *   node scripts/p170/backend.mjs stop         stop THIS project only and verify no container is left
 *   node scripts/p170/backend.mjs status       containers and listeners of this project
 *
 * The mock provider is a separate process: `node scripts/p169/mock-tcgdex.mjs --stack=p170`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { prepare, readLocalEnv, stackOf } from '../p169/local-backend.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..', '..')
const repoRoot = resolve(appRoot, '..', '..')
const rootDir = join(appRoot, '.local-backend')
const stack = stackOf(['--stack=p170'])
const PORT_OFFSET = 1000 + stack.portShift // what the P167 tooling calls SPIKE_BACKEND_PORT_OFFSET

const cli = (args, capture = false) =>
  spawnSync('pnpm', ['--dir', repoRoot, 'exec', 'supabase', ...args, '--workdir', stack.workdir], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })

function tsx(script, args = [], env = {}) {
  const r = spawnSync('pnpm', ['--dir', repoRoot, 'exec', 'tsx', script, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  })
  if (r.status !== 0) throw new Error(`${script} failed (${String(r.status)})`)
}

function psql(sql) {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      stack.dbContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

function containers() {
  const r = spawnSync(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=com.supabase.cli.project=${stack.projectId}`,
      '--format',
      '{{.Names}} {{.Status}}',
    ],
    { encoding: 'utf8' },
  )
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split(/\r?\n/)
}

const command = process.argv[2]
if (command === 'start') {
  const m = prepare(stack)
  console.log(
    `${m.migrationCount} migrations from ${m.migrationSha.slice(0, 7)}; functions from git objects`,
  )
  // The P167 tooling (status, seed, backend tests) finds the stack through these files.
  mkdirSync(join(rootDir, 'supabase'), { recursive: true })
  copyFileSync(
    join(stack.workdir, 'supabase', 'config.toml'),
    join(rootDir, 'supabase', 'config.toml'),
  )
  writeFileSync(
    join(rootDir, 'stack.json'),
    JSON.stringify({ projectId: stack.projectId, portOffset: PORT_OFFSET }, null, 2),
  )
  const r = cli([
    'start',
    '-x',
    'logflare,vector,studio,mailpit,imgproxy,storage-api,realtime,postgres-meta,supavisor',
  ])
  process.exit(r.status ?? 1)
} else if (command === 'seed') {
  const env = {
    SPIKE_BACKEND_PROJECT_ID: stack.projectId,
    SPIKE_BACKEND_PORT_OFFSET: String(PORT_OFFSET),
  }
  tsx('apps/mobile-spike/scripts/seed-local-backend.mts', [], env)
  tsx('apps/mobile-spike/scripts/p169/seed.mts', ['--stack=p170'], env)
  // The P167 users carry the device journey: A prices from Cardmarket (EU), B from TCGplayer (US),
  // so a value of A under B (or B's under A) is visible by provider as well as by amount.
  const fx = JSON.parse(readFileSync(join(rootDir, 'fixture.json'), 'utf8'))
  psql(`
update public.profiles set use_eu_pricing = true where id = '${fx.users.a.id}'::uuid;
update public.profiles set use_eu_pricing = false where id = '${fx.users.b.id}'::uuid;
select cron.alter_job(jobid, active := false) from cron.job where jobname in ('m9-ingest-prices','m9-ingest-fx');
`)
  console.log('seeded both tracks; P167 users A (EU pricing) / B (US pricing)')
} else if (command === 'write-env') {
  const env = readLocalEnv(stack)
  if (env.API_URL !== `http://127.0.0.1:${String(stack.apiPort)}`) {
    throw new Error(`unexpected API_URL ${String(env.API_URL)}; refusing`)
  }
  const pub = {
    apiUrl: env.API_URL,
    publishableKey: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
    dbContainer: stack.dbContainer,
    projectId: stack.projectId,
    apiPort: stack.apiPort,
  }
  mkdirSync(stack.workdir, { recursive: true })
  writeFileSync(join(stack.workdir, 'public-env.json'), JSON.stringify(pub, null, 2))
  writeFileSync(join(rootDir, 'public-env.json'), JSON.stringify(pub, null, 2))
  console.log('wrote public-env.json (public values only) for the P167 and P169 suites')
} else if (command === 'stop') {
  const r = cli(['stop', '--no-backup'])
  const left = containers()
  console.log(
    left.length === 0
      ? 'no container of this project remains'
      : `STILL PRESENT:\n${left.join('\n')}`,
  )
  process.exit(r.status === 0 && left.length === 0 ? 0 : 1)
} else if (command === 'status') {
  console.log(containers().join('\n') || '(no container of this project)')
} else {
  console.error('usage: backend.mjs start|seed|write-env|stop|status')
  process.exit(2)
}
