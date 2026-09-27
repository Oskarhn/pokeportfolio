#!/usr/bin/env node
/**
 * The ONE isolated local Supabase stack of the P177 native financial-runtime verification pass
 * (LOCAL ONLY, synthetic data). Same mechanism as scripts/p173/backend.mjs (P169's stack builder:
 * DB from the released main + this worktree's added migrations, read-only search-prices functions
 * from git objects), under the P177 stack entry (own project id, own ports, own mock port — see
 * scripts/p169/local-backend.mjs's STACKS.p177). Seeded with the SAME P167/P169 fixtures P173 used
 * (so the same users/holdings/catalog exist to drive the write screens against), plus this phase's
 * own EU/US pricing preference for users A/B.
 *
 *   node scripts/p177/backend.mjs start        prepare + `supabase start` (containers of THIS project only)
 *   node scripts/p177/backend.mjs seed         both seeds + the EU/US pricing preference of the P167 users
 *   node scripts/p177/backend.mjs write-env    public connection values for the device driver
 *   node scripts/p177/backend.mjs stop         stop THIS project only and verify no container is left
 *   node scripts/p177/backend.mjs status       containers and listeners of this project
 *
 * The mock provider is a separate process: `node scripts/p169/mock-tcgdex.mjs --stack=p177`.
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
const stack = stackOf(['--stack=p177'])
const PORT_OFFSET = 1000 + stack.portShift

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
    ['exec', '-i', stack.dbContainer, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: sql, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  )
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`)
  return r.stdout.trim()
}

function containers() {
  const r = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `label=com.supabase.cli.project=${stack.projectId}`, '--format', '{{.Names}} {{.Status}}'],
    { encoding: 'utf8' },
  )
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split(/\r?\n/)
}

const command = process.argv[2]
if (command === 'start') {
  const m = prepare(stack)
  console.log(`${m.migrationCount} migrations from ${m.migrationSha.slice(0, 7)}; functions from git objects`)
  mkdirSync(join(rootDir, 'supabase'), { recursive: true })
  copyFileSync(join(stack.workdir, 'supabase', 'config.toml'), join(rootDir, 'supabase', 'config.toml'))
  writeFileSync(
    join(rootDir, 'stack.json'),
    JSON.stringify({ projectId: stack.projectId, portOffset: PORT_OFFSET }, null, 2),
  )
  const r = cli(['start', '-x', 'logflare,vector,studio,mailpit,imgproxy,storage-api,realtime,postgres-meta,supavisor'])
  process.exit(r.status ?? 1)
} else if (command === 'seed') {
  const env = { SPIKE_BACKEND_PROJECT_ID: stack.projectId, SPIKE_BACKEND_PORT_OFFSET: String(PORT_OFFSET) }
  tsx('apps/mobile-spike/scripts/seed-local-backend.mts', [], env)
  tsx('apps/mobile-spike/scripts/p169/seed.mts', ['--stack=p177'], env)
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
    // The URL baked into the device build: scripts/p177/capture-proxy.mjs in front of the API.
    appUrl: 'http://127.0.0.1:55501',
  }
  mkdirSync(stack.workdir, { recursive: true })
  writeFileSync(join(stack.workdir, 'public-env.json'), JSON.stringify(pub, null, 2))
  writeFileSync(join(rootDir, 'public-env.json'), JSON.stringify(pub, null, 2))
  console.log('wrote public-env.json (public values only) for the P177 driver')
} else if (command === 'stop') {
  const r = cli(['stop', '--no-backup'])
  const left = containers()
  console.log(left.length === 0 ? 'no container of this project remains' : `STILL PRESENT:\n${left.join('\n')}`)
  process.exit(r.status === 0 && left.length === 0 ? 0 : 1)
} else if (command === 'status') {
  console.log(containers().join('\n') || '(no container of this project)')
} else {
  console.error('usage: backend.mjs start|seed|write-env|stop|status')
  process.exit(2)
}
