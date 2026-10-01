#!/usr/bin/env node
/**
 * Runs the root `pnpm test:db` (or one file / test-name filter) against the P186 DB-suite stack
 * (`P185_STACK=p186db node scripts/p185/backend.mjs start`, which serves the real redeem-invitation
 * function). The stack's keys are read from `supabase status` into the child's environment only;
 * they are never printed or written.
 *
 *   node scripts/p186/run-db-suite.mjs                       full suite
 *   node scripts/p186/run-db-suite.mjs tests/db/m12_dashboard_snapshots.test.ts -t "monthly spend"
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLocalEnv, stackOf } from '../p169/local-backend.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const stack = stackOf(['--stack=p186db'])
const env = readLocalEnv(stack)
const anon = env.ANON_KEY
const service = env.SERVICE_ROLE_KEY
if (!anon || !service || !env.DB_URL)
  throw new Error('stack keys missing; is the p186db stack running?')
if (env.API_URL !== `http://127.0.0.1:${String(stack.apiPort)}`)
  throw new Error('unexpected API_URL')
const r = spawnSync('pnpm', ['--dir', repoRoot, 'test:db', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    SUPABASE_URL: env.API_URL,
    SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
    DB_URL: env.DB_URL,
  },
})
process.exit(r.status ?? 1)
