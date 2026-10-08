import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P197D — the browser-reachable, JWT-verified Edge Functions must answer a CORS preflight.
 *
 * `supabase.functions.invoke` from the deployed web app is cross-origin with an `Authorization`
 * header, so the browser sends `OPTIONS` first. `search-prices` and `fetch-fx-rate` used to answer
 * 405 with no `Access-Control-Allow-*`: the browser then never sent the real request ("Failed to
 * fetch"), and `searchPrices` — which deliberately swallows failures — rendered "—" for every
 * Search/Card Detail market price. Observed against the deployed functions from the Production
 * origin on 2026-10-08. This runs the functions' REAL code under Deno (scripts/p197d/cors-harness.mjs).
 * Skipped, loudly, on a machine without `deno`.
 */

const HARNESS = resolve(__dirname, '../../scripts/p197d/cors-harness.mjs')
const FUNCTIONS_DIR = resolve(__dirname, '../../supabase/functions')
const ORIGIN = 'https://app.example.test'
const OTHER_ORIGIN = 'https://evil.example.test'

const hasDeno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
const withDeno = hasDeno ? describe : describe.skip
if (!hasDeno) {
  console.warn('P197D: `deno` is not installed — the Edge Function CORS tests are SKIPPED.')
}

interface Answer {
  status: number
  allowOrigin: string | null
  allowHeaders: string | null
  allowMethods: string | null
  vary: string | null
  body: string
}
interface Probe {
  preflight: Answer
  preflightDisallowed: Answer
  unauthorized: Answer
  unauthorizedDisallowed: Answer
}

function probe(slug: string): Probe {
  const run = spawnSync(
    'deno',
    [
      'run',
      '--no-lock',
      '--allow-read',
      '--allow-env',
      HARNESS,
      FUNCTIONS_DIR,
      slug,
      ORIGIN,
      OTHER_ORIGIN,
    ],
    { encoding: 'utf8', timeout: 90_000 },
  )
  if (run.status !== 0) throw new Error(`the deno harness failed:\n${run.stderr}`)
  return JSON.parse(run.stdout) as Probe
}

withDeno.each(['search-prices', 'fetch-fx-rate'])('%s — CORS (P197D)', (slug) => {
  const result = probe(slug)

  it('answers the preflight 204 and allows the app origin with the headers supabase-js sends', () => {
    expect(result.preflight.status).toBe(204)
    expect(result.preflight.allowOrigin).toBe(ORIGIN)
    expect(result.preflight.allowMethods).toBe('POST, OPTIONS')
    for (const header of ['authorization', 'apikey', 'content-type', 'x-client-info']) {
      expect(result.preflight.allowHeaders).toContain(header)
    }
    expect(result.preflight.vary).toBe('Origin')
  })

  it('never allows an origin outside ALLOWED_ORIGINS', () => {
    expect(result.preflightDisallowed.allowOrigin).toBeNull()
    expect(result.unauthorizedDisallowed.allowOrigin).toBeNull()
  })

  it('carries the CORS headers on error responses too, so the browser can read the status', () => {
    expect(result.unauthorized.status).toBe(401)
    expect(result.unauthorized.allowOrigin).toBe(ORIGIN)
    expect(result.unauthorized.vary).toBe('Origin')
  })
})
