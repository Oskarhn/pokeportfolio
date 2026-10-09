import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Test-side driver for scripts/p201/edge-harness: runs the REAL code of one Edge Function under
 * Deno with a scripted provider and a recording database stand-in, and returns what it did.
 * Shared by the P201 function-level suites (sync-catalog, ingest-prices, search-prices, FX).
 */

export const HARNESS_DIR = resolve(__dirname, '../../scripts/p201/edge-harness')
export const FUNCTIONS_DIR = resolve(__dirname, '../../supabase/functions')

export const hasDeno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
if (!hasDeno) {
  console.warn(
    'P201: `deno` is not installed — the suites that execute the real Edge Function code are SKIPPED.',
  )
}

export type ProviderStep =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | { throw: 'network' }
  | { hang: true }

export interface DbOp {
  table: string
  op: string
  payload: unknown
  filters: [string, string, unknown][]
  failed: boolean
}

export interface Scenario {
  function: 'sync-catalog' | 'ingest-prices' | 'ingest-fx' | 'fetch-fx-rate' | 'search-prices'
  method?: 'POST' | 'GET'
  env?: Record<string, string>
  headers?: Record<string, string>
  request?: unknown
  /** URL path (after /v2) → scripted answers, one per call, last repeating. */
  provider?: Record<string, ProviderStep[]>
  policy?: Record<string, number>
  db?: {
    rows?: Record<string, unknown[]>
    single?: Record<string, unknown>
    counts?: Record<string, number>
    rpc?: Record<string, { data?: unknown; error?: { message: string; code?: string } }>
    fail?: Record<string, { message: string; code?: string }>
    failFirst?: Record<string, number>
  }
}

export interface RunResult {
  status: number
  text: string
  json: Record<string, unknown>
  providerRequests: string[]
  sleeps: number[]
  ops: DbOp[]
  logs: string[]
}

export function runFunction(scenario: Scenario): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'p201-edge-'))
  const scenarioFile = join(dir, 'scenario.json')
  writeFileSync(scenarioFile, JSON.stringify(scenario))
  try {
    const run = spawnSync(
      'deno',
      [
        'run',
        '--no-lock',
        '--no-check',
        `--import-map=${join(HARNESS_DIR, 'import_map.json')}`,
        '--allow-read',
        '--allow-env',
        join(HARNESS_DIR, 'harness.mjs'),
        FUNCTIONS_DIR,
        scenarioFile,
      ],
      { encoding: 'utf8', timeout: 90_000 },
    )
    if (run.status !== 0) throw new Error(`the deno harness failed:\n${run.stderr}`)
    const out = JSON.parse(run.stdout) as Omit<RunResult, 'json'>
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(out.text) as Record<string, unknown>
    } catch {
      // a non-JSON body is reported through `text`
    }
    return { ...out, json }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function opsOn(result: RunResult, table: string, op?: string): DbOp[] {
  return result.ops.filter((o) => o.table === table && (op === undefined || o.op === op))
}
