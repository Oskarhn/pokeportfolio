#!/usr/bin/env node
// Runs the jest `backend` project (real isolated local Supabase, synthetic data) serially. Serial on
// purpose: the tests share synthetic users and one Postgres, and a parallel run once produced a
// cold-start failure that was never reproduced (see docs/mobile/TEST_MATRIX.md).
import { spawnSync } from 'node:child_process'

const r = spawnSync(
  'pnpm',
  ['exec', 'jest', '--selectProjects', 'backend', '--runInBand', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, P158_LOCAL_BACKEND: '1' },
  },
)
process.exit(r.status ?? 1)
