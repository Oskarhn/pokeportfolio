#!/usr/bin/env node
/**
 * Isolated local Supabase stack for the P158 native spike (LOCAL ONLY).
 *
 * Why a generated workdir instead of editing supabase/config.toml: the repository's own stack
 * uses project id `pokeportfolio` and ports 543xx, and other worktrees run stacks of their own.
 * This script derives a *separate* config (own project id, ports +1000, no studio/realtime/
 * storage/analytics/edge runtime, and no reference to the Production origin) into a gitignored
 * directory and points the CLI at it with --workdir. Nothing under supabase/ is modified, and
 * only this project's containers/volumes are ever started or stopped.
 *
 *   node scripts/local-backend.mjs prepare   generate .local-backend/ (config + migrations + seed)
 *   node scripts/local-backend.mjs start     prepare + `supabase start`
 *   node scripts/local-backend.mjs env       print the public connection values as KEY=value lines
 *   node scripts/local-backend.mjs write-env write them to .local-backend/public-env.json (tests)
 *   node scripts/local-backend.mjs stop      stop THIS stack only
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const repoRoot = resolve(appRoot, '..', '..')
const workdir = join(appRoot, '.local-backend')
export const PROJECT_ID = 'pokeportfolio-p158-mobile'
export const DB_CONTAINER = `supabase_db_${PROJECT_ID}`
const PORT_OFFSET = 1000
const LOCAL_SITE_URL = `http://127.0.0.1:${54321 + PORT_OFFSET}`

/** Sections whose `enabled` flag is forced off: this spike needs Postgres, GoTrue and PostgREST. */
const DISABLED_SECTIONS = new Set([
  'studio',
  'realtime',
  'local_smtp',
  'storage',
  'storage.s3_protocol',
  'storage.vector',
  'edge_runtime',
  'analytics',
  'experimental.pgdelta',
])

export function transformConfig(source) {
  const out = []
  let section = ''
  let droppingFunctions = false
  for (const raw of source.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*$/.exec(raw)
    if (header) {
      section = header[1]
      droppingFunctions = section.startsWith('functions.')
      if (droppingFunctions) continue
      out.push(raw)
      continue
    }
    if (droppingFunctions) continue
    let line = raw
    if (/^\s*project_id\s*=/.test(line)) line = `project_id = "${PROJECT_ID}"`
    const portMatch = /^(\s*(?:port|shadow_port)\s*=\s*)(\d+)(.*)$/.exec(line)
    if (portMatch && Number(portMatch[2]) >= 54300 && Number(portMatch[2]) <= 54399) {
      line = `${portMatch[1]}${Number(portMatch[2]) + PORT_OFFSET}${portMatch[3]}`
    }
    if (section === 'auth' && /^\s*site_url\s*=/.test(line)) line = `site_url = "${LOCAL_SITE_URL}"`
    if (section === 'auth' && /^\s*additional_redirect_urls\s*=/.test(line)) {
      line = 'additional_redirect_urls = []'
    }
    if (DISABLED_SECTIONS.has(section) && /^\s*enabled\s*=/.test(line)) line = 'enabled = false'
    out.push(line)
  }
  return out.join('\n')
}

export function prepare() {
  // Only the generated `supabase/` directory is rebuilt; fixture.json / public-env.json beside it
  // (written by the seed script and `write-env`) must survive a restart.
  const target = join(workdir, 'supabase')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const config = transformConfig(readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8'))
  if (config.includes('pokeportfolio-dev.pages.dev')) {
    throw new Error('generated config still references the Production origin; refusing')
  }
  writeFileSync(join(target, 'config.toml'), config)
  cpSync(join(repoRoot, 'supabase', 'migrations'), join(target, 'migrations'), { recursive: true })
  if (existsSync(join(repoRoot, 'supabase', 'seed'))) {
    cpSync(join(repoRoot, 'supabase', 'seed'), join(target, 'seed'), { recursive: true })
  }
  return target
}

function cli(args, options = {}) {
  return spawnSync('pnpm', ['--dir', repoRoot, 'exec', 'supabase', ...args, '--workdir', workdir], {
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

/** Parses `supabase status -o env` (KEY="value" lines, or JSON on some CLI versions). */
export function readLocalEnv() {
  const r = cli(['status', '-o', 'env'], { capture: true })
  if (r.status !== 0) throw new Error('supabase status failed; is the local stack running?')
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

const command = process.argv[2]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (command === 'prepare') {
    prepare()
    console.log(`prepared ${workdir}`)
  } else if (command === 'start') {
    prepare()
    // Only the containers this spike needs; everything else is disabled in the generated config.
    const r = cli([
      'start',
      '-x',
      'logflare,vector,studio,mailpit,imgproxy,edge-runtime,storage-api,realtime,postgres-meta,supavisor',
    ])
    process.exit(r.status ?? 1)
  } else if (command === 'env') {
    // Public connection values only (URL + publishable key); never the service-role or JWT secret.
    const env = readLocalEnv()
    console.log(`API_URL=${env.API_URL}`)
    console.log(`PUBLISHABLE_KEY=${env.PUBLISHABLE_KEY ?? env.ANON_KEY}`)
  } else if (command === 'write-env') {
    // Public values only, into the gitignored workdir, for the backend test project.
    const env = readLocalEnv()
    writeFileSync(
      join(workdir, 'public-env.json'),
      JSON.stringify(
        {
          apiUrl: env.API_URL,
          publishableKey: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
          dbContainer: DB_CONTAINER,
        },
        null,
        2,
      ),
    )
    console.log('wrote public-env.json')
  } else if (command === 'stop') {
    const r = cli(['stop', '--no-backup'])
    process.exit(r.status ?? 1)
  } else {
    console.error('usage: local-backend.mjs prepare|start|env|write-env|stop')
    process.exit(2)
  }
}
